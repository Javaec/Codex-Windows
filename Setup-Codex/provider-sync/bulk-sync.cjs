'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { createZstdDecompress } = require('node:zlib');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const {
  countProviders, createRewriteState, listFilesRecursive, resolveCodexHome, resolveStateDb, rewriteSessionRecord,
} = require('./provider-sync.cjs');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.jsonl(?:\.zst)?$)/i;
const BLOCK_SIZE = 1024 * 1024;

function rolloutId(file) {
  const match = path.basename(file).match(UUID);
  if (!match) throw new Error(`Rollout filename has no UUID: ${file}`);
  return match[0];
}

function resolveRollout(file) {
  const plain = file.replace(/\.zst$/, '');
  return [plain, `${plain}.zst`].find(candidate => fs.existsSync(candidate)) || '';
}

function openState(file, readOnly = true) {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout=10000');
  return db;
}

function assertUnloaded(home, rows) {
  for (const { id } of rows) {
    const file = path.join(home, 'thread-writer-locks', `${id}.lock`);
    if (!fs.existsSync(file)) continue;
    const fd = fs.openSync(file, 'r');
    try {
      // Windows permits opening a locked file, but rejects this byte read.
      fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } catch (error) {
      throw new Error(`Unload chat ${id} before switching its provider. ${error.message}`);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function readInventory(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const stateDbPath = resolveStateDb(codexHome, options.stateDbPath);
  const db = openState(stateDbPath);
  try {
    const rows = db.prepare('SELECT id, model_provider, rollout_path FROM threads').all();
    return { codexHome, stateDbPath, rows };
  } finally {
    db.close();
  }
}

function fastStatus(options) {
  const inventory = readInventory(options);
  let compressedRollouts = 0;
  let missingRollouts = 0;
  for (const row of inventory.rows) {
    const file = resolveRollout(row.rollout_path);
    if (!file) missingRollouts += 1;
    if (file.endsWith('.zst')) compressedRollouts += 1;
  }
  return {
    codexHome: inventory.codexHome, stateDbPath: inventory.stateDbPath,
    sqliteThreads: inventory.rows.length,
    databaseProviders: countProviders(inventory.rows.map(row => row.model_provider)),
    compressedRollouts, missingRollouts,
  };
}

// Read decoded bytes so lineage cutoffs work identically for plain and zstd files.
async function scanTail(file, endByteOffset = Infinity) {
  const before = fs.statSync(file);
  const input = fs.createReadStream(file, { highWaterMark: BLOCK_SIZE });
  const stream = file.endsWith('.zst') ? input.pipe(createZstdDecompress()) : input;
  if (stream !== input) input.on('error', error => stream.destroy(error));
  let fragments = [];
  let offset = 0;
  let lastOrdinal = -1;
  let meta;
  let checkpoint;
  let tail = [];
  const consumeLine = (buffer, newline) => {
    const line = buffer.toString('utf8');
    if (line.trim()) {
      const prefix = line.slice(0, 250);
      const type = /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
      const ordinal = /"ordinal"\s*:\s*(\d+)/.exec(prefix);
      lastOrdinal = ordinal ? Number(ordinal[1]) : lastOrdinal + 1;
      if (!meta) {
        meta = JSON.parse(line);
        if (meta.type !== 'session_meta') throw new Error(`Missing session_meta: ${file}`);
      } else if (type === 'compacted') {
        checkpoint = { offset, ordinal: lastOrdinal };
        tail = [line];
      } else {
        tail.push(line);
      }
    }
    offset += buffer.length + (newline ? 1 : 0);
  };
  const consume = chunk => {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      const line = chunk.subarray(start, end);
      if (fragments.length) {
        fragments.push(line);
        consumeLine(Buffer.concat(fragments), true);
        fragments = [];
      } else {
        consumeLine(line, true);
      }
      start = end + 1;
    }
    if (start < chunk.length) fragments.push(chunk.subarray(start));
  };
  try {
    let decodedBytes = 0;
    for await (const chunk of stream) {
      const part = chunk.subarray(0, Math.min(chunk.length, endByteOffset - decodedBytes));
      decodedBytes += part.length;
      consume(part);
      if (decodedBytes === endByteOffset) break;
    }
    if (fragments.length) consumeLine(Buffer.concat(fragments), false);
    if (Number.isFinite(endByteOffset) && offset !== endByteOffset) {
      throw new Error(`Incomplete ancestor rollout: ${file}, expected ${endByteOffset} bytes, read ${offset}`);
    }
    if (!meta) throw new Error(`Empty rollout: ${file}`);
    const after = fs.statSync(file);
    if (!Number.isFinite(endByteOffset) && (before.size !== after.size || before.mtimeMs !== after.mtimeMs)) {
      throw new Error(`Rollout changed during migration: ${file}`);
    }
    return { meta, checkpoint, tail };
  } finally {
    stream.destroy();
    input.destroy();
  }
}

async function prepareContinuation(job, catalog, toProvider) {
  let file = job.sourcePath;
  let endByteOffset = Infinity;
  let head;
  let historyBase;
  const suffixes = [];
  const visited = new Set();
  while (true) {
    const id = rolloutId(file);
    if (visited.has(id)) throw new Error(`Cyclic history_base: ${id}`);
    visited.add(id);
    const current = await scanTail(file, endByteOffset);
    if (!head) head = current.meta;
    if (head.payload.id !== job.id && head.payload.session_id !== job.id) {
      throw new Error(`Rollout belongs to another chat: ${job.sourcePath}`);
    }
    suffixes.push(current.tail);
    if (current.checkpoint) {
      const payload = JSON.parse(current.tail[0]).payload;
      if (!Array.isArray(payload.replacement_history)) {
        throw new Error(`Compaction has no replacement_history: ${file}`);
      }
      historyBase = {
        thread_id: id, end_ordinal_exclusive: current.checkpoint.ordinal,
        end_byte_offset: current.checkpoint.offset,
      };
      break;
    }
    const base = current.meta.payload.history_base;
    if (!base) break;
    file = catalog[base.thread_id];
    if (!file) throw new Error(`Missing ancestor ${base.thread_id} for chat ${job.id}`);
    endByteOffset = base.end_byte_offset;
  }
  const changes = createRewriteState();
  let ordinal = historyBase?.end_ordinal_exclusive || 0;
  head = { ...head, ordinal: ordinal++, payload: { ...head.payload, model_provider: toProvider, history_mode: 'paginated' } };
  if (historyBase) head.payload.history_base = historyBase;
  else delete head.payload.history_base;
  const fd = fs.openSync(job.targetPath, 'wx');
  let writtenBytes;
  let buffer = [];
  let bufferedChars = 0;
  const flush = () => {
    if (!buffer.length) return;
    fs.writeFileSync(fd, buffer.join(''));
    buffer = [];
    bufferedChars = 0;
  };
  const write = line => {
    const text = `${line}\n`;
    bufferedChars += text.length;
    buffer.push(text);
    if (bufferedChars >= BLOCK_SIZE / 2) flush();
  };
  try {
    write(JSON.stringify(head));
    for (const tail of suffixes.reverse()) {
      for (const line of tail) {
        const parsed = JSON.parse(line);
        if (typeof parsed?.type !== 'string') throw new Error(`Rollout record has no type: ${job.sourcePath}`);
        const record = rewriteSessionRecord(parsed, toProvider, true, changes);
        if (record === null) continue;
        record.ordinal = ordinal++;
        if (record.type === 'compacted' && record.payload.window_number == null) record.payload.window_number = 0;
        write(JSON.stringify(record));
      }
    }
    flush();
    fs.fsyncSync(fd);
    writtenBytes = fs.fstatSync(fd).size;
  } finally {
    fs.closeSync(fd);
  }
  return { id: job.id, writtenBytes, ...changes };
}

async function prepareJobs(jobs, catalog, toProvider, onProgress) {
  let next = 0;
  const results = [];
  const workers = [];
  try {
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
      const worker = new Worker(__filename, {
        workerData: { catalog, toProvider }, resourceLimits: { maxOldGenerationSizeMb: 768 },
      });
      workers.push(worker);
      while (next < jobs.length) {
        const job = jobs[next++];
        const result = await new Promise((resolve, reject) => {
          const message = value => { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); };
          const error = value => { cleanup(); reject(value); };
          const exit = code => error(new Error(`Provider worker exited unexpectedly (${code})`));
          const cleanup = () => {
            worker.off('message', message); worker.off('error', error); worker.off('exit', exit);
          };
          worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
          worker.postMessage(job);
        });
        results.push(result);
        onProgress?.(results.length, jobs.length);
      }
    }));
    return results;
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

async function syncAllProviders(options) {
  if (!options.toProvider?.trim()) throw new Error('A target provider is required.');
  const start = performance.now();
  const cpuStart = process.cpuUsage();
  const { codexHome, stateDbPath, rows } = readInventory(options);
  const from = (options.fromProviders || []).flatMap(value => value.split(',')).filter(Boolean);
  const selected = rows.filter(row => row.model_provider !== options.toProvider
    && (!from.length || from.includes(row.model_provider)));
  const jobs = selected.map(row => {
    const sourcePath = resolveRollout(row.rollout_path);
    const base = sourcePath.replace(/\.jsonl(?:\.zst)?$/, '').replace(/_[0-9a-f-]{36}$/i, '');
    const stat = sourcePath ? fs.statSync(sourcePath) : null;
    return { ...row, sourcePath, sourceSize: stat?.size, sourceMtimeMs: stat?.mtimeMs,
      targetPath: sourcePath ? `${base}_${randomUUID()}.jsonl` : row.rollout_path };
  });
  const available = jobs.filter(job => job.sourcePath);
  const report = {
    mode: options.apply ? 'apply' : 'dry-run', strategy: 'immutable-continuation',
    codexHome, stateDbPath, toProvider: options.toProvider,
    fromProviders: [...new Set(selected.map(row => row.model_provider))],
    sqliteChanges: selected.length, jsonlChanges: available.length,
    compressedRollouts: available.filter(job => job.sourcePath.endsWith('.zst')).length,
    sourceBytes: available.reduce((sum, job) => sum + job.sourceSize, 0),
    missingRollouts: jobs.filter(job => !job.sourcePath).map(job => job.id),
  };
  if (!options.apply || !selected.length) return report;
  assertUnloaded(codexHome, selected);
  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, 'backups', 'provider-sync'));
  const backupDir = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-bulk`);
  fs.mkdirSync(backupDir, { recursive: true });
  report.backupDir = backupDir;
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ ...report, jobs }, null, 2));
  const db = openState(stateDbPath, false);
  let committed = false;
  try {
    await backup(db, path.join(backupDir, 'state_5.sqlite'));
    const catalog = {};
    if (available.length) {
      for (const root of ['sessions', 'archived_sessions']) {
        for (const file of listFilesRecursive(path.join(codexHome, root))) {
          if (UUID.test(file)) catalog[rolloutId(file)] = resolveRollout(file);
        }
      }
    }
    const results = await prepareJobs(available, catalog, options.toProvider, options.onProgress);
    assertUnloaded(codexHome, selected);
    for (const job of available) {
      const stat = fs.statSync(job.sourcePath);
      if (stat.size !== job.sourceSize || stat.mtimeMs !== job.sourceMtimeMs) {
        throw new Error(`Rollout changed during migration: ${job.id}`);
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const update = db.prepare('UPDATE threads SET model_provider=?, rollout_path=? WHERE id=? AND model_provider=? AND rollout_path=?');
      for (const job of jobs) {
        if (update.run(options.toProvider, job.targetPath, job.id, job.model_provider, job.rollout_path).changes !== 1) {
          throw new Error(`Chat changed during migration: ${job.id}`);
        }
      }
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const readRow = db.prepare('SELECT model_provider, rollout_path FROM threads WHERE id=?');
    for (const job of jobs) {
      const row = readRow.get(job.id);
      if (row.model_provider !== options.toProvider || row.rollout_path !== job.targetPath) {
        throw new Error(`Provider verification failed: ${job.id}`);
      }
    }
    for (const key of ['writtenBytes', 'sanitizedReasoningItems', 'removedResponseItems', 'convertedCompactionItems', 'removedCompactionItems']) {
      report[key] = results.reduce((sum, result) => sum + result[key], 0);
    }
    report.elapsedMs = Math.round(performance.now() - start);
    const cpu = process.cpuUsage(cpuStart);
    report.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
    report.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
    report.verified = true;
    fs.writeFileSync(path.join(backupDir, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    db.close();
    if (!committed) {
      for (const job of available) fs.rmSync(job.targetPath, { force: true });
    }
  }
}

if (!isMainThread) {
  parentPort.on('message', async job => {
    try {
      parentPort.postMessage(await prepareContinuation(job, workerData.catalog, workerData.toProvider));
    } catch (error) {
      parentPort.postMessage({ error: `${job.id}: ${error.message}` });
    }
  });
}

module.exports = { fastStatus, syncAllProviders };
