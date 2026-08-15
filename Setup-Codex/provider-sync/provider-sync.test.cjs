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
  const archived = { type: 'session_meta', payload: { id: 'session-b', model_provider: 'custom', cwd: 'C:\\work' } };
  fs.writeFileSync(sessionPath, `${JSON.stringify(session)}\n${JSON.stringify({ type: 'event_msg', payload: { text: '"model_provider":"openai"' } })}\n`, 'utf8');
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
    const text = fs.readFileSync(testFixture.sessionPath, 'utf8');
    assert.match(text, /"model_provider":"custom"/);
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
