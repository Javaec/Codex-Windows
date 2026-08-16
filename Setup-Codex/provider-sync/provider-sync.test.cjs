'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  rewriteSessionProvider,
  scanInventory,
  syncProvider,
} = require('./provider-sync.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-sync-'));
  const sessionPath = path.join(root, 'sessions', '2026', '08', '15', 'rollout-session-a.jsonl');
  const archivedPath = path.join(root, 'archived_sessions', 'rollout-b.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  const session = { type: 'session_meta', payload: { id: 'session-a', model_provider: 'openai', cwd: 'C:\\work' } };
  const resumedSession = { type: 'session_meta', payload: { id: 'session-a', model_provider: 'codex', cwd: 'C:\\work' } };
  const malformedReasoning = {
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'rs_missing',
      summary: [{ type: 'summary_text', text: '\u200b' }],
      encrypted_content: null,
      content: null,
    },
  };
  const validReasoning = {
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'rs_valid',
      summary: [{ type: 'summary_text', text: 'Visible summary' }],
      encrypted_content: null,
      content: null,
    },
  };
  const encryptedReasoning = {
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'rs_encrypted',
      summary: [{ type: 'summary_text', text: 'Visible encrypted summary' }],
      encrypted_content: 'gAAAA_provider_specific_reasoning',
      content: null,
    },
  };
  const compacted = {
    type: 'compacted',
    payload: {
      id: 'cmp_parent',
      replacement_history: [
        {
          type: 'compaction',
          id: 'cmp_plain',
          encrypted_content: 'Visible checkpoint summary from the old provider',
        },
        {
          type: 'compaction',
          id: 'cmp_opaque',
          encrypted_content: 'gAAAA_provider_specific_compaction',
        },
        {
          type: 'reasoning',
          id: 'rs_nested',
          summary: [{ type: 'summary_text', text: 'Nested visible summary' }],
          encrypted_content: 'gAAAA_provider_specific_nested_reasoning',
        },
      ],
    },
  };
  const topLevelPlainCompaction = {
    type: 'response_item',
    payload: {
      type: 'compaction',
      id: 'cmp_top_plain',
      encrypted_content: 'Top-level readable checkpoint summary',
    },
  };
  const topLevelOpaqueCompaction = {
    type: 'response_item',
    payload: {
      type: 'compaction',
      id: 'cmp_top_opaque',
      encrypted_content: 'gAAAA_top_level_provider_ciphertext',
    },
  };
  const archived = { type: 'session_meta', payload: { id: 'session-b', model_provider: 'custom', cwd: 'C:\\work' } };
  fs.writeFileSync(sessionPath, `${JSON.stringify(session)}\n${JSON.stringify(resumedSession)}\n${JSON.stringify(malformedReasoning)}\n${JSON.stringify(validReasoning)}\n${JSON.stringify(encryptedReasoning)}\n${JSON.stringify(compacted)}\n${JSON.stringify(topLevelPlainCompaction)}\n${JSON.stringify(topLevelOpaqueCompaction)}\n${JSON.stringify({ type: 'event_msg', payload: { text: '"model_provider":"openai"' } })}\n`, 'utf8');
  fs.writeFileSync(archivedPath, `${JSON.stringify(archived)}\n`, 'utf8');

  const dbPath = path.join(root, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('session-a', 'openai', sessionPath);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('session-b', 'custom', archivedPath);
  db.close();
  return { root, sessionPath, archivedPath, dbPath };
}

test('inventory reads active and archived rollouts and SQLite providers', () => {
  const testFixture = fixture();
  try {
    const inventory = scanInventory({ codexHome: testFixture.root, stateDbPath: testFixture.dbPath });
    assert.equal(inventory.sessions.length, 2);
    assert.deepEqual(inventory.sessionProviders, { custom: 1, openai: 1 });
    assert.deepEqual(inventory.databaseProviders, { custom: 1, openai: 1 });
    const targeted = scanInventory({ codexHome: testFixture.root, stateDbPath: testFixture.dbPath, sessionId: 'session-a' });
    assert.deepEqual(targeted.sessions.map((entry) => entry.id), ['session-a']);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('provider rewrite preserves CRLF and malformed lines byte-for-byte', () => {
  const original = `  ${JSON.stringify({ type: 'session_meta', payload: { id: 'session-crlf', model_provider: 'openai' } })}\r\nnot-json\r\n`;
  const rewritten = rewriteSessionProvider(original, 'custom');
  assert.equal(rewritten, `  ${JSON.stringify({ type: 'session_meta', payload: { id: 'session-crlf', model_provider: 'custom' } })}\r\nnot-json\r\n`);
});

test('targeted scan falls back when a matching filename belongs to another session', () => {
  const testFixture = fixture();
  try {
    const actualPath = path.join(testFixture.root, 'sessions', '2026', '08', '15', 'rollout-without-session-id.jsonl');
    const misleadingPath = testFixture.sessionPath;
    fs.renameSync(misleadingPath, actualPath);
    fs.writeFileSync(misleadingPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-b', model_provider: 'custom' } })}\n`, 'utf8');

    const targeted = scanInventory({ codexHome: testFixture.root, stateDbPath: testFixture.dbPath, sessionId: 'session-a' });
    assert.deepEqual(targeted.sessions.map((entry) => entry.id), ['session-a']);
    assert.equal(targeted.sessions[0].filePath, actualPath);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('backup directory gets a suffix when the timestamp already exists', () => {
  const testFixture = fixture();
  const originalDate = Date;
  try {
    const fixedIso = '2026-08-15T00:00:00.000Z';
    const fixedStamp = fixedIso.replace(/[:.]/g, '-');
    const backupRoot = path.join(testFixture.root, 'backups');
    fs.mkdirSync(path.join(backupRoot, fixedStamp, 'jsonl'), { recursive: true });
    global.Date = class extends originalDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedIso] : args));
      }

      static now() {
        return new originalDate(fixedIso).getTime();
      }
    };

    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      repairHistory: true,
      sessionId: 'session-a',
      apply: true,
      backupRoot,
    });
    assert.equal(report.backupDir, path.join(backupRoot, `${fixedStamp}-1`));
    assert.equal(fs.existsSync(path.join(report.backupDir, 'manifest.json')), true);
  } finally {
    global.Date = originalDate;
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('apply changes only the session_meta provider and matching SQLite row', () => {
  const testFixture = fixture();
  try {
    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      fromProviders: ['openai'],
      toProvider: 'custom',
      sessionId: 'session-a',
      apply: true,
      backupRoot: path.join(testFixture.root, 'backups'),
    });
    assert.equal(report.jsonlUpdated, 1);
    assert.equal(report.sqliteUpdated, 1);
    assert.equal(report.verified, true);
    assert.equal(report.remainingJsonl, 0);
    assert.equal(report.remainingSqlite, 0);
    assert.equal(report.historyRepairs, 1);
    assert.equal(report.historyItemsRemoved, 1);
    assert.equal(report.encryptedReplayItems, 6);
    assert.equal(report.sanitizedReasoningItems, 2);
    assert.equal(report.convertedCompactionItems, 2);
    assert.equal(report.removedCompactionItems, 2);
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.equal((text.match(/"type":"session_meta"/g) || []).length, 2);
    assert.equal((text.match(/"model_provider":"custom"/g) || []).length, 2);
    assert.doesNotMatch(text, /rs_missing/);
    assert.doesNotMatch(text, /rs_encrypted/);
    assert.doesNotMatch(text, /gAAAA_(provider_specific|top_level)/);
    assert.match(text, /Visible checkpoint summary from the old provider/);
    assert.match(text, /"type":"message"/);
    assert.match(text, /rs_valid/);
    assert.match(text, /\\"model_provider\\":\\"openai\\"/);
    const db = new DatabaseSync(testFixture.dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT model_provider FROM threads WHERE id = ?').get('session-a').model_provider, 'custom');
    assert.equal(db.prepare('SELECT model_provider FROM threads WHERE id = ?').get('session-b').model_provider, 'custom');
    db.close();
    assert.equal(fs.readdirSync(path.join(testFixture.root, 'backups')).length, 1);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('verification ignores encrypted history in an unplanned target session', () => {
  const testFixture = fixture();
  try {
    const targetPath = path.join(testFixture.root, 'sessions', '2026', '08', '16', 'rollout-session-c.jsonl');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-c', model_provider: 'custom', cwd: 'C:\\work' } })}\n${JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', id: 'rs_target', encrypted_content: 'gAAAA_target_provider_ciphertext' },
    })}\n`, 'utf8');
    const db = new DatabaseSync(testFixture.dbPath);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('session-c', 'custom', targetPath);
    db.close();

    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      fromProviders: ['openai'],
      toProvider: 'custom',
      apply: true,
      backupRoot: path.join(testFixture.root, 'backups'),
    });
    assert.equal(report.verified, true);
    assert.equal(report.remainingJsonl, 0);
    assert.equal(report.remainingSqlite, 0);
    assert.match(fs.readFileSync(targetPath, 'utf8'), /gAAAA_target_provider_ciphertext/);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('dry-run does not write or create a backup', () => {
  const testFixture = fixture();
  try {
    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      fromProviders: ['openai'],
      toProvider: 'custom',
      apply: false,
      backupRoot: path.join(testFixture.root, 'backups'),
    });
    assert.equal(report.jsonlChanges, 1);
    assert.equal(report.sqliteChanges, 1);
    assert.equal(fs.existsSync(path.join(testFixture.root, 'backups')), false);
    assert.match(fs.readFileSync(testFixture.sessionPath, 'utf8'), /"model_provider":"openai"/);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('repair-history removes only empty reasoning items without changing provider metadata', () => {
  const testFixture = fixture();
  try {
    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      repairHistory: true,
      sessionId: 'session-a',
      apply: true,
      backupRoot: path.join(testFixture.root, 'backups'),
    });
    assert.equal(report.repairOnly, true);
    assert.equal(report.historyRepairs, 1);
    assert.equal(report.historyItemsRemoved, 1);
    assert.equal(report.verified, true);
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.match(text, /"model_provider":"openai"/);
    assert.match(text, /"model_provider":"codex"/);
    assert.doesNotMatch(text, /rs_missing/);
    assert.match(text, /rs_valid/);
    assert.match(text, /gAAAA_provider_specific/);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('repair-encrypted sanitizes nested compaction history without changing provider metadata', () => {
  const testFixture = fixture();
  try {
    const report = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      repairHistory: true,
      repairEncrypted: true,
      sessionId: 'session-a',
      apply: true,
      backupRoot: path.join(testFixture.root, 'backups'),
    });
    assert.equal(report.repairEncrypted, true);
    assert.equal(report.encryptedReplayItems, 6);
    assert.equal(report.historyItemsRemoved, 1);
    assert.equal(report.sanitizedReasoningItems, 2);
    assert.equal(report.convertedCompactionItems, 2);
    assert.equal(report.removedCompactionItems, 2);
    assert.equal(report.verified, true);
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.match(text, /"model_provider":"openai"/);
    assert.match(text, /"model_provider":"codex"/);
    assert.doesNotMatch(text, /gAAAA_(provider_specific|top_level)/);
    assert.match(text, /Nested visible summary/);
    const secondPreview = syncProvider({
      codexHome: testFixture.root,
      stateDbPath: testFixture.dbPath,
      repairHistory: true,
      repairEncrypted: true,
      sessionId: 'session-a',
      apply: false,
    });
    assert.equal(secondPreview.jsonlChanges, 0);
    assert.equal(secondPreview.encryptedReplayItems, 0);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});
