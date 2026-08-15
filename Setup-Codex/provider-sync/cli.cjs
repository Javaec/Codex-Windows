#!/usr/bin/env node
'use strict';

const {
  formatInventory,
  resolveCodexHome,
  resolveStateDb,
  scanInventory,
  syncProvider,
} = require('./provider-sync.cjs');

function usage() {
  console.log(`Codex provider session synchronizer

Read-only status:
  Run-Codex-Provider-Sync.cmd --status

Preview all sessions from one provider:
  Run-Codex-Provider-Sync.cmd --from openai --to codex --dry-run

Apply the migration (close Codex first):
  Run-Codex-Provider-Sync.cmd --from openai --to codex --yes

Apply to exactly one session:
  Run-Codex-Provider-Sync.cmd --session-id ID --from openai --to codex --yes

During apply, all session_meta provider records are normalized and known empty reasoning items
that can make cross-provider compaction fail are removed after the backup is created.

Repair one history without changing its provider:
  Run-Codex-Provider-Sync.cmd --repair-history --session-id ID --yes

Options:
  --codex-home PATH       Codex home (default: CODEX_HOME or %USERPROFILE%\\.codex)
  --state-db PATH         Explicit state_5.sqlite path
  --from ID[,ID]          Source provider ID(s)
  --to ID                 Target provider ID
  --session-id ID         Restrict changes to one session
  --backup-root PATH      Backup root (default: <Codex Home>\\backups\\provider-sync)
  --dry-run               Preview only (default unless --yes is supplied)
  --yes                   Apply changes after creating a backup
  --json                  Print machine-readable JSON
  --status                Print provider counts without changing files
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const options = { fromProviders: [], apply: false, status: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value after ${arg}`);
      }
      return argv[index];
    };
    switch (arg) {
      case '--help':
        options.help = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--yes':
        options.apply = true;
        break;
      case '--repair-history':
        options.repairHistory = true;
        break;
      case '--dry-run':
        options.apply = false;
        break;
      case '--codex-home':
        options.codexHome = next();
        break;
      case '--state-db':
        options.stateDbPath = next();
        break;
      case '--from':
        options.fromProviders.push(next());
        break;
      case '--to':
        options.toProvider = next();
        break;
      case '--session-id':
        options.sessionId = next();
        break;
      case '--backup-root':
        options.backupRoot = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.mode) {
    if (value.repairOnly) {
      console.log(`${value.mode}: ${value.historyRepairs} repairable history item(s)`);
      console.log(`Codex home: ${value.codexHome}`);
      if (value.sessionId) console.log(`Session: ${value.sessionId}`);
      if (value.backupDir) console.log(`Backup: ${value.backupDir}`);
      if (value.historyItemsRemoved) console.log(`History items removed: ${value.historyItemsRemoved}`);
      if (value.verified) console.log('Verification: OK');
      return;
    }
    console.log(`${value.mode}: ${value.jsonlChanges} JSONL file(s), ${value.sqliteChanges} SQLite row(s)`);
    console.log(`Codex home: ${value.codexHome}`);
    console.log(`State DB: ${value.stateDbPath}`);
    console.log(`Provider: ${value.fromProviders.join(', ')} -> ${value.toProvider}`);
    if (value.sessionId) console.log(`Session: ${value.sessionId}`);
    if (value.historyRepairs) console.log(`History repair candidates: ${value.historyRepairs}`);
    if (value.historyItemsRemoved) console.log(`History items removed: ${value.historyItemsRemoved}`);
    if (value.mixedSessionMetadata) console.log(`Mixed session_meta files: ${value.mixedSessionMetadata}`);
    if (value.backupDir) console.log(`Backup: ${value.backupDir}`);
    if (value.verified) console.log('Verification: OK');
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const codexHome = resolveCodexHome(options.codexHome);
  const stateDbPath = resolveStateDb(codexHome, options.stateDbPath);
  if (options.status || (!options.repairHistory && (options.fromProviders.length === 0 || !options.toProvider))) {
    print(formatInventory(scanInventory({ codexHome, stateDbPath })), options.json);
    return;
  }
  if (options.repairHistory && (options.fromProviders.length > 0 || options.toProvider)) {
    throw new Error('--repair-history cannot be combined with --from or --to.');
  }
  if (options.apply && !process.argv.includes('--yes')) {
    throw new Error('Applying changes requires --yes.');
  }
  print(syncProvider(options), options.json);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
