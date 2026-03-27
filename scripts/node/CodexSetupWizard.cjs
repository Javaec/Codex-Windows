#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.codex-backups');
const RECENT_BACKUP_WINDOW_MS = 3 * 60 * 60 * 1000;
const DEFAULTS_KEY_ORDER = [
  'model',
  'model_context_window',
  'model_auto_compact_token_limit',
  'model_reasoning_effort',
  'personality',
  'approval_policy',
  'sandbox_mode',
];

function color(text, ansi) {
  if (!process.stdout.isTTY) {
    return text;
  }

  return `${ansi}${text}${ANSI.reset}`;
}

function banner(text, ansi = ANSI.cyan) {
  const line = '='.repeat(78);
  console.log('');
  console.log(color(line, ANSI.gray));
  console.log(color(text, ansi));
  console.log(color(line, ANSI.gray));
}

function status(level, message) {
  const ansi = {
    INFO: ANSI.cyan,
    OK: ANSI.green,
    WARN: ANSI.yellow,
    ERROR: ANSI.red,
  }[level] || ANSI.reset;

  console.log(color(`[${level}] ${message}`, ansi));
}

function fail(message) {
  banner('Failure', ANSI.red);
  status('ERROR', message);
  process.exit(1);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderProgress(activity, current, total, detail = '') {
  const width = 28;
  const safeTotal = total > 0 ? total : 1;
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const filled = Math.round(ratio * width);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  const percent = String(Math.round(ratio * 100)).padStart(3, ' ');
  const suffix = detail ? ` ${detail}` : '';
  process.stdout.write(`\r${activity.padEnd(26)} [${bar}] ${percent}%${suffix}`);
  if (current >= total) {
    process.stdout.write('\n');
  }
}

function createSpinner(text) {
  let timer = null;
  let frameIndex = 0;
  const startedAt = Date.now();

  return {
    start() {
      if (!process.stdout.isTTY) {
        console.log(text);
        return;
      }

      timer = setInterval(() => {
        const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
        frameIndex += 1;
        const elapsed = formatDuration(Date.now() - startedAt);
        process.stdout.write(`\r${frame} ${text} ${color(`(${elapsed})`, ANSI.gray)}   `);
      }, 120);
    },
    stop(finalText) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (process.stdout.isTTY) {
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(120));
        process.stdout.write('\r');
      }

      if (finalText) {
        console.log(finalText);
      }
    },
  };
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toWindowsNewlines(text) {
  return normalizeNewlines(text).replace(/\n/g, '\r\n');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeTopLevelKey(text, key) {
  const pattern = new RegExp(`^[ \\t]*${escapeRegex(key)}[ \\t]*=[^\\n]*(?:\\n|$)`, 'gm');
  return text.replace(pattern, '');
}

function removeTomlSection(text, sectionName) {
  const lines = normalizeNewlines(text).split('\n');
  const result = [];
  const header = `[${sectionName}]`;
  let skip = false;

  for (const line of lines) {
    if (!skip && line.trim() === header) {
      skip = true;
      continue;
    }

    if (skip) {
      if (/^\s*\[/.test(line) || /^\s*#\[/.test(line) || /^\s*#\s*model_provider\s*=/.test(line)) {
        skip = false;
      } else {
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

function ensureExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${description} not found: ${filePath}`);
  }
}

function parseArgs(argv) {
  const options = {
    configPath: '',
    codexHome: process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'),
    backupDir: DEFAULT_BACKUP_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      index += 1;
      options.configPath = path.resolve(String(argv[index] || ''));
      continue;
    }

    if (arg === '--codex-home') {
      index += 1;
      options.codexHome = path.resolve(argv[index]);
      continue;
    }

    if (arg === '--backup-dir') {
      index += 1;
      options.backupDir = path.resolve(argv[index]);
      continue;
    }
  }

  return options;
}

function readSetupConfig(configPath) {
  ensureExists(configPath, 'Setup config');
  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Setup config is not valid JSON: ${configPath}`);
  }

  const provider = parsed && typeof parsed === 'object' ? parsed.provider : null;
  const defaults = parsed && typeof parsed === 'object' ? parsed.defaults : null;

  if (!provider || typeof provider !== 'object') {
    throw new Error(`Setup config must contain object field "provider".`);
  }

  if (!provider.id || typeof provider.id !== 'string') {
    throw new Error(`Setup config must contain string field "provider.id".`);
  }

  if (!provider.name || typeof provider.name !== 'string') {
    throw new Error(`Setup config must contain string field "provider.name".`);
  }

  if (!provider.wireApi || typeof provider.wireApi !== 'string') {
    throw new Error(`Setup config must contain string field "provider.wireApi".`);
  }

  if (typeof provider.supportsWebsockets !== 'boolean') {
    throw new Error(`Setup config must contain boolean field "provider.supportsWebsockets".`);
  }

  if (!defaults || typeof defaults !== 'object') {
    throw new Error(`Setup config must contain object field "defaults".`);
  }

  for (const key of DEFAULTS_KEY_ORDER) {
    if (!(key in defaults)) {
      throw new Error(`Setup config is missing defaults.${key}`);
    }
  }

  return {
    provider: {
      id: provider.id,
      name: provider.name,
      wireApi: provider.wireApi,
      supportsWebsockets: provider.supportsWebsockets,
    },
    defaults,
  };
}

async function listFilesRecursive(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) {
    return out;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }

  out.sort((left, right) => left.localeCompare(right));
  return out;
}

async function runProcessCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function tryTarZip(sourceParentDir, sourceDirName, zipPath) {
  return runProcessCapture('tar.exe', ['-a', '-c', '-f', zipPath, '-C', sourceParentDir, sourceDirName]);
}

async function tryPowerShellDotNetZip(sourceDir, zipPath) {
  return runProcessCapture('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
      `if (Test-Path -LiteralPath '${zipPath.replace(/'/g, "''")}') { Remove-Item -LiteralPath '${zipPath.replace(/'/g, "''")}' -Force }`,
      `[System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
    ].join(' '),
  ]);
}

async function tryPowerShellCompressArchive(sourceDir, zipPath) {
  return runProcessCapture('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ]);
}

async function createZipArchive(sourceDir, zipPath) {
  const attempts = [
    {
      name: 'tar.exe',
      run: () => tryTarZip(path.dirname(sourceDir), path.basename(sourceDir), zipPath),
    },
    {
      name: 'PowerShell ZipFile',
      run: () => tryPowerShellDotNetZip(sourceDir, zipPath),
    },
    {
      name: 'Compress-Archive',
      run: () => tryPowerShellCompressArchive(sourceDir, zipPath),
    },
  ];

  const failures = [];
  for (const attempt of attempts) {
    if (fs.existsSync(zipPath)) {
      await fsp.rm(zipPath, { force: true });
    }

    const result = await attempt.run();
    if (result.code === 0 && fs.existsSync(zipPath)) {
      return attempt.name;
    }

    failures.push(`${attempt.name}: ${(result.stderr || result.stdout || `exit code ${result.code}`).trim()}`);
  }

  throw new Error(`Backup archive creation failed. ${failures.join(' | ')}`);
}

async function findRecentBackupZip(backupDir) {
  if (!fs.existsSync(backupDir)) {
    return null;
  }

  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const now = Date.now();
  let newest = null;

  for (const entry of entries) {
    if (!entry.isFile() || !/^codex-setup-.*\.zip$/i.test(entry.name)) {
      continue;
    }

    const fullPath = path.join(backupDir, entry.name);
    const stat = await fsp.stat(fullPath);
    if ((now - stat.mtimeMs) > RECENT_BACKUP_WINDOW_MS) {
      continue;
    }

    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: fullPath, mtimeMs: stat.mtimeMs };
    }
  }

  return newest;
}

async function createBackupArchive(codexHome, backupDir) {
  await fsp.mkdir(backupDir, { recursive: true });
  const recentBackup = await findRecentBackupZip(backupDir);
  if (recentBackup) {
    banner('Reusing recent backup archive', ANSI.yellow);
    status('INFO', `Backup age: ${formatDuration(Date.now() - recentBackup.mtimeMs)}`);
    status('OK', `Backup archive: ${recentBackup.path}`);
    return recentBackup.path;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const zipPath = path.join(backupDir, `codex-setup-${stamp}.zip`);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-setup-'));
  const stageRoot = path.join(tempRoot, 'codex-home-snapshot');

  await fsp.mkdir(stageRoot, { recursive: true });

  try {
    const files = await listFilesRecursive(codexHome);
    banner('Creating backup archive', ANSI.yellow);
    status('INFO', `Staging ${files.length} files from ${codexHome}`);

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      const relativePath = path.relative(codexHome, filePath);
      const destination = path.join(stageRoot, relativePath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(filePath, destination);
      renderProgress('Backup snapshot', index + 1, files.length || 1, relativePath);
    }

    const spinner = createSpinner('Compressing backup archive');
    spinner.start();
    let archiveMethod = '';
    try {
      archiveMethod = await createZipArchive(stageRoot, zipPath);
    } finally {
      spinner.stop();
    }

    status('OK', `Backup archive created with ${archiveMethod}: ${zipPath}`);
    return zipPath;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function writeAuthJson(authPath, apiKey) {
  const authContent = `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`;
  fs.writeFileSync(authPath, authContent, 'utf8');
}

function serializeTomlValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Numeric TOML values must be finite.');
    }

    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  throw new Error(`Unsupported TOML value type: ${typeof value}`);
}

function buildDefaultsBlock(defaults) {
  const seen = new Set();
  const lines = [];

  for (const key of DEFAULTS_KEY_ORDER) {
    lines.push(`${key} = ${serializeTomlValue(defaults[key])}`);
    seen.add(key);
  }

  for (const key of Object.keys(defaults)) {
    if (seen.has(key)) {
      continue;
    }

    lines.push(`${key} = ${serializeTomlValue(defaults[key])}`);
  }

  return lines.join('\n');
}

function updateConfigToml(configPath, setupConfig) {
  let existingConfig = '';
  if (fs.existsSync(configPath)) {
    existingConfig = normalizeNewlines(fs.readFileSync(configPath, 'utf8'));
  }

  for (const key of [
    ...Object.keys(setupConfig.defaults),
    'model_provider',
  ]) {
    existingConfig = removeTopLevelKey(existingConfig, key);
  }

  existingConfig = removeTomlSection(existingConfig, `model_providers.${setupConfig.provider.id}`);
  existingConfig = existingConfig.trim();

  const providerBlock = [
    `model_provider = ${serializeTomlValue(setupConfig.provider.id)}`,
    `[model_providers.${setupConfig.provider.id}]`,
    `name = ${serializeTomlValue(setupConfig.provider.name)}`,
    `base_url = ${serializeTomlValue(setupConfig.provider.baseUrl)}`,
    `wire_api = ${serializeTomlValue(setupConfig.provider.wireApi)}`,
    `supports_websockets = ${serializeTomlValue(setupConfig.provider.supportsWebsockets)}`,
  ].join('\n');

  let newConfig = `${buildDefaultsBlock(setupConfig.defaults)}\n\n${providerBlock}`;
  if (existingConfig) {
    newConfig += `\n\n${existingConfig}`;
  }
  newConfig += '\n';

  fs.writeFileSync(configPath, toWindowsNewlines(newConfig), 'utf8');
}

async function scanSessions(sessionsRoot) {
  const entries = [];
  const allFiles = await listFilesRecursive(sessionsRoot);
  const jsonlFiles = allFiles.filter((filePath) => filePath.toLowerCase().endsWith('.jsonl'));
  const providerRegex = /"model_provider":"([^"]+)"/;

  banner('Scanning JSONL sessions', ANSI.cyan);
  for (let index = 0; index < jsonlFiles.length; index += 1) {
    const filePath = jsonlFiles[index];
    const relativePath = path.relative(sessionsRoot, filePath);
    const text = await fsp.readFile(filePath, 'utf8');
    const match = providerRegex.exec(text);
    entries.push({
      filePath,
      relativePath,
      provider: match ? match[1] : '',
    });
    renderProgress('Scanning sessions', index + 1, jsonlFiles.length || 1, relativePath);
  }

  return entries;
}

async function findStateDatabases(codexHome) {
  if (!fs.existsSync(codexHome)) {
    return [];
  }

  const entries = await fsp.readdir(codexHome, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
    .map((entry) => path.join(codexHome, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function collectProviderCountsFromSessions(sessionEntries) {
  const counts = new Map();
  for (const entry of sessionEntries) {
    const provider = entry.provider || '(missing)';
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }

  return counts;
}

function collectProviderCountsFromSqlite(dbPaths) {
  const counts = new Map();

  for (const dbPath of dbPaths) {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      const rows = db.prepare('SELECT COALESCE(model_provider, \'\') AS provider, COUNT(*) AS count FROM threads GROUP BY model_provider').all();
      for (const row of rows) {
        const provider = row.provider || '(missing)';
        counts.set(provider, (counts.get(provider) || 0) + Number(row.count || 0));
      }
    } finally {
      db.close();
    }
  }

  return counts;
}

function providerCount(providerCounts, providerName) {
  return Number(providerCounts.get(providerName) || 0);
}

function printProviderSummary(providerCounts, sourceLabel) {
  banner(`Detected providers (${sourceLabel})`, ANSI.cyan);

  const rows = [...providerCounts.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider));

  if (rows.length === 0) {
    status('WARN', 'No provider-tagged chats were found.');
    return;
  }

  for (const row of rows) {
    console.log(`  ${color(row.provider, ANSI.bold)}: ${color(String(row.count), ANSI.green)} ${row.count === 1 ? 'chat' : 'chats'}`);
  }
}

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    },
    close() {
      rl.close();
    },
  };
}

function normalizeEndpointInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Endpoint cannot be empty.');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsedUrl;
  try {
    parsedUrl = new URL(withScheme);
  } catch (error) {
    throw new Error(`Invalid endpoint: ${trimmed}`);
  }

  if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
    parsedUrl.pathname = '/v1';
  }

  if (parsedUrl.pathname.length > 1 && parsedUrl.pathname.endsWith('/')) {
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');
  }

  return parsedUrl.toString().replace(/\/$/, '');
}

async function promptConnectionDetails(prompt, setupConfig) {
  const endpointAnswer = await prompt.ask(
    color(`Enter endpoint ${color('(example: http://144.31.220.80:20300/v1)', ANSI.gray)}: `, ANSI.cyan),
  );
  const apiKeyAnswer = await prompt.ask(color('Enter API key: ', ANSI.cyan));

  const baseUrl = normalizeEndpointInput(endpointAnswer);
  const apiKey = String(apiKeyAnswer || '').trim();
  if (!apiKey) {
    throw new Error('API key cannot be empty.');
  }

  return {
    ...setupConfig,
    apiKey,
    provider: {
      ...setupConfig.provider,
      baseUrl,
    },
  };
}

async function chooseProviders(prompt, providerCounts) {
  const targetProvider = prompt.targetProvider;
  const rows = [...providerCounts.entries()]
    .map(([provider, count]) => ({ provider, count: Number(count || 0) }))
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider));
  const selectableRows = rows.filter((row) => row.provider !== targetProvider);
  const totalChats = rows.reduce((sum, row) => sum + row.count, 0);
  const convertibleChats = selectableRows.reduce((sum, row) => sum + row.count, 0);

  console.log('');
  if (selectableRows.length === 0) {
    console.log(`  1. Convert all chats -> ${color(targetProvider, ANSI.green)} (${totalChats} chats total, 0 need changes)`);
    console.log('  0. Cancel');

    const answer = await prompt.ask(color('Select an option: ', ANSI.cyan));
    if (answer === '0') {
      return null;
    }

    if (answer === '1') {
      return [];
    }

    throw new Error('Unknown menu option.');
  }

  selectableRows.forEach((row, index) => {
    console.log(`  ${index + 1}. Replace ${color(row.provider, ANSI.bold)} -> ${color(targetProvider, ANSI.green)} (${row.count} chats)`);
  });

  const convertAllOption = selectableRows.length + 1;
  console.log(`  ${convertAllOption}. Convert all chats -> ${color(targetProvider, ANSI.green)} (${totalChats} chats total, ${convertibleChats} need changes)`);
  console.log('  0. Cancel');

  const answer = await prompt.ask(color('Select an option: ', ANSI.cyan));
  if (answer === '0') {
    return null;
  }

  const choice = Number.parseInt(answer, 10);
  if (!Number.isInteger(choice) || choice < 1 || choice > convertAllOption) {
    throw new Error('Unknown menu option.');
  }

  if (choice === convertAllOption) {
    return selectableRows.map((row) => row.provider);
  }

  return [selectableRows[choice - 1].provider];
}

async function retagSessionFiles(sessionEntries, fromProviders, toProvider) {
  let updated = 0;
  const matchingEntries = sessionEntries.filter((entry) => fromProviders.includes(entry.provider));

  banner('Updating JSONL session files', ANSI.cyan);
  for (let index = 0; index < matchingEntries.length; index += 1) {
    const entry = matchingEntries[index];
    let text = await fsp.readFile(entry.filePath, 'utf8');
    let changed = false;

    for (const provider of fromProviders) {
      const fromText = `"model_provider":"${provider}"`;
      const toText = `"model_provider":"${toProvider}"`;
      if (text.includes(fromText)) {
        text = text.split(fromText).join(toText);
        changed = true;
      }
    }

    if (changed) {
      await fsp.writeFile(entry.filePath, text, 'utf8');
      updated += 1;
    }

    renderProgress('Updating sessions', index + 1, matchingEntries.length || 1, entry.relativePath);
  }

  return { scanned: matchingEntries.length, updated };
}

function retagSqliteFiles(dbPaths, fromProviders, toProvider) {
  const results = [];

  banner('Updating SQLite state', ANSI.cyan);
  for (let index = 0; index < dbPaths.length; index += 1) {
    const dbPath = dbPaths[index];
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    let before = 0;
    let after = 0;
    let changed = 0;

    try {
      const countStmt = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?');
      const updateStmt = db.prepare('UPDATE threads SET model_provider = ? WHERE model_provider = ?');

      for (const provider of fromProviders) {
        before += Number((countStmt.get(provider) || {}).count || 0);
      }

      for (const provider of fromProviders) {
        const result = updateStmt.run(toProvider, provider);
        changed += Number(result.changes || 0);
      }

      for (const provider of fromProviders) {
        after += Number((countStmt.get(provider) || {}).count || 0);
      }
    } finally {
      db.close();
    }

    results.push({ dbPath, before, after, changed });
    renderProgress('Updating sqlite', index + 1, dbPaths.length || 1, path.basename(dbPath));
  }

  return results;
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  if (!options.configPath) {
    throw new Error('Missing --config argument from launcher.');
  }

  const staticConfig = readSetupConfig(options.configPath);
  const codexHome = options.codexHome;
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');
  const sessionsRoot = path.join(codexHome, 'sessions');

  await fsp.mkdir(codexHome, { recursive: true });

  banner('Codex Setup Wizard', ANSI.cyan);
  status('INFO', `Setup config: ${options.configPath}`);
  status('INFO', `Codex home: ${codexHome}`);
  status('INFO', `Provider: ${staticConfig.provider.id}`);

  if (!process.stdin.isTTY) {
    throw new Error('Interactive mode requires a TTY.');
  }

  const prompt = createPrompt();
  try {
    const setupConfig = await promptConnectionDetails(prompt, staticConfig);
    const targetProvider = setupConfig.provider.id;
    status('INFO', `Base URL: ${setupConfig.provider.baseUrl}`);

    const backupZip = await createBackupArchive(codexHome, options.backupDir);

    banner('Writing auth.json and config.toml', ANSI.cyan);
    writeAuthJson(authPath, setupConfig.apiKey);
    updateConfigToml(configPath, setupConfig);
    status('OK', `Updated auth.json: ${authPath}`);
    status('OK', `Updated config.toml: ${configPath}`);

    ensureExists(codexHome, 'Codex home');
    const sessionEntries = await scanSessions(sessionsRoot);
    const sqliteFiles = await findStateDatabases(codexHome);
    const sqliteProviderCounts = collectProviderCountsFromSqlite(sqliteFiles);
    const sessionProviderCounts = collectProviderCountsFromSessions(sessionEntries);
    const providerCounts = sqliteProviderCounts.size > 0 ? sqliteProviderCounts : sessionProviderCounts;
    const providerSource = sqliteProviderCounts.size > 0 ? 'SQLite threads' : 'JSONL sessions';

    printProviderSummary(providerCounts, providerSource);
    prompt.targetProvider = targetProvider;
    const fromProviders = await chooseProviders(prompt, providerCounts);
    if (fromProviders === null) {
      status('WARN', 'Cancelled by user.');
      return;
    }

    const availableLegacyProviders = fromProviders.filter((provider) => providerCount(providerCounts, provider) > 0);
    if (fromProviders.length === 0) {
      banner('Summary', ANSI.green);
      status('INFO', `Backup archive: ${backupZip}`);
      status('INFO', `All chats are already using ${targetProvider}. No changes were required.`);
      status('INFO', `Elapsed: ${formatDuration(Date.now() - startedAt)}`);
      status('OK', `Setup completed. Active provider: ${targetProvider}`);
      return;
    }

    if (availableLegacyProviders.length === 0) {
      throw new Error('No chats were found for the selected legacy provider names.');
    }

    console.log('');
    status('INFO', `Converting ${availableLegacyProviders.join(', ')} -> ${targetProvider}`);

    const sessionUpdate = await retagSessionFiles(sessionEntries, availableLegacyProviders, targetProvider);
    const sqliteUpdate = retagSqliteFiles(sqliteFiles, availableLegacyProviders, targetProvider);

    let remainingRows = 0;
    for (const dbPath of sqliteFiles) {
      const db = new DatabaseSync(dbPath, { timeout: 5000 });
      try {
        const stmt = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?');
        for (const provider of availableLegacyProviders) {
          remainingRows += Number((stmt.get(provider) || {}).count || 0);
        }
      } finally {
        db.close();
      }
    }

    const rescannedSessions = await scanSessions(sessionsRoot);
    const remainingSessionFiles = rescannedSessions.filter((entry) => availableLegacyProviders.includes(entry.provider)).length;

    banner('Summary', ANSI.green);
    status('INFO', `Backup archive: ${backupZip}`);
    status('INFO', `JSONL files updated: ${sessionUpdate.updated}/${sessionUpdate.scanned}`);
    status('INFO', `SQLite files checked: ${sqliteUpdate.length}`);
    for (const row of sqliteUpdate) {
      console.log(`  - ${path.basename(row.dbPath)}: ${row.before} -> ${row.after} (changed ${row.changed})`);
    }
    status('INFO', `Remaining JSONL files with old providers: ${remainingSessionFiles}`);
    status('INFO', `Remaining SQLite rows with old providers: ${remainingRows}`);
    status('INFO', `Elapsed: ${formatDuration(Date.now() - startedAt)}`);

    if (remainingSessionFiles === 0 && remainingRows === 0) {
      status('OK', `Setup and provider conversion completed. Active provider: ${targetProvider}`);
      return;
    }

    throw new Error('Some old provider references still remain after conversion.');
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
