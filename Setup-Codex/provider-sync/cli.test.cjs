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
