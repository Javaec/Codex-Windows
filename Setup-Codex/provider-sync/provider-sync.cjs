'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { DatabaseSync } = require('node:sqlite');

const STATE_DB_FILENAME = 'state_5.sqlite';
const SESSION_ROOTS = ['sessions', 'archived_sessions'];
const ACTION_NONE = 'none';
const ACTION_REMOVE_REASONING = 'removedReasoning';
const ACTION_SANITIZE_REASONING = 'sanitizedReasoning';
const ACTION_REMOVE_COMPACTION = 'removedCompaction';
const ACTION_CONVERT_COMPACTION = 'convertedCompaction';
const OPAQUE_ENCRYPTED_CONTENT = /^[A-Za-z0-9_+=\/-]+$/u;
const JSONL_READ_BUFFER_SIZE = 8 * 1024 * 1024;
const MAX_SCAN_ATTEMPTS = 3;

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

function isInvisibleText(value) {
  return typeof value === 'string' && !/[^\s\u200B\u200C\u200D\uFEFF]/u.test(value);
}

function summaryText(payload) {
  if (!Array.isArray(payload?.summary)) {
    return '';
  }
  let result = '';
  for (const item of payload.summary) {
    if (typeof item?.text === 'string') {
      result += item.text;
    }
  }
  return result;
}

function hasVisibleReasoningContent(payload) {
  return (Array.isArray(payload?.content) && payload.content.length > 0)
    || !isInvisibleText(summaryText(payload));
}

function isRepairableReasoningItem(payload) {
  if (!payload || payload.type !== 'reasoning' || typeof payload.id !== 'string' || !payload.id) {
    return false;
  }
  if (typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    return false;
  }
  return !hasVisibleReasoningContent(payload);
}

function isOpaqueEncryptedContent(value) {
  return typeof value === 'string'
    && value.length > 0
    && OPAQUE_ENCRYPTED_CONTENT.test(value);
}

function makeVisibleCompactionMessage(text) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function sanitizeResponseItem(payload) {
  if (!payload || typeof payload !== 'object') {
    return { payload, action: ACTION_NONE };
  }

  if (payload.type === 'reasoning' && typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    if (!hasVisibleReasoningContent(payload)) {
      return { payload: null, action: ACTION_REMOVE_REASONING };
    }
    const sanitized = { ...payload };
    delete sanitized.encrypted_content;
    delete sanitized.id;
    return { payload: sanitized, action: ACTION_SANITIZE_REASONING };
  }

  if (payload.type === 'compaction' && typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    if (isOpaqueEncryptedContent(payload.encrypted_content)) {
      return { payload: null, action: ACTION_REMOVE_COMPACTION };
    }
    return { payload: makeVisibleCompactionMessage(payload.encrypted_content), action: ACTION_CONVERT_COMPACTION };
  }

  return { payload, action: ACTION_NONE };
}

function collectReplayPayloadStats(payload, stats) {
  if (!payload || typeof payload !== 'object') {
    return;
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
  if (record?.type === 'compacted' && Array.isArray(record.payload?.replacement_history)) {
    for (const item of record.payload.replacement_history) {
      collectReplayPayloadStats(item, stats);
    }
  }
}

function processJsonlLinesSync(fileDescriptor, callback) {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(JSONL_READ_BUFFER_SIZE);
  let carry = '';

  const consume = (chunk, final = false) => {
    carry += chunk;
    let newlineIndex = carry.indexOf('\n');
    while (newlineIndex >= 0) {
      callback(carry.slice(0, newlineIndex), true);
      carry = carry.slice(newlineIndex + 1);
      newlineIndex = carry.indexOf('\n');
    }
    if (final && carry.length > 0) {
      callback(carry, false);
      carry = '';
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
    provider,
    providers: analysis.providers,
    malformedResponseItems: analysis.malformedResponseItems,
    encryptedReasoningItems: analysis.encryptedReasoningItems,
    encryptedCompactionItems: analysis.encryptedCompactionItems,
    encryptedReplayItems: analysis.encryptedReasoningItems + analysis.encryptedCompactionItems,
    opaqueCompactionItems: analysis.opaqueCompactionItems,
    plaintextCompactionItems: analysis.plaintextCompactionItems,
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

function scanSessions(codexHome, sessionId = '') {
  const unsupported = [];
  const rolloutFiles = [];
  for (const rootName of SESSION_ROOTS) {
    const rootPath = path.join(codexHome, rootName);
    for (const filePath of listFilesRecursive(rootPath)) {
      if (filePath.endsWith('.jsonl.zst')) {
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
  const matchingFileSet = new Set(matchingFiles);
  const initialFiles = sessionId && matchingFiles.length === 0 ? rolloutFiles : matchingFiles;
  const inspected = inspectSessionFiles(initialFiles, codexHome);
  if (sessionId && matchingFiles.length > 0 && !inspected.entries.some((entry) => entry.id === sessionId)) {
    const initialTargetEntries = inspected.entries.filter((entry) => entry.id === sessionId);
    const fallbackFiles = rolloutFiles.filter((filePath) => !matchingFileSet.has(filePath));
    const fallback = inspectSessionFiles(fallbackFiles, codexHome);
    inspected.entries.length = 0;
    inspected.entries.push(...initialTargetEntries, ...fallback.entries.filter((entry) => entry.id === sessionId));
    inspected.errors.push(...fallback.errors);
  }
  return { entries: inspected.entries, errors: inspected.errors, unsupported };
}

function openStateDb(stateDbPath, readOnly) {
  return new DatabaseSync(stateDbPath, readOnly ? { readOnly: true } : {});
}

function readStateRows(stateDbPath) {
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
    return db.prepare(select).all().map((row) => ({
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
  const sessions = scanSessions(codexHome, sessionId);
  const dbRows = readStateRows(stateDbPath);
  return {
    codexHome,
    stateDbPath,
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
  if (sessionMatches.length === 0 && dbMatches.length === 0) {
    return { fromProviders: sources, toProvider: target, sessionId: sessionId || '', sessionFiles: [], dbRows: [] };
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
      && (entry.malformedResponseItems > 0 || (repairEncrypted && entry.encryptedReplayItems > 0)));
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

function recordSanitizedAction(action, changes) {
  switch (action) {
    case ACTION_REMOVE_REASONING:
      changes.removedResponseItems += 1;
      break;
    case ACTION_SANITIZE_REASONING:
      changes.sanitizedReasoningItems += 1;
      break;
    case ACTION_REMOVE_COMPACTION:
      changes.removedCompactionItems += 1;
      break;
    case ACTION_CONVERT_COMPACTION:
      changes.convertedCompactionItems += 1;
      break;
    default:
      break;
  }
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
    return { keep: true, text: original };
  }

  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { keep: true, text: original };
  }

  let keepRecord = true;
  let recordChanged = false;
  if (record?.type === 'response_item') {
    if (isRepairableReasoningItem(record.payload)) {
      changes.removedResponseItems += 1;
      keepRecord = false;
    }
    if (keepRecord && sanitizeEncrypted) {
      const sanitized = sanitizeResponseItem(record.payload);
      if (sanitized.action === ACTION_REMOVE_REASONING || sanitized.action === ACTION_REMOVE_COMPACTION) {
        keepRecord = false;
      }
      if (sanitized.action !== ACTION_NONE) {
        recordSanitizedAction(sanitized.action, changes);
        if (keepRecord) {
          record.payload = sanitized.payload;
          recordChanged = true;
        }
      }
    }
  }
  if (keepRecord && sanitizeEncrypted && record?.type === 'compacted' && Array.isArray(record.payload?.replacement_history)) {
    const replacementHistory = [];
    let replacementChanged = false;
    for (const item of record.payload.replacement_history) {
      const sanitized = sanitizeResponseItem(item);
      if (sanitized.action !== ACTION_NONE) {
        recordSanitizedAction(sanitized.action, changes);
        replacementChanged = true;
      }
      if (sanitized.action !== ACTION_REMOVE_REASONING && sanitized.action !== ACTION_REMOVE_COMPACTION) {
        replacementHistory.push(sanitized.action === ACTION_NONE ? item : sanitized.payload);
      }
    }
    if (replacementChanged) {
      record.payload.replacement_history = replacementHistory;
      recordChanged = true;
    }
  }
  if (keepRecord && record?.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    changes.sawMeta = true;
    if (toProvider && record.payload.model_provider !== toProvider) {
      record.payload.model_provider = toProvider;
      changes.providerUpdates += 1;
      recordChanged = true;
    }
  }
  return {
    keep: keepRecord,
    text: keepRecord && recordChanged ? formatJsonLine(record, original) : original,
  };
}

function finishRewrite(changes, text) {
  if (!changes.sawMeta) {
    fail('Cannot rewrite session without a session_meta record.');
  }
  const { sawMeta, ...result } = changes;
  return { text, ...result };
}

function hasRewriteChanges(changes) {
  return changes.providerUpdates > 0
    || changes.removedResponseItems > 0
    || changes.sanitizedReasoningItems > 0
    || changes.convertedCompactionItems > 0
    || changes.removedCompactionItems > 0;
}

function rewriteSessionFile(text, toProvider, { sanitizeEncrypted = false } = {}) {
  const lines = text.split('\n');
  const output = [];
  const changes = createRewriteState();
  for (const original of lines) {
    const rewritten = rewriteSessionLine(original, toProvider, sanitizeEncrypted, changes);
    if (rewritten.keep) {
      output.push(rewritten.text);
    }
  }
  return finishRewrite(changes, hasRewriteChanges(changes) ? output.join('\n') : text);
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
  let outputFdOpen = true;

  const writeLine = (line, hasNewline) => {
    const rewritten = rewriteSessionLine(line, toProvider, sanitizeEncrypted, changes);
    if (rewritten.keep) {
      fs.writeSync(temp.fd, rewritten.text + (hasNewline ? '\n' : ''), null, 'utf8');
    }
  };
  try {
    processJsonlLinesSync(sourceFd, writeLine);
    if (!changes.sawMeta) {
      fail('Cannot rewrite session without a session_meta record.');
    }
    fs.fsyncSync(temp.fd);
    fs.closeSync(sourceFd);
    fs.closeSync(temp.fd);
    outputFdOpen = false;

    if (!hasRewriteChanges(changes)) {
      fs.rmSync(temp.path, { force: true });
      return { changed: false, ...finishRewrite(changes, '') };
    }
    fs.chmodSync(temp.path, currentStat.mode);
    fs.rmSync(filePath);
    fs.renameSync(temp.path, filePath);
    return { changed: true, ...finishRewrite(changes, '') };
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

function rewriteSessionProvider(text, toProvider) {
  return rewriteSessionFile(text, toProvider).text;
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

  const dbFiles = [inventory.stateDbPath, `${inventory.stateDbPath}-wal`, `${inventory.stateDbPath}-shm`]
    .filter((filePath) => fs.existsSync(filePath));
  for (const filePath of dbFiles) {
    fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
  }

  for (const entry of plan.sessionFiles) {
    const destination = path.join(backupDir, 'jsonl', entry.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.filePath, destination);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    fromProviders: plan.fromProviders,
    toProvider: plan.toProvider,
    sessionId: plan.sessionId || null,
    sessionFiles: plan.sessionFiles.map((entry) => entry.relativePath),
    databaseRows: plan.dbRows.map((row) => row.id),
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return backupDir;
}

function applyDatabasePlan(inventory, plan) {
  const db = openStateDb(inventory.stateDbPath, false);
  let changed = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    if (plan.sessionId) {
      const result = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider IN (' + plan.fromProviders.map(() => '?').join(',') + ')')
        .run(plan.toProvider, plan.sessionId, ...plan.fromProviders);
      changed = Number(result.changes || 0);
    } else {
      const result = db.prepare('UPDATE threads SET model_provider = ? WHERE model_provider IN (' + plan.fromProviders.map(() => '?').join(',') + ')')
        .run(plan.toProvider, ...plan.fromProviders);
      changed = Number(result.changes || 0);
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

function isSelectedSession(entry, plan) {
  return !plan.sessionId || entry.id === plan.sessionId;
}

function remainsInPlan(entry, plan) {
  if (!isSelectedSession(entry, plan)) {
    return false;
  }
  if (plan.repairOnly) {
    return entry.malformedResponseItems > 0 || (plan.repairEncrypted && entry.encryptedReplayItems > 0);
  }
  return plan.fromProviders.some((source) => entry.providers.includes(source))
    || (plan.sanitizeEncrypted && entry.encryptedReplayItems > 0);
}

function remainsInDatabase(row, plan) {
  return (!plan.sessionId || row.id === plan.sessionId)
    && plan.fromProviders.includes(row.provider);
}

function verifyPlan(inventory, plan) {
  const fresh = scanInventory({ ...inventory, sessionId: plan.sessionId });
  const remainingFiles = fresh.sessions.filter((entry) => remainsInPlan(entry, plan));
  const remainingRows = fresh.dbRows.filter((row) => remainsInDatabase(row, plan));
  if (remainingFiles.length > 0 || remainingRows.length > 0) {
    fail(`Verification failed: ${remainingFiles.length} JSONL files and ${remainingRows.length} SQLite rows still use source providers.`);
  }
  return fresh;
}

function summarize(inventory, plan) {
  const totals = plan.sessionFiles.reduce((result, entry) => {
    result.bytes += entry.bytes;
    result.historyRepairs += entry.malformedResponseItems;
    result.encryptedReplayItems += entry.encryptedReplayItems;
    result.plaintextCompactionItems += entry.plaintextCompactionItems;
    result.opaqueCompactionItems += entry.opaqueCompactionItems;
    return result;
  }, {
    bytes: 0,
    historyRepairs: 0,
    encryptedReplayItems: 0,
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

  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, 'backups', 'provider-sync'));
  report.backupDir = createBackup(inventory, plan, backupRoot);
  report.sqliteUpdated = plan.dbRows.length > 0 ? applyDatabasePlan(inventory, plan) : 0;
  const sessionResult = applySessionPlan(plan);
  report.jsonlUpdated = sessionResult.changed;
  report.historyItemsRemoved = sessionResult.removedResponseItems;
  report.sanitizedReasoningItems = sessionResult.sanitizedReasoningItems;
  report.convertedCompactionItems = sessionResult.convertedCompactionItems;
  report.removedCompactionItems = sessionResult.removedCompactionItems;
  const verified = verifyPlan({ codexHome, stateDbPath }, plan);
  report.verified = true;
  report.remainingJsonl = verified.sessions.filter((entry) => remainsInPlan(entry, plan)).length;
  report.remainingSqlite = verified.dbRows.filter((row) => remainsInDatabase(row, plan)).length;
  return report;
}

function formatInventory(inventory) {
  const sessionTotals = inventory.sessions.reduce((result, entry) => {
    result.historyRepairCandidates += entry.malformedResponseItems;
    result.encryptedReplayCandidates += entry.encryptedReplayItems;
    result.plaintextCompactionCandidates += entry.plaintextCompactionItems;
    result.opaqueCompactionCandidates += entry.opaqueCompactionItems;
    return result;
  }, {
    historyRepairCandidates: 0,
    encryptedReplayCandidates: 0,
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
  buildPlan,
  formatInventory,
  resolveCodexHome,
  resolveStateDb,
  rewriteSessionProvider,
  scanInventory,
  syncProvider,
};
