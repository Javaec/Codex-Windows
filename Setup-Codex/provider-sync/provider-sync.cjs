'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const STATE_DB_FILENAME = 'state_5.sqlite';
const SESSION_ROOTS = ['sessions', 'archived_sessions'];

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
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        result.push(entryPath);
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function parseSessionMetaLine(text) {
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
      return record;
    }
  }
  return null;
}

function isInvisibleText(value) {
  return typeof value === 'string' && value.replace(/[\s\u200B\u200C\u200D\uFEFF]/gu, '') === '';
}

function isRepairableReasoningItem(payload) {
  if (!payload || payload.type !== 'reasoning' || typeof payload.id !== 'string' || !payload.id) {
    return false;
  }
  if (typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0) {
    return false;
  }
  if (Array.isArray(payload.content) && payload.content.length > 0) {
    return false;
  }
  const summary = Array.isArray(payload.summary)
    ? payload.summary.map((item) => (item && typeof item.text === 'string' ? item.text : '')).join('')
    : '';
  return isInvisibleText(summary);
}

function analyzeSessionText(text) {
  const lines = text.split('\n');
  const providers = [];
  let firstMeta = null;
  let malformedResponseItems = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
      firstMeta ||= record;
      const provider = typeof record.payload.model_provider === 'string' ? record.payload.model_provider : '';
      if (provider && !providers.includes(provider)) {
        providers.push(provider);
      }
    }
    if (record && record.type === 'response_item' && isRepairableReasoningItem(record.payload)) {
      malformedResponseItems += 1;
    }
  }

  return { firstMeta, providers, malformedResponseItems };
}

function inspectSessionFile(filePath, codexHome) {
  const text = fs.readFileSync(filePath, 'utf8');
  const analysis = analyzeSessionText(text);
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
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function scanSessions(codexHome) {
  const entries = [];
  const errors = [];
  const unsupported = [];
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
  }
  return { entries, errors, unsupported };
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

function scanInventory({ codexHome, stateDbPath }) {
  const sessions = scanSessions(codexHome);
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
    sessionId: sessionId || '',
    sessionFiles: sessionMatches,
    dbRows: dbMatches,
  };
}

function buildRepairPlan(inventory, { sessionId }) {
  const sessionFiles = inventory.sessions.filter((entry) =>
    (!sessionId || entry.id === sessionId) && entry.malformedResponseItems > 0);
  if (sessionId && sessionFiles.length === 0) {
    fail(`Session was not found with repairable history: ${sessionId}`);
  }
  return {
    repairOnly: true,
    fromProviders: [],
    toProvider: '',
    sessionId: sessionId || '',
    sessionFiles,
    dbRows: [],
  };
}

function rewriteSessionFile(text, toProvider) {
  const lines = text.split('\n');
  let providerUpdates = 0;
  let removedResponseItems = 0;
  let sawMeta = false;
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const line = original.endsWith('\r') ? original.slice(0, -1) : original;
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && record.type === 'response_item' && isRepairableReasoningItem(record.payload)) {
      lines.splice(index, 1);
      index -= 1;
      removedResponseItems += 1;
      continue;
    }
    if (!record || record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') {
      continue;
    }
    sawMeta = true;
    if (toProvider && record.payload.model_provider !== toProvider) {
      record.payload.model_provider = toProvider;
      providerUpdates += 1;
      const leading = line.match(/^\s*/)[0];
      lines[index] = `${leading}${JSON.stringify(record)}${original.endsWith('\r') ? '\r' : ''}`;
    }
  }
  if (!sawMeta) {
    fail('Cannot rewrite session without a session_meta record.');
  }
  if (providerUpdates === 0 && removedResponseItems === 0) {
    return { text, providerUpdates, removedResponseItems };
  }
  return { text: lines.join('\n'), providerUpdates, removedResponseItems };
}

function rewriteSessionProvider(text, toProvider) {
  return rewriteSessionFile(text, toProvider).text;
}

function writeFileAtomically(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const originalMode = fs.statSync(filePath).mode;
  const handle = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(handle, contents, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(tempPath, originalMode);
  fs.rmSync(filePath);
  fs.renameSync(tempPath, filePath);
}

function createBackup(inventory, plan, backupRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, stamp);
  fs.mkdirSync(path.join(backupDir, 'jsonl'), { recursive: true });

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
  for (const entry of plan.sessionFiles) {
    const original = fs.readFileSync(entry.filePath, 'utf8');
    const current = analyzeSessionText(original);
    if (!current.firstMeta || current.firstMeta.payload.id !== entry.id || JSON.stringify(current.providers) !== JSON.stringify(entry.providers)) {
      fail(`Session changed while preparing to write: ${entry.filePath}`);
    }
    const rewritten = rewriteSessionFile(original, plan.toProvider);
    if (rewritten.text !== original) {
      writeFileAtomically(entry.filePath, rewritten.text);
      changed += 1;
    }
    removedResponseItems += rewritten.removedResponseItems;
  }
  return { changed, removedResponseItems };
}

function verifyPlan(inventory, plan) {
  const fresh = scanInventory(inventory);
  const remainingFiles = fresh.sessions.filter((entry) => {
    if (plan.repairOnly) {
      return (!plan.sessionId || entry.id === plan.sessionId) && entry.malformedResponseItems > 0;
    }
    return (!plan.sessionId || entry.id === plan.sessionId)
      && plan.fromProviders.some((source) => entry.providers.includes(source));
  });
  const remainingRows = fresh.dbRows.filter((row) =>
    (!plan.sessionId || row.id === plan.sessionId) && plan.fromProviders.includes(row.provider));
  if (remainingFiles.length > 0 || remainingRows.length > 0) {
    fail(`Verification failed: ${remainingFiles.length} JSONL files and ${remainingRows.length} SQLite rows still use source providers.`);
  }
  return fresh;
}

function summarize(inventory, plan) {
  return {
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    fromProviders: plan.fromProviders,
    toProvider: plan.toProvider,
    sessionId: plan.sessionId || null,
    jsonlChanges: plan.sessionFiles.length,
    sqliteChanges: plan.dbRows.length,
    jsonlBytes: plan.sessionFiles.reduce((total, entry) => total + entry.bytes, 0),
    historyRepairs: plan.sessionFiles.reduce((total, entry) => total + entry.malformedResponseItems, 0),
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
  const inventory = scanInventory({ codexHome, stateDbPath });
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
  const verified = verifyPlan({ codexHome, stateDbPath }, plan);
  report.verified = true;
  report.remainingJsonl = verified.sessions.filter((entry) => {
    if (plan.repairOnly) {
      return (!plan.sessionId || entry.id === plan.sessionId) && entry.malformedResponseItems > 0;
    }
    return (!plan.sessionId || entry.id === plan.sessionId)
      && plan.fromProviders.some((source) => entry.providers.includes(source));
  }).length;
  report.remainingSqlite = verified.dbRows.filter((row) =>
    (!plan.sessionId || row.id === plan.sessionId) && plan.fromProviders.includes(row.provider)).length;
  return report;
}

function formatInventory(inventory) {
  return {
    codexHome: inventory.codexHome,
    stateDbPath: inventory.stateDbPath,
    jsonlSessions: inventory.sessions.length,
    sqliteThreads: inventory.dbRows.length,
    sessionProviders: inventory.sessionProviders,
    databaseProviders: inventory.databaseProviders,
    sessionMetadataProviders: countProviders(inventory.sessions.flatMap((entry) => entry.providers)),
    historyRepairCandidates: inventory.sessions.reduce((total, entry) => total + entry.malformedResponseItems, 0),
    archivedAndActiveRoots: SESSION_ROOTS.map((root) => path.join(inventory.codexHome, root)),
  };
}

module.exports = {
  buildPlan,
  formatInventory,
  parseSessionMetaLine,
  resolveCodexHome,
  resolveStateDb,
  rewriteSessionProvider,
  scanInventory,
  syncProvider,
};
