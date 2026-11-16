'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = path.join(__dirname, 'cli.cjs');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('help exposes encrypted history repair', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--repair-encrypted/);
  assert.match(result.stdout, /--repair-replay/);
  assert.match(result.stdout, /--all --to openai/);
});

test('all-chat migration rejects ambiguous filters before filesystem access', () => {
  for (const args of [['--all'], ['--all', '--to', 'openai', '--session-id', 'x'], ['--all', '--to', 'openai', '--from', 'codex']]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--all requires --to/);
  }
});

test('repository entrypoints use the standalone synchronizer', () => {
  const root = path.resolve(__dirname, '..', '..');
  const packageJson = require(path.join(root, 'package.json'));
  assert.equal(packageJson.scripts['provider-retag'], 'node Setup-Codex/provider-sync/cli.cjs');
  if (process.platform !== 'win32') return;
  const result = spawnSync('cmd.exe', ['/d', '/c', path.join(root, 'Run-CodexProviderRetag.cmd'), '--help'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex provider session synchronizer/);
});

test('incompatible repair and migration flags fail before filesystem access', () => {
  const result = runCli([
    '--repair-encrypted',
    '--from', 'openai',
    '--to', 'codex',
    '--codex-home', path.join(__dirname, 'missing-codex-home'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/i);
  assert.doesNotMatch(result.stderr, /Codex home does not exist/i);
});

test('repair-all rejects a session filter before filesystem access', () => {
  const result = runCli([
    '--repair-all',
    '--session-id', 'session-a',
    '--codex-home', path.join(__dirname, 'missing-codex-home'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/i);
  assert.doesNotMatch(result.stderr, /Codex home does not exist/i);
});
