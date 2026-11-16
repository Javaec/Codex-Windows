'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const STATE_DB_FILENAME = 'state_5.sqlite';
const SESSION_ROOTS = ['sessions', 'archived_sessions'];
const OPAQUE_ENCRYPTED_CONTENT = /^[A-Za-z0-9_+=\/-]+$/u;
const JSONL_READ_BUFFER_SIZE = 1024 * 1024;
const JSONL_WRITE_BUFFER_SIZE = 1024 * 1024;
const MAX_SCAN_ATTEMPTS = 3;
const HISTORY_TABLES = ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state'];
const REPLAY_HISTORY_KEYS = ['replacement_history', 'guardian_history'];

function fail(message) {
  throw new Error(message);
}

function resolveCodexHome(explicitPath) {
  const value = explicitPath || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.resolve(value);
}

function readConfigSqliteHome(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) {
    return '';
  }

  const configText = fs.readFileSync(configPath, 'utf8');
  const match = /^\s*sqlite_home\s*=\s*["']([^"']+)["']\s*$/m.exec(configText);
  return match ? path.resolve(codexHome, match[1]) : '';
}

function resolveStateDb(codexHome, explicitPath) {
  if (explicitPath) {
    const stateDbPath = path.resolve(explicitPath);
    if (!fs.existsSync(stateDbPath)) {
      fail(`State database does not exist: ${stateDbPath}`);
    }
    return stateDbPath;
  }

  const configuredHome = readConfigSqliteHome(codexHome);
  const candidates = [
    configuredHome ? path.join(configuredHome, STATE_DB_FILENAME) : '',
    path.join(codexHome, STATE_DB_FILENAME),
    path.join(codexHome, 'sqlite', STATE_DB_FILENAME),
  ].filter(Boolean);
  const stateDbPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!stateDbPath) {
    fail(`Could not find ${STATE_DB_FILENAME} under ${codexHome}. Checked:\n${candidates.join('\n')}`);
  }
  return stateDbPath;
}

function listFilesRecursive(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const result = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        result.push(entryPath);
      }
    }
  }
  return result.sort();
}

function hasVisibleText(text) {
  return /[^\s\u200B\u200C\u200D\uFEFF]/u.test(text);
}

function reasoningText(payload) {
  const parts = [];
  for (const key of ['summary', 'content']) {
    for (const item of payload[key] || []) {
      if (typeof item?.text === 'string' && hasVisibleText(item.text)) {
        parts.push(item.text);
      }
    }
  }
  return parts.join('\n\n');
}

function isRepairableReasoningItem(payload) {
  if (!payload || payload.type !== 'reasoning' || typeof payload.id !== 'string' || !payload.id) {
    return false;
  }
  if (typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    return false;
  }
  return reasoningText(payload) === '';
}

function isOpaqueEncryptedContent(value) {
  return typeof value === 'string'
    && value.length > 0
    && OPAQUE_ENCRYPTED_CONTENT.test(value);
}

function makeVisibleReplayMessage(text, source) {
  const turnId = source.internal_chat_message_metadata_passthrough?.turn_id;
  const message = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  if (turnId) {
    message.internal_chat_message_metadata_passthrough = { turn_id: turnId };
  }
  return message;
}

function rewriteResponseItem(payload, changes, repairReplay) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (repairReplay && payload.type === 'reasoning') {
    const text = reasoningText(payload);
    if (!text) {
      changes.removedResponseItems += 1;
      return null;
    }
    // Summary-only reasoning still breaks Rustponses previous_response_id replay.
    changes.sanitizedReasoningItems += 1;
    return makeVisibleReplayMessage(text, payload);
  }

  if (isRepairableReasoningItem(payload)) {
    changes.removedResponseItems += 1;
    return null;
  }

  if (repairReplay && payload.type === 'compaction' && typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    if (isOpaqueEncryptedContent(payload.encrypted_content)) {
      changes.removedCompactionItems += 1;
      return null;
    }
    changes.convertedCompactionItems += 1;
    return makeVisibleReplayMessage(payload.encrypted_content, payload);
  }

  return payload;
}

function collectReplayPayloadStats(payload, stats) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  if (payload.type === 'reasoning') {
    stats.reasoningItems += 1;
  }
  if (typeof payload.encrypted_content !== 'string' || payload.encrypted_content.length === 0) {
    return;
  }
  if (payload.type === 'reasoning') {
    stats.encryptedReasoningItems += 1;
  } else if (payload.type === 'compaction') {
    stats.encryptedCompactionItems += 1;
    if (isOpaqueEncryptedContent(payload.encrypted_content)) {
      stats.opaqueCompactionItems += 1;
    } else {
      stats.plaintextCompactionItems += 1;
    }
  }
}

function collectReplayStats(record, stats) {
  if (record?.type === 'response_item') {
    collectReplayPayloadStats(record.payload, stats);
  }
  if (record?.type === 'compacted') {
    for (const key of REPLAY_HISTORY_KEYS) {
      for (const item of record.payload?.[key] || []) {
        collectReplayPayloadStats(item, stats);
      }
    }
  }
}

function processJsonlLinesSync(fileDescriptor, callback) {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(JSONL_READ_BUFFER_SIZE);
  let pending = [];

  const consume = (chunk, final = false) => {
    let start = 0;
    let newlineIndex = chunk.indexOf('\n', start);
    while (newlineIndex >= 0) {
      let line = chunk.slice(start, newlineIndex);
      if (pending.length > 0) {
        pending.push(line);
        line = pending.join('');
        pending = [];
      }
      callback(line, true);
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) {
      pending.push(chunk.slice(start));
    }
    if (final && pending.length > 0) {
      callback(pending.join(''), false);
      pending = [];
    }
  };

  let bytesRead;
  while ((bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, null)) > 0) {
    consume(decoder.write(buffer.subarray(0, bytesRead)));
  }
  consume(decoder.end(), true);
}

function forEachJsonlLineSync(filePath, callback) {
  const fileDescriptor = fs.openSync(filePath, 'r');
  try {
    processJsonlLinesSync(fileDescriptor, callback);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function createSessionAnalysis() {
  return {
    providers: [],
    providerSet: new Set(),
    firstMeta: null,
    malformedResponseItems: 0,
    reasoningItems: 0,
    encryptedReasoningItems: 0,
    encryptedCompactionItems: 0,
    opaqueCompactionItems: 0,
    plaintextCompactionItems: 0,
  };
}

function analyzeSessionLine(line, analysis) {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!normalizedLine.trim()) {
    return;
  }
  let record;
  try {
    record = JSON.parse(normalizedLine);
  } catch {
    return;
  }
  if (record?.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    analysis.firstMeta ||= record;
    const provider = typeof record.payload.model_provider === 'string' ? record.payload.model_provider : '';
    if (provider && !analysis.providerSet.has(provider)) {
      analysis.providerSet.add(provider);
      analysis.providers.push(provider);
    }
  }
  if (record?.type === 'response_item' && isRepairableReasoningItem(record.payload)) {
    analysis.malformedResponseItems += 1;
  }
  collectReplayStats(record, analysis);
}

function inspectSessionFile(filePath, codexHome) {
  let analysis;
  let fileStat;
  for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
    const initialStat = fs.statSync(filePath);
    const currentAnalysis = createSessionAnalysis();
    forEachJsonlLineSync(filePath, (line) => analyzeSessionLine(line, currentAnalysis));
    const currentStat = fs.statSync(filePath);
    if (currentStat.size === initialStat.size && currentStat.mtimeMs === initialStat.mtimeMs) {
      analysis = currentAnalysis;
      fileStat = currentStat;
      break;
    }
  }
  if (!analysis || !fileStat) {
    throw new Error(`Session changed while scanning: ${filePath}`);
  }
  const metaRecord = analysis.firstMeta;
  if (!metaRecord) {
    return { filePath, error: 'session_meta record not found' };
  }

  const payload = metaRecord.payload;
  const id = typeof payload.id === 'string' ? payload.id : '';
  if (!id) {
    return { filePath, error: 'session_meta.payload.id is missing' };
  }

  const provider = typeof payload.model_provider === 'string' ? payload.model_provider : '';
  const relativePath = path.relative(codexHome, filePath);
  return {
    filePath,
    relativePath,
    id,
    rolloutId: path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/iu)?.[1] || id,
    provider,
    providers: analysis.providers,
    malformedResponseItems: analysis.malformedResponseItems,
    encryptedReasoningItems: analysis.encryptedReasoningItems,
    encryptedCompactionItems: analysis.encryptedCompactionItems,
    encryptedReplayItems: analysis.encryptedReasoningItems + analysis.encryptedCompactionItems,
    replayRepairItems: analysis.reasoningItems + analysis.encryptedCompactionItems,
    opaqueCompactionItems: analysis.opaqueCompactionItems,
    plaintextCompactionItems: analysis.plaintextCompactionItems,
    historyStartOrdinal: payload.history_base?.end_ordinal_exclusive || 0,
    bytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

function inspectSessionFiles(filePaths, codexHome) {
  const entries = [];
  const errors = [];
  for (const filePath of filePaths) {
    try {
      const entry = inspectSessionFile(filePath, codexHome);
      if (entry.error) {
        errors.push(entry);
      } else {
        entries.push(entry);
      }
    } catch (error) {
      errors.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entries, errors };
}

function scanSessions(codexHome, sessionId = '', dbRows = []) {
  const indexed = dbRows.find((row) => row.id === sessionId);
  if (indexed && fs.existsSync(indexed.rolloutPath)) {
    if (indexed.rolloutPath.endsWith('.jsonl.zst')) {
      return { entries: [], errors: [], unsupported: [indexed.rolloutPath] };
    }
    const inspected = inspectSessionFiles([indexed.rolloutPath], codexHome);
    if (inspected.entries.some((entry) => entry.id === sessionId) || inspected.errors.length > 0) {
      return { ...inspected, unsupported: [] };
    }
  }
  const unsupported = [];
  const rolloutFiles = [];
  for (const rootName of SESSION_ROOTS) {
    const rootPath = path.join(codexHome, rootName);
    for (const filePath of listFilesRecursive(rootPath)) {
      if (filePath.endsWith('.jsonl.zst') && (!sessionId || path.basename(filePath).includes(sessionId))) {
        unsupported.push(filePath);
        continue;
      }
      if (!filePath.endsWith('.jsonl') || !path.basename(filePath).startsWith('rollout-')) {
        continue;
      }
      rolloutFiles.push(filePath);
    }
  }

  const matchingFiles = sessionId
    ? rolloutFiles.filter((filePath) => path.basename(filePath).includes(sessionId))
    : rolloutFiles;
  const initialFiles = sessionId && matchingFiles.length === 0 ? rolloutFiles : matchingFiles;
  const inspected = inspectSessionFiles(initialFiles, codexHome);
  if (sessionId && matchingFiles.length > 0 && !inspected.entries.some((entry) => entry.id === sessionId)) {
    const matchingFileSet = new Set(matchingFiles);
    const fallbackFiles = rolloutFiles.filter((filePath) => !matchingFileSet.has(filePath));
    const fallback = inspectSessionFiles(fallbackFiles, codexHome);
    inspected.entries.length = 0;
    inspected.entries.push(...fallback.entries.filter((entry) => entry.id === sessionId));
    inspected.errors.push(...fallback.errors);
  }
  return { entries: inspected.entries.filter((entry) => !sessionId || entry.id === sessionId), errors: inspected.errors, unsupported };
}

function openStateDb(stateDbPath, readOnly) {
  return new DatabaseSync(stateDbPath, { readOnly });
}

function readStateRows(stateDbPath, sessionId = '') {
  const db = openStateDb(stateDbPath, true);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
    if (!table) {
      fail(`State database has no threads table: ${stateDbPath}`);
    }
    const columns = db.prepare('PRAGMA table_info(threads)').all().map((row) => row.name);
    for (const required of ['id', 'model_provider']) {
      if (!columns.includes(required)) {
        fail(`threads table is missing required column ${required}: ${stateDbPath}`);
      }
    }
    const hasRolloutPath = columns.includes('rollout_path');
    const select = hasRolloutPath
      ? 'SELECT id, model_provider, rollout_path FROM threads'
      : 'SELECT id, model_provider, NULL AS rollout_path FROM threads';
    const query = sessionId ? `${select} WHERE id = ?` : select;
    const rows = sessionId ? db.prepare(query).all(sessionId) : db.prepare(query).all();
    return rows.map((row) => ({
      id: String(row.id),
      provider: typeof row.model_provider === 'string' ? row.model_provider : '',
      rolloutPath: row.rollout_path == null ? '' : String(row.rollout_path),
    }));
  } finally {
    db.close();
  }
}

function countProviders(values) {
  const counts = new Map();
  for (const value of values) {
    const key = value || '(missing)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function scanInventory({ codexHome, stateDbPath, sessionId = '' }) {
  const dbRows = readStateRows(stateDbPath, sessionId);
  const sessions = scanSessions(codexHome, sessionId, dbRows);
  const historyDbPath = path.join(path.dirname(stateDbPath), 'thread_history_1.sqlite');
  return {
    codexHome,
    stateDbPath,
    historyDbPath: fs.existsSync(historyDbPath) ? historyDbPath : '',
    sessions: sessions.entries,
    scanErrors: sessions.errors,
    unsupported: sessions.unsupported,
    dbRows,
    sessionProviders: countProviders(sessions.entries.map((entry) => entry.provider)),
    databaseProviders: countProviders(dbRows.map((row) => row.provider)),
  };
}

function normalizeProviders(providers) {
  const values = Array.isArray(providers) ? providers : [providers];
  const result = [...new Set(values.flatMap((value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)))];
  if (result.length === 0) {
    fail('At least one source provider is required.');
  }
  return result;
}

function buildPlan(inventory, { fromProviders, toProvider, sessionId }) {
  const sources = normalizeProviders(fromProviders);
  const target = String(toProvider || '').trim();
  if (!target) {
    fail('Target provider is required.');
  }
  if (sources.includes(target)) {
    fail(`Target provider must differ from source providers: ${target}`);
  }

  const sessionMatches = inventory.sessions.filter((entry) =>
    (!sessionId || entry.id === sessionId) && sources.some((source) => entry.providers.includes(source)));
  const dbMatches = inventory.dbRows.filter((row) =>
    (!sessionId || row.id === sessionId) && sources.includes(row.provider));
  if (sessionId && sessionMatches.length === 0 && dbMatches.length === 0) {
    fail(`Session was not found with source provider ${sources.join(', ')}: ${sessionId}`);
  }
  return {
    fromProviders: sources,
    toProvider: target,
    sanitizeEncrypted: true,
    sessionId: sessionId || '',
    sessionFiles: sessionMatches,
    dbRows: dbMatches,
  };
}

function buildRepairPlan(inventory, { sessionId, repairEncrypted }) {
  const matchingSession = inventory.sessions.some((entry) => !sessionId || entry.id === sessionId);
  const sessionFiles = inventory.sessions.filter((entry) =>
    (!sessionId || entry.id === sessionId)
      && (entry.malformedResponseItems > 0 || (repairEncrypted && entry.replayRepairItems > 0)));
  if (sessionId && !matchingSession) {
    fail(`Session was not found: ${sessionId}`);
  }
  return {
    repairOnly: true,
    repairEncrypted: Boolean(repairEncrypted),
    sanitizeEncrypted: Boolean(repairEncrypted),
    fromProviders: [],
    toProvider: '',
    sessionId: sessionId || '',
    sessionFiles,
    dbRows: [],
  };
}

function formatJsonLine(record, originalLine) {
  const leading = originalLine.match(/^\s*/)[0];
  return `${leading}${JSON.stringify(record)}${originalLine.endsWith('\r') ? '\r' : ''}`;
}

function createRewriteState() {
  return {
    providerUpdates: 0,
    removedResponseItems: 0,
    sanitizedReasoningItems: 0,
    convertedCompactionItems: 0,
    removedCompactionItems: 0,
    sawMeta: false,
  };
}

function rewriteSessionLine(original, toProvider, sanitizeEncrypted, changes) {
  const line = original.endsWith('\r') ? original.slice(0, -1) : original;
  if (!line.trim()) {
    return original;
  }

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return original;
  }

  let recordChanged = false;
  if (record?.type === 'response_item') {
    const rewritten = rewriteResponseItem(record.payload, changes, sanitizeEncrypted);
    if (rewritten !== record.payload) {
      if (rewritten === null) return null;
      record.payload = rewritten;
      recordChanged = true;
    }
  }
  if (sanitizeEncrypted && record?.type === 'compacted') {
    for (const historyKey of REPLAY_HISTORY_KEYS) {
      const history = record.payload?.[historyKey];
      if (!Array.isArray(history)) continue;
      const replacementHistory = [];
      const replacementMetadata = [];
      const metadataKey = `${historyKey}_metadata`;
      const metadata = record.payload[metadataKey];
      if (Array.isArray(metadata) && metadata.length !== history.length) {
        fail('Compaction history and metadata have different lengths.');
      }
      let replacementChanged = false;
      for (const [index, item] of history.entries()) {
        const rewritten = rewriteResponseItem(item, changes, true);
        if (rewritten !== item) {
          replacementChanged = true;
          if (rewritten === null) continue;
        }
        replacementHistory.push(rewritten);
        if (Array.isArray(metadata)) replacementMetadata.push(metadata[index]);
      }
      if (replacementChanged) {
        record.payload[historyKey] = replacementHistory;
        if (Array.isArray(metadata)) record.payload[metadataKey] = replacementMetadata;
        recordChanged = true;
      }
    }
  }
  if (record?.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    changes.sawMeta = true;
    if (toProvider && record.payload.model_provider !== toProvider) {
      record.payload.model_provider = toProvider;
      changes.providerUpdates += 1;
      recordChanged = true;
    }
  }
  return recordChanged ? formatJsonLine(record, original) : original;
}

function hasRewriteChanges(changes) {
  return changes.providerUpdates > 0
    || changes.removedResponseItems > 0
    || changes.sanitizedReasoningItems > 0
    || changes.convertedCompactionItems > 0
    || changes.removedCompactionItems > 0;
}

function openUniqueTempFile(filePath) {
  const base = `${filePath}.${process.pid}.${Date.now()}`;
  for (let suffix = 0; ; suffix += 1) {
    const tempPath = `${base}${suffix === 0 ? '' : `-${suffix}`}.tmp`;
    try {
      return { fd: fs.openSync(tempPath, 'wx'), path: tempPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

function createBufferedWriter(fileDescriptor) {
  let chunks = [];
  let length = 0;

  const flush = () => {
    if (length === 0) {
      return;
    }
    fs.writeFileSync(fileDescriptor, chunks.join(''), 'utf8');
    chunks = [];
    length = 0;
  };

  return {
    write(text) {
      chunks.push(text);
      length += text.length;
      if (length >= JSONL_WRITE_BUFFER_SIZE) {
        flush();
      }
    },
    flush,
  };
}

function rewriteSessionFileOnDisk(filePath, expected, toProvider, { sanitizeEncrypted = false } = {}) {
  const currentStat = fs.statSync(filePath);
  if (currentStat.size !== expected.bytes || currentStat.mtimeMs !== expected.mtimeMs) {
    fail(`Session changed while preparing to write: ${filePath}`);
  }

  const temp = openUniqueTempFile(filePath);
  let sourceFd;
  try {
    sourceFd = fs.openSync(filePath, 'r');
  } catch (error) {
    fs.closeSync(temp.fd);
    fs.rmSync(temp.path, { force: true });
    throw error;
  }
  const changes = createRewriteState();
  const output = createBufferedWriter(temp.fd);
  let outputFdOpen = true;

  const writeLine = (line, hasNewline) => {
    const rewritten = rewriteSessionLine(line, toProvider, sanitizeEncrypted, changes);
    if (rewritten !== null) {
      output.write(rewritten + (hasNewline ? '\n' : ''));
    }
  };
  try {
    processJsonlLinesSync(sourceFd, writeLine);
    output.flush();
    if (!changes.sawMeta) {
      fail('Cannot rewrite session without a session_meta record.');
    }
    fs.fsyncSync(temp.fd);
    fs.closeSync(sourceFd);
    fs.closeSync(temp.fd);
    outputFdOpen = false;

    if (!hasRewriteChanges(changes)) {
      fs.rmSync(temp.path, { force: true });
      return { ...changes, changed: false };
    }
    fs.chmodSync(temp.path, currentStat.mode);
    const finalStat = fs.statSync(filePath);
    if (finalStat.size !== expected.bytes || finalStat.mtimeMs !== expected.mtimeMs) {
      fail(`Session changed while rewriting: ${filePath}`);
    }
    fs.renameSync(temp.path, filePath);
    return { ...changes, changed: true };
  } catch (error) {
    if (sourceFd !== undefined) {
      try { fs.closeSync(sourceFd); } catch { /* Best-effort cleanup. */ }
    }
    if (outputFdOpen) {
      try { fs.closeSync(temp.fd); } catch { /* Best-effort cleanup. */ }
    }
    fs.rmSync(temp.path, { force: true });
    throw error;
  }
}

function createBackup(inventory, plan, backupRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(backupRoot, { recursive: true });
  let backupDir = '';
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(backupRoot, suffix === 0 ? stamp : `${stamp}-${suffix}`);
    try {
      fs.mkdirSync(candidate);
      fs.mkdirSync(path.join(candidate, 'jsonl'));
      backupDir = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  const db = openStateDb(inventory.stateDbPath, true);
  try {
    db.exec(`VACUUM INTO ${sqlString(path.join(backupDir, STATE_DB_FILENAME))}`);
  } finally {
    db.close();
  }
  backupHistory(inventory, plan, backupDir);

  for (const entry of plan.sessionFiles) {
    const destination = path.join(backupDir, 'jsonl', entry.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.filePath, destination);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    historyDbPath: inventory.historyDbPath,
    fromProviders: plan.fromProviders,
    toProvider: plan.toProvider,
    sessionId: plan.sessionId || null,
    sessionFiles: plan.sessionFiles.map((entry) => entry.relativePath),
    historyRollouts: plan.sessionFiles.map((entry) => entry.rolloutId),
    databaseRows: plan.dbRows.map((row) => row.id),
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return backupDir;
}

function sqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function backupHistory(inventory, plan, backupDir) {
  if (!inventory.historyDbPath || plan.sessionFiles.length === 0) return;
  const db = new DatabaseSync(path.join(backupDir, 'thread_history_1.sqlite'));
  try {
    db.exec(`ATTACH DATABASE ${sqlString(`${pathToFileURL(inventory.historyDbPath).href}?mode=ro`)} AS source`);
    db.exec('BEGIN');
    const ids = [...new Set(plan.sessionFiles.map((entry) => sqlString(entry.rolloutId)))].join(',');
    for (const table of HISTORY_TABLES) {
      db.exec(`CREATE TABLE main.${table} AS SELECT * FROM source.${table} WHERE thread_id IN (${ids})`);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function resetHistoryProjection(inventory, plan) {
  if (!inventory.historyDbPath || plan.sessionFiles.length === 0) return 0;
  const db = openStateDb(inventory.historyDbPath, false);
  try {
    db.exec('BEGIN IMMEDIATE');
    const deleteSuffix = HISTORY_TABLES.slice(0, -1).map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE thread_id = ? AND rollout_ordinal >= ?`));
    const reopenTurn = db.prepare("UPDATE thread_turns SET rollout_end_ordinal = NULL, rollout_end_byte_offset = NULL, status = 'inProgress' WHERE thread_id = ? AND rollout_end_ordinal >= ?");
    const deleteCheckpoint = db.prepare('DELETE FROM thread_history_projection_state WHERE thread_id = ?');
    for (const entry of plan.sessionFiles) {
      // Keep inherited history whose durable prefix is no longer in this rollout.
      for (const statement of deleteSuffix) {
        statement.run(entry.rolloutId, entry.historyStartOrdinal);
      }
      reopenTurn.run(entry.rolloutId, entry.historyStartOrdinal);
      deleteCheckpoint.run(entry.rolloutId);
    }
    db.exec('COMMIT');
    return plan.sessionFiles.length;
  } finally {
    db.close();
  }
}

function applyDatabasePlan(inventory, plan) {
  const db = openStateDb(inventory.stateDbPath, false);
  let changed = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
    for (const row of plan.dbRows) {
      const result = update.run(plan.toProvider, row.id, row.provider);
      if (Number(result.changes) !== 1) {
        fail(`Session provider changed while preparing to write: ${row.id}`);
      }
      changed += 1;
    }
    db.exec('COMMIT');
    return changed;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    db.close();
  }
}

function applySessionPlan(plan) {
  let changed = 0;
  let removedResponseItems = 0;
  let sanitizedReasoningItems = 0;
  let convertedCompactionItems = 0;
  let removedCompactionItems = 0;
  for (const entry of plan.sessionFiles) {
    const rewritten = rewriteSessionFileOnDisk(entry.filePath, entry, plan.toProvider, { sanitizeEncrypted: plan.sanitizeEncrypted });
    if (rewritten.changed) {
      changed += 1;
    }
    removedResponseItems += rewritten.removedResponseItems;
    sanitizedReasoningItems += rewritten.sanitizedReasoningItems;
    convertedCompactionItems += rewritten.convertedCompactionItems;
    removedCompactionItems += rewritten.removedCompactionItems;
  }
  return { changed, removedResponseItems, sanitizedReasoningItems, convertedCompactionItems, removedCompactionItems };
}

function verifyPlan(inventory, plan) {
  const fresh = inspectSessionFiles(plan.sessionFiles.map((entry) => entry.filePath), inventory.codexHome);
  if (fresh.errors.length > 0 || fresh.entries.length !== plan.sessionFiles.length) {
    fail('Verification failed: a rewritten rollout is missing or unreadable.');
  }
  for (const [index, entry] of fresh.entries.entries()) {
    const original = plan.sessionFiles[index];
    const expectedProviders = plan.repairOnly ? original.providers : [plan.toProvider];
    if (entry.id !== original.id || entry.providers.length !== expectedProviders.length
      || entry.providers.some((provider, i) => provider !== expectedProviders[i])) {
      fail(`Verification failed: session identity or provider changed unexpectedly: ${entry.filePath}`);
    }
    if (entry.malformedResponseItems > 0 || (plan.sanitizeEncrypted && entry.replayRepairItems > 0)) {
      fail(`Verification failed: incompatible replay items remain: ${entry.filePath}`);
    }
  }
  if (plan.dbRows.length === 0) return;
  const rows = new Map(readStateRows(inventory.stateDbPath, plan.sessionId).map((row) => [row.id, row]));
  for (const row of plan.dbRows) {
    if (rows.get(row.id)?.provider !== plan.toProvider) {
      fail(`Verification failed: SQLite provider was not updated: ${row.id}`);
    }
  }
}

function summarize(inventory, plan) {
  const totals = plan.sessionFiles.reduce((result, entry) => {
    result.bytes += entry.bytes;
    result.historyRepairs += entry.malformedResponseItems;
    result.encryptedReplayItems += entry.encryptedReplayItems;
    result.replayRepairItems += entry.replayRepairItems;
    result.plaintextCompactionItems += entry.plaintextCompactionItems;
    result.opaqueCompactionItems += entry.opaqueCompactionItems;
    return result;
  }, {
    bytes: 0,
    historyRepairs: 0,
    encryptedReplayItems: 0,
    replayRepairItems: 0,
    plaintextCompactionItems: 0,
    opaqueCompactionItems: 0,
  });
  return {
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    fromProviders: plan.fromProviders,
    toProvider: plan.toProvider,
    sessionId: plan.sessionId || null,
    jsonlChanges: plan.sessionFiles.length,
    sqliteChanges: plan.dbRows.length,
    jsonlBytes: totals.bytes,
    historyRepairs: totals.historyRepairs,
    encryptedReplayItems: totals.encryptedReplayItems,
    replayRepairItems: totals.replayRepairItems,
    plaintextCompactionItems: totals.plaintextCompactionItems,
    opaqueCompactionItems: totals.opaqueCompactionItems,
    mixedSessionMetadata: plan.sessionFiles.filter((entry) => entry.providers.length > 1).length,
    unsupportedCompressed: inventory.unsupported.length,
    scanErrors: inventory.scanErrors.length,
  };
}

function syncProvider(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  if (!fs.existsSync(codexHome)) {
    fail(`Codex home does not exist: ${codexHome}`);
  }
  const stateDbPath = resolveStateDb(codexHome, options.stateDbPath);
  const inventory = scanInventory({ codexHome, stateDbPath, sessionId: options.sessionId });
  if (inventory.scanErrors.length > 0) {
    fail(`Cannot safely continue: ${inventory.scanErrors.length} rollout files could not be parsed.`);
  }
  if (inventory.unsupported.length > 0) {
    fail(`Compressed rollouts are present but this standalone package cannot rewrite them yet:\n${inventory.unsupported.join('\n')}`);
  }

  const plan = options.repairHistory ? buildRepairPlan(inventory, options) : buildPlan(inventory, options);
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    repairOnly: Boolean(options.repairHistory),
    repairEncrypted: Boolean(options.repairEncrypted),
    ...summarize(inventory, plan),
  };
  if (!options.apply || (plan.sessionFiles.length === 0 && plan.dbRows.length === 0)) {
    return report;
  }

  const threadIds = new Set([...plan.sessionFiles, ...plan.dbRows].map((entry) => entry.id));
  for (const id of threadIds) {
    const lockPath = path.join(codexHome, 'thread-writer-locks', `${id}.lock`);
    if (fs.existsSync(lockPath)) {
      // Windows byte-range locks allow opening the file but reject reading it.
      const lockFd = fs.openSync(lockPath, 'r');
      try {
        fs.readSync(lockFd, Buffer.alloc(1), 0, 1, 0);
      } finally {
        fs.closeSync(lockFd);
      }
    }
  }

  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, 'backups', 'provider-sync'));
  report.backupDir = createBackup(inventory, plan, backupRoot);
  report.historyThreadsReset = resetHistoryProjection(inventory, plan);
  const sessionResult = applySessionPlan(plan);
  report.sqliteUpdated = plan.dbRows.length > 0 ? applyDatabasePlan(inventory, plan) : 0;
  report.jsonlUpdated = sessionResult.changed;
  report.historyItemsRemoved = sessionResult.removedResponseItems;
  report.sanitizedReasoningItems = sessionResult.sanitizedReasoningItems;
  report.convertedCompactionItems = sessionResult.convertedCompactionItems;
  report.removedCompactionItems = sessionResult.removedCompactionItems;
  verifyPlan({ codexHome, stateDbPath }, plan);
  report.verified = true;
  report.remainingJsonl = 0;
  report.remainingSqlite = 0;
  return report;
}

function formatInventory(inventory) {
  const sessionTotals = inventory.sessions.reduce((result, entry) => {
    result.historyRepairCandidates += entry.malformedResponseItems;
    result.encryptedReplayCandidates += entry.encryptedReplayItems;
    result.replayRepairCandidates += entry.replayRepairItems;
    result.plaintextCompactionCandidates += entry.plaintextCompactionItems;
    result.opaqueCompactionCandidates += entry.opaqueCompactionItems;
    return result;
  }, {
    historyRepairCandidates: 0,
    encryptedReplayCandidates: 0,
    replayRepairCandidates: 0,
    plaintextCompactionCandidates: 0,
    opaqueCompactionCandidates: 0,
  });
  return {
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    jsonlSessions: inventory.sessions.length,
    sqliteThreads: inventory.dbRows.length,
    sessionProviders: inventory.sessionProviders,
    databaseProviders: inventory.databaseProviders,
    sessionMetadataProviders: countProviders(inventory.sessions.flatMap((entry) => entry.providers)),
    ...sessionTotals,
    archivedAndActiveRoots: SESSION_ROOTS.map((root) => path.join(inventory.codexHome, root)),
  };
}

module.exports = {
  formatInventory,
  resolveCodexHome,
  resolveStateDb,
  scanInventory,
  syncProvider,
};
