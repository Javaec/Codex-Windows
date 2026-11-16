#!/usr/bin/env node
'use strict';

const {
  formatInventory,
  resolveCodexHome,
  resolveStateDb,
  scanInventory,
  syncProvider,
} = require('./provider-sync.cjs');
const { fastStatus, syncAllProviders } = require('./bulk-sync.cjs');

function usage() {
  console.log(`Codex provider session synchronizer

Read-only status:
  Run-Codex-Provider-Sync.cmd --status

Preview all sessions from one provider:
  Run-Codex-Provider-Sync.cmd --from openai --to codex --dry-run

Apply the migration (close Codex first):
  Run-Codex-Provider-Sync.cmd --from openai --to codex --yes

Switch all indexed chats, including compressed and archived histories:
  Run-Codex-Provider-Sync.cmd --all --to openai --yes

Apply to exactly one session:
  Run-Codex-Provider-Sync.cmd --session-id ID --from openai --to codex --yes

During migration, all session_meta provider records are normalized. Visible reasoning becomes
ordinary text; empty reasoning is removed, including nested replay histories. Every write has a backup.

Repair one history without changing its provider:
  Run-Codex-Provider-Sync.cmd --repair-history --session-id ID --yes

Repair all active and archived histories:
  Run-Codex-Provider-Sync.cmd --repair-all --dry-run
  Run-Codex-Provider-Sync.cmd --repair-all --yes

Repair provider-specific replay state, including summary-only reasoning:
  Run-Codex-Provider-Sync.cmd --repair-replay --session-id ID --yes
  Run-Codex-Provider-Sync.cmd --repair-encrypted --session-id ID --yes
  Run-Codex-Provider-Sync.cmd --repair-encrypted --dry-run

Options:
  --codex-home PATH       Codex home (default: CODEX_HOME or %USERPROFILE%\\.codex)
  --state-db PATH         Explicit state_5.sqlite path
  --from ID[,ID]          Source provider ID(s)
  --all                  Select every provider except the target
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
      case '--all':
        options.all = true;
        break;
      case '--repair-history':
        options.repairHistory = true;
        break;
      case '--repair-replay':
      case '--repair-encrypted':
        options.repairHistory = true;
        options.repairEncrypted = true;
        break;
      case '--repair-all':
        options.repairHistory = true;
        options.repairAll = true;
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
  if (json || !value.mode) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.replayRepairItems) console.log(`Provider replay candidates: ${value.replayRepairItems}`);
  if (value.strategy) console.log(`Strategy: ${value.strategy}`);
  if (value.writtenBytes !== undefined) console.log(`New continuation bytes: ${value.writtenBytes}`);
  if (value.missingRollouts?.length) console.log(`Missing histories (provider metadata only): ${value.missingRollouts.length}`);
  if (value.historyThreadsReset) console.log(`History projections reset: ${value.historyThreadsReset} (rebuilt when the chat resumes)`);
  if (value.repairOnly) {
    console.log(`${value.mode}: ${value.historyRepairs} repairable history item(s)`);
  } else {
    console.log(`${value.mode}: ${value.jsonlChanges} JSONL file(s), ${value.sqliteChanges} SQLite row(s)`);
  }
  console.log(`Codex home: ${value.codexHome}`);
  if (!value.repairOnly) {
    console.log(`State DB: ${value.stateDbPath}`);
    console.log(`Provider: ${value.fromProviders.join(', ')} -> ${value.toProvider}`);
    if (value.historyRepairs) console.log(`History repair candidates: ${value.historyRepairs}`);
    if (value.mixedSessionMetadata) console.log(`Mixed session_meta files: ${value.mixedSessionMetadata}`);
  }
  if (value.sessionId) console.log(`Session: ${value.sessionId}`);
  if (value.repairEncrypted || value.encryptedReplayItems) console.log(`Encrypted replay candidates: ${value.encryptedReplayItems}`);
  if (value.repairEncrypted || value.plaintextCompactionItems) console.log(`Plaintext compaction candidates: ${value.plaintextCompactionItems}`);
  if (value.repairEncrypted || value.opaqueCompactionItems) console.log(`Opaque compaction candidates: ${value.opaqueCompactionItems}`);
  if (value.backupDir) console.log(`Backup: ${value.backupDir}`);
  if (value.historyItemsRemoved) console.log(`History items removed: ${value.historyItemsRemoved}`);
  if (value.sanitizedReasoningItems) console.log(`Reasoning items converted to messages: ${value.sanitizedReasoningItems}`);
  if (value.convertedCompactionItems) console.log(`Compaction items converted: ${value.convertedCompactionItems}`);
  if (value.removedCompactionItems) console.log(`Opaque compaction items removed: ${value.removedCompactionItems}`);
  if (value.verified) console.log('Verification: OK');
}

function validateOptions(options) {
  if (options.all && (options.sessionId || options.repairHistory || options.fromProviders.length || !options.toProvider)) {
    throw new Error('--all requires --to and cannot be combined with --session-id, --from, or history repair.');
  }
  if (options.repairHistory && (options.fromProviders.length > 0 || options.toProvider)) {
    throw new Error('--repair-history/--repair-replay/--repair-encrypted cannot be combined with --from or --to.');
  }
  if (options.repairAll && options.sessionId) {
    throw new Error('--repair-all cannot be combined with --session-id.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  validateOptions(options);
  const codexHome = resolveCodexHome(options.codexHome);
  const stateDbPath = resolveStateDb(codexHome, options.stateDbPath);
  if (options.status || (!options.repairHistory && ((!options.all && options.fromProviders.length === 0) || !options.toProvider))) {
    print(options.sessionId
      ? formatInventory(scanInventory({ codexHome, stateDbPath, sessionId: options.sessionId }))
      : fastStatus({ codexHome, stateDbPath }), options.json);
    return;
  }
  if (!options.sessionId && !options.repairHistory) {
    if (!options.json) options.onProgress = (done, total) => process.stderr.write(`\rPreparing continuations: ${done}/${total}${done === total ? '\n' : ''}`);
    print(await syncAllProviders(options), options.json);
  } else {
    print(syncProvider(options), options.json);
  }
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
