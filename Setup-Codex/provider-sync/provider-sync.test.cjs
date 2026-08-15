'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  scanInventory,
  syncProvider,
} = require('./provider-sync.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-sync-'));
  const sessionPath = path.join(root, 'sessions', '2026', '08', '15', 'rollout-a.jsonl');
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
  const archived = { type: 'session_meta', payload: { id: 'session-b', model_provider: 'custom', cwd: 'C:\\work' } };
  fs.writeFileSync(sessionPath, `${JSON.stringify(session)}\n${JSON.stringify(resumedSession)}\n${JSON.stringify(malformedReasoning)}\n${JSON.stringify(validReasoning)}\n${JSON.stringify(encryptedReasoning)}\n${JSON.stringify(compacted)}\n${JSON.stringify({ type: 'event_msg', payload: { text: '"model_provider":"openai"' } })}\n`, 'utf8');
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
  } finally {
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
    assert.equal(report.encryptedReplayItems, 4);
    assert.equal(report.sanitizedReasoningItems, 2);
    assert.equal(report.convertedCompactionItems, 1);
    assert.equal(report.removedCompactionItems, 1);
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.equal((text.match(/"type":"session_meta"/g) || []).length, 2);
    assert.equal((text.match(/"model_provider":"custom"/g) || []).length, 2);
    assert.doesNotMatch(text, /rs_missing/);
    assert.doesNotMatch(text, /rs_encrypted/);
    assert.doesNotMatch(text, /gAAAA_provider_specific/);
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
    assert.equal(report.encryptedReplayItems, 4);
    assert.equal(report.historyItemsRemoved, 1);
    assert.equal(report.sanitizedReasoningItems, 2);
    assert.equal(report.convertedCompactionItems, 1);
    assert.equal(report.removedCompactionItems, 1);
    assert.equal(report.verified, true);
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.match(text, /"model_provider":"openai"/);
    assert.match(text, /"model_provider":"codex"/);
    assert.doesNotMatch(text, /gAAAA_provider_specific/);
    assert.match(text, /Nested visible summary/);
  } finally {
    fs.rmSync(testFixture.root, { recursive: true, force: true });
  }
});
