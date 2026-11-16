'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { fastStatus, syncAllProviders } = require('./bulk-sync.cjs');

const message = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const reasoning = text => ({ type: 'reasoning', summary: [{ type: 'summary_text', text }], encrypted_content: 'opaque_state' });
const checkpoint = text => ({
  type: 'compacted', payload: {
    message: '', window_number: 4, replacement_history: [message(text), reasoning('Visible thought')],
    replacement_history_metadata: [{ history_sequence: 5 }, { history_sequence: 6 }],
    guardian_history: [reasoning('Guardian thought'), reasoning('')],
  },
});

function fixture(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bulk-'));
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, title TEXT)');
  t.after(() => {
    db.close();
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
  const add = (records, { compressed = false, archived = false, provider = 'codex', historyBase, id = randomUUID(), indexedPlain = false } = {}) => {
    const root = path.join(codexHome, archived ? 'archived_sessions' : 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const plain = path.join(root, `rollout-2026-11-16T10-00-00-${id}.jsonl`);
    const file = compressed ? `${plain}.zst` : plain;
    const header = { type: 'session_meta', payload: { id, session_id: id, model_provider: provider, history_mode: 'paginated' } };
    if (historyBase) header.payload.history_base = historyBase;
    const content = [header, ...records].map((record, ordinal) => JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ordinal, ...record })).join('\n') + '\n';
    fs.writeFileSync(file, compressed ? zstdCompressSync(content) : content);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, provider, indexedPlain ? plain : file, 'Keep my title');
    return { id, file, content };
  };
  const row = id => db.prepare('SELECT * FROM threads WHERE id=?').get(id);
  const records = id => fs.readFileSync(row(id).rollout_path, 'utf8').trim().split('\n').map(JSON.parse);
  return { codexHome, db, add, row, records };
}

test('bulk migration keeps immutable originals and only copies the latest checkpoint and suffix', async t => {
  const f = fixture(t);
  const source = f.add([
    { type: 'response_item', payload: message('Old visible history') },
    checkpoint('Latest context'),
    { type: 'response_item', payload: reasoning('Tail thought 🦀') },
    { type: 'response_item', payload: { type: 'function_call', name: 'ready', call_id: 'call1', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call1', output: 'OK' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1' } },
  ]);
  const target = f.add([], { provider: 'openai' });
  const report = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  assert.equal(report.sqliteChanges, 1);
  assert.equal(report.verified, true);
  assert.equal(fs.readFileSync(source.file, 'utf8'), source.content);
  assert.equal(f.row(source.id).title, 'Keep my title');
  assert.equal(f.row(target.id).rollout_path, target.file);
  const records = f.records(source.id);
  const prefix = source.content.split('\n').slice(0, 2).join('\n') + '\n';
  assert.deepEqual(records[0].payload.history_base, {
    thread_id: source.id, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix),
  });
  assert.equal(records[0].payload.model_provider, 'openai');
  assert.deepEqual(records.map(record => record.ordinal), [2, 3, 4, 5, 6, 7]);
  assert.equal(records[1].payload.replacement_history[1].type, 'message');
  assert.equal(records[1].payload.guardian_history.length, 1);
  assert.equal(records[2].payload.content[0].text, 'Tail thought 🦀');
  assert.equal(records[3].payload.type, 'function_call');
  assert.equal(records[4].payload.type, 'function_call_output');
  assert.equal(records[5].payload.type, 'task_complete');
  assert.ok(fs.existsSync(path.join(report.backupDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(report.backupDir, 'state_5.sqlite')));
  const noOp = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  assert.equal(noOp.sqliteChanges, 0);
  await syncAllProviders({ codexHome: f.codexHome, toProvider: 'codex', apply: true });
  assert.equal(path.basename(f.row(source.id).rollout_path).split('_').length, 2);
});

test('compressed archived rollouts use decoded byte offsets and stale plain index paths', async t => {
  const f = fixture(t);
  const source = f.add([{ type: 'response_item', payload: message('Привет 🦀') }, checkpoint('New')], {
    compressed: true, archived: true, indexedPlain: true,
  });
  const original = fs.readFileSync(source.file);
  const status = fastStatus({ codexHome: f.codexHome });
  assert.equal(status.compressedRollouts, 1);
  assert.equal(status.missingRollouts, 0);
  const report = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  assert.equal(report.compressedRollouts, 1);
  assert.deepEqual(fs.readFileSync(source.file), original);
  assert.equal(path.dirname(f.row(source.id).rollout_path), path.dirname(source.file));
  const prefix = source.content.split('\n').slice(0, 2).join('\n') + '\n';
  assert.equal(f.records(source.id)[0].payload.history_base.end_byte_offset, Buffer.byteLength(prefix));
});

for (const compressed of [false, true]) {
  test(`bulk UTF-8 boundaries, CRLF and a final unterminated record (${compressed ? 'zstd' : 'plain'})`, async t => {
    const f = fixture(t);
    const source = f.add([], { compressed });
    const header = source.content.trimEnd() + '\r\n';
    const item = { ordinal: 1, type: 'response_item', payload: message('') };
    const textOffset = JSON.stringify(item).indexOf('"text":"') + '"text":"'.length;
    const padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(header) - textOffset - 1);
    item.payload = message(padding + '🦀Ж' + 'z'.repeat(1024 * 1024));
    const prefix = header + JSON.stringify(item) + '\r\n \r\n';
    const thought = '🙂Я'.repeat(512 * 1024);
    const content = prefix + JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ordinal: 2, ...checkpoint('Latest') }) + '\r\n'
      + JSON.stringify({ ordinal: 3, type: 'response_item', payload: reasoning(thought) });
    const original = compressed ? zstdCompressSync(content) : Buffer.from(content);
    fs.writeFileSync(source.file, original);
    const report = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
    const records = f.records(source.id);
    assert.equal(records[0].payload.history_base.end_byte_offset, Buffer.byteLength(prefix));
    assert.equal(records[2].payload.content[0].text, thought);
    assert.equal(report.writtenBytes, fs.statSync(f.row(source.id).rollout_path).size);
    assert.deepEqual(fs.readFileSync(source.file), original);
  });
}

for (const compressed of [false, true]) {
  test(`an ancestor checkpoint respects its frozen cutoff (${compressed ? 'zstd' : 'plain'})`, async t => {
    const f = fixture(t);
    const ancestor = f.add([checkpoint('Frozen context'), { type: 'response_item', payload: message('Frozen tail') }], { compressed, provider: 'openai' });
    const child = f.add([{ type: 'response_item', payload: reasoning('Child thought') }], { historyBase: {
      thread_id: ancestor.id, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(ancestor.content),
    } });
    const content = ancestor.content + JSON.stringify({ timestamp: '2026-11-16T11:00:00Z', ordinal: 3, ...checkpoint('Too new') }) + '\n';
    fs.writeFileSync(ancestor.file, compressed ? zstdCompressSync(content) : content);
    await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
    const records = f.records(child.id);
    assert.equal(records[1].payload.replacement_history[0].content[0].text, 'Frozen context');
    assert.equal(records[2].payload.content[0].text, 'Frozen tail');
    assert.equal(records[3].payload.content[0].text, 'Child thought');
    assert.equal(records[0].payload.history_base.thread_id, ancestor.id);
  });
}

test('reverse lookup finds a checkpoint header split across blocks and ignores nested markers', async t => {
  const f = fixture(t);
  const source = f.add([{ type: 'response_item', payload: message('x'.repeat(2 * 1024 * 1024)) }]);
  const compacted = JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ordinal: 2, ...checkpoint('Latest') }) + '\n';
  const nested = JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ordinal: 3, type: 'event_msg', payload: checkpoint('Nested data') }) + '\n';
  const last = { ordinal: 4, type: 'response_item', payload: message('') };
  const initialSize = Buffer.byteLength(source.content + compacted + nested + JSON.stringify(last) + '\n');
  const blockStart = Buffer.byteLength(source.content) + compacted.indexOf('"type":"compacted"') + 8;
  const padding = blockStart + 1024 * 1024 - initialSize;
  last.payload = message('z'.repeat(padding));
  fs.writeFileSync(source.file, source.content + compacted + nested + JSON.stringify(last) + '\n');
  await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  const records = f.records(source.id);
  assert.equal(records[0].payload.history_base.end_byte_offset, Buffer.byteLength(source.content));
  assert.equal(records[1].payload.replacement_history[0].content[0].text, 'Latest');
  assert.equal(records[2].payload.type, 'compacted');
  assert.equal(records[3].payload.content[0].text.length, padding);
});

test('forward replay still chooses a newer noncanonical checkpoint', async t => {
  const f = fixture(t);
  const source = f.add([checkpoint('Older')]);
  const newer = JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ordinal: 2, ...checkpoint('Newer') })
    .replace('"type":"compacted"', '"type": "compacted"');
  fs.appendFileSync(source.file, newer + '\n');
  await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  const records = f.records(source.id);
  assert.equal(records[0].payload.history_base.end_byte_offset, Buffer.byteLength(source.content));
  assert.equal(records[1].payload.replacement_history[0].content[0].text, 'Newer');
});

for (const hasCheckpoint of [false, true]) {
  test(`large session metadata is preserved (${hasCheckpoint ? 'checkpoint' : 'full history'})`, async t => {
    const f = fixture(t);
    const source = f.add([...(hasCheckpoint ? [checkpoint('Latest')] : []), { type: 'response_item', payload: message('Last message') }]);
    const records = source.content.trimEnd().split('\n').map(JSON.parse);
    records[0].payload.base_instructions = { text: 'x'.repeat(2 * 1024 * 1024) };
    fs.writeFileSync(source.file, records.map(JSON.stringify).join('\n'));
    await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
    const rewritten = f.records(source.id);
    assert.equal(rewritten[0].payload.base_instructions.text.length, 2 * 1024 * 1024);
    assert.equal(rewritten.at(-1).payload.content[0].text, 'Last message');
    assert.equal(Boolean(rewritten[0].payload.history_base), hasCheckpoint);
  });
}

for (const compressed of [false, true]) {
  test(`an incomplete checkpoint leaves the database and original file unchanged (${compressed ? 'zstd' : 'plain'})`, async t => {
    const f = fixture(t);
    const source = f.add([{ type: 'compacted', payload: { message: '', window_number: 1 } }], { compressed });
    const original = fs.readFileSync(source.file);
    await assert.rejects(syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true }), /no replacement_history/);
    assert.equal(f.row(source.id).rollout_path, source.file);
    assert.equal(f.row(source.id).model_provider, 'codex');
    assert.deepEqual(fs.readFileSync(source.file), original);
    assert.equal(fs.readdirSync(path.dirname(source.file)).length, 1);
  });
}

test('status and preview avoid parsing histories, and missing histories are reported explicitly', async t => {
  const f = fixture(t);
  const broken = f.add([]);
  fs.writeFileSync(broken.file, 'not JSON');
  const missing = f.add([]);
  fs.unlinkSync(missing.file);
  const preview = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai' });
  assert.deepEqual(preview.missingRollouts, [missing.id]);
  assert.equal(preview.sqliteChanges, 2);
  assert.equal(fastStatus({ codexHome: f.codexHome }).sqliteThreads, 2);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'backups')), false);
  await assert.rejects(syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true }), /JSON/);
  assert.equal(f.row(broken.id).model_provider, 'codex');
  assert.equal(f.row(missing.id).model_provider, 'codex');
  fs.unlinkSync(broken.file);
  const report = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true });
  assert.equal(report.missingRollouts.length, 2);
  assert.equal(f.row(missing.id).model_provider, 'openai');
});

test('preview and an already selected provider ignore unrelated rollout directories', async t => {
  const f = fixture(t);
  const source = f.add([checkpoint('Context')]);
  fs.writeFileSync(path.join(f.codexHome, 'archived_sessions'), 'Unrelated invalid directory');
  const preview = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai' });
  assert.equal(preview.sqliteChanges, 1);
  assert.equal(preview.sourceBytes, Buffer.byteLength(source.content));
  const noOp = await syncAllProviders({ codexHome: f.codexHome, toProvider: 'codex', apply: true });
  assert.equal(noOp.sqliteChanges, 0);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'backups')), false);
  assert.equal(f.row(source.id).rollout_path, source.file);
});

test('status counts provider IDs that match object prototype properties', t => {
  const f = fixture(t);
  f.add([], { provider: 'constructor' });
  f.add([], { provider: '__proto__' });
  const providers = fastStatus({ codexHome: f.codexHome }).databaseProviders;
  assert.equal(Object.keys(providers).length, 2);
  assert.equal(providers.constructor, 1);
  assert.equal(providers.__proto__, 1);
});

test('concurrent changes roll back every pointer and remove unpublished continuation files', async t => {
  const f = fixture(t);
  const first = f.add([checkpoint('First')]);
  const second = f.add([checkpoint('Second')]);
  await assert.rejects(syncAllProviders({
    codexHome: f.codexHome, toProvider: 'openai', apply: true,
    onProgress: () => f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('other', first.id),
  }), /changed during migration/);
  assert.equal(f.row(second.id).rollout_path, second.file);
  assert.equal(f.row(second.id).model_provider, 'codex');
  assert.equal(fs.readdirSync(path.dirname(first.file)).length, 2);
  assert.equal(fs.readFileSync(first.file, 'utf8'), first.content);
});

test('source writes after preparation cancel publication', async t => {
  const f = fixture(t);
  const source = f.add([checkpoint('Context')]);
  await assert.rejects(syncAllProviders({
    codexHome: f.codexHome, toProvider: 'openai', apply: true,
    onProgress: () => fs.appendFileSync(source.file, JSON.stringify({ type: 'response_item', payload: message('New turn') }) + '\n'),
  }), /Rollout changed/);
  assert.equal(f.row(source.id).rollout_path, source.file);
  assert.equal(f.row(source.id).model_provider, 'codex');
  assert.equal(fs.readdirSync(path.dirname(source.file)).length, 1);
});

test('a failed worker cancels the batch and removes unpublished output from both workers', async t => {
  const f = fixture(t);
  const broken = f.add([]);
  const valid = f.add([checkpoint('Context'), { type: 'response_item', payload: message('x'.repeat(4 * 1024 * 1024)) }]);
  fs.writeFileSync(broken.file, 'invalid JSON');
  await assert.rejects(syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true }), /JSON/);
  assert.equal(f.row(broken.id).model_provider, 'codex');
  assert.equal(f.row(valid.id).rollout_path, valid.file);
  assert.equal(fs.readdirSync(path.dirname(valid.file)).length, 2);
});

test('an invalid rollout record cancels publication instead of silently removing data', async t => {
  const f = fixture(t);
  const source = f.add([checkpoint('Context')]);
  fs.appendFileSync(source.file, 'null\n');
  await assert.rejects(syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true }), /record has no type/);
  assert.equal(f.row(source.id).rollout_path, source.file);
  assert.equal(f.row(source.id).model_provider, 'codex');
  assert.equal(fs.readdirSync(path.dirname(source.file)).length, 1);
});

test('bulk migration refuses a Windows writer lock before creating backups', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const source = f.add([checkpoint('Context')]);
  const lock = path.join(f.codexHome, 'thread-writer-locks', `${source.id}.lock`);
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, '');
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command',
    "$lock = [IO.File]::Open($env:PROVIDER_SYNC_TEST_LOCK, 'Open', 'ReadWrite', 'ReadWrite'); $lock.Lock(0, 1); [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $lock.Dispose()",
  ], { env: { ...process.env, PROVIDER_SYNC_TEST_LOCK: lock }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = once(child, 'exit');
  try {
    const [ready] = await once(child.stdout, 'data');
    assert.match(ready.toString(), /locked/);
    await assert.rejects(syncAllProviders({ codexHome: f.codexHome, toProvider: 'openai', apply: true }), /Unload chat/);
    assert.equal(fs.existsSync(path.join(f.codexHome, 'backups')), false);
    assert.equal(f.row(source.id).rollout_path, source.file);
  } finally {
    child.stdin.end('\n');
    await finished;
  }
});
