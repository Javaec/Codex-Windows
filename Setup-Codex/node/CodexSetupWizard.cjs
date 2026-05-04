#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
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
const CODEX_PROVIDER_COMMENTED_BASE_URLS = [
  'http://127.0.0.1:2455/backend-api/codex',
  'http://185.176.94.28:2455/backend-api/codex',
];

let CURRENT_LOCALE = 'ru';

const MESSAGES = {
  en: {
    appTitle: 'Codex Setup Wizard',
    setupConfig: (value) => `Setup config: ${value}`,
    codexHome: (value) => `Codex home: ${value}`,
    provider: (value) => `Provider: ${value}`,
    baseUrl: (value) => `Base URL: ${value}`,
    enterEndpoint: (value) => `Enter endpoint (default: ${value}): `,
    enterApiKey: 'Enter API key: ',
    sessionsIntro: (provider) => `Existing chats can be retagged to ${provider} so they appear in Codex history.`,
    sessionsNoDefault: 'No, leave existing chat providers unchanged (default)',
    sessionsYes: (provider) => `Yes, update existing chats to ${provider}`,
    updateSessionsPrompt: 'Update existing sessions: ',
    backupMenuTitle: 'Create a backup archive before applying changes?',
    backupYesDefault: 'Yes, create or reuse a recent backup (default)',
    backupNo: 'No, skip backup',
    backupPrompt: 'Create backup archive: ',
    detectedProviders: (source) => `Detected providers (${source})`,
    noProviderChats: 'No provider-tagged chats were found.',
    chatWord: (count) => (count === 1 ? 'chat' : 'chats'),
    sourceSqlite: 'SQLite threads',
    sourceJsonl: 'JSONL sessions',
    menuConvertAll: (provider, total, need) => `Convert all chats -> ${provider} (${total} chats total, ${need} need changes)`,
    menuConvertAllNoChanges: (provider, total) => `Convert all chats -> ${provider} (${total} chats total, 0 need changes)`,
    menuReplace: (from, to, count) => `Replace ${from} -> ${to} (${count} chats)`,
    menuCancel: 'Cancel',
    selectOption: 'Select an option: ',
    scanSessionsBanner: 'Scanning JSONL sessions',
    scanSessionsProgress: 'Scanning sessions',
    updateJsonlBanner: 'Updating JSONL session files',
    updateJsonlProgress: 'Updating sessions',
    updateSqliteBanner: 'Updating SQLite state',
    updateSqliteProgress: 'Updating sqlite',
    writeConfigBanner: 'Writing provider config',
    summaryBanner: 'Summary',
    updatedEnvKey: (name, scope) => `Updated ${name} environment variable (${scope})`,
    keptEnvKey: (name) => `Kept ${name} environment variable unchanged`,
    updatedConfig: (pathValue) => `Updated config.toml: ${pathValue}`,
    keptConfig: (pathValue) => `Kept existing config.toml unchanged: ${pathValue}`,
    sidecarBackup: (originalName, backupPath) => `Backup created for ${originalName}: ${backupPath}`,
    sessionsUnchanged: 'Existing sessions were left unchanged.',
    sessionsRetryLater: 'You can run the setup again later and choose session conversion if you want those chats to appear in Codex history.',
    elapsed: (value) => `Elapsed: ${value}`,
    setupCompleted: (provider) => `Setup completed. Active provider: ${provider}`,
    cancelled: 'Cancelled by user.',
    allAlreadyUsing: (provider) => `All chats are already using ${provider}. No changes were required.`,
    converting: (from, to) => `Converting ${from} -> ${to}`,
    backupArchive: (value) => `Backup archive: ${value}`,
    backupSkipped: 'Backup archive: skipped by user',
    jsonlUpdated: (updated, scanned) => `JSONL files updated: ${updated}/${scanned}`,
    sqliteChecked: (count) => `SQLite files checked: ${count}`,
    remainingJsonl: (count) => `Remaining JSONL files with old providers: ${count}`,
    remainingSqlite: (count) => `Remaining SQLite rows with old providers: ${count}`,
    setupAndConversionCompleted: (provider) => `Setup and provider conversion completed. Active provider: ${provider}`,
    reusingBackupBanner: 'Reusing recent backup archive',
    backupAge: (value) => `Backup age: ${value}`,
    creatingBackupBanner: 'Creating backup archive',
    stagingFiles: (count, home) => `Staging ${count} files from ${home}`,
    compressingBackup: 'Compressing backup archive',
    backupCreated: (method, pathValue) => `Backup archive created with ${method}: ${pathValue}`,
    pirateQuestionTitle: 'Do you honor the pirate code, land rat?',
    pirateQuestionBody: 'The captain looks at you with suspicion.',
    pirateOptionYes: 'Aye, captain',
    pirateOptionLoose: 'Who are you calling a rat? I am the new pirate!',
    pirateQuestionPrompt: 'Choose your pirate answer: ',
    cargoReadyBanner: 'Navigator Table Ready',
    cargoReadyStatus: 'Dependencies checked. Time to chart the course to the endpoint.',
    dependencyMapBanner: 'Dependency Map',
    pathRepairBanner: 'PATH Repair',
    pathAutoAdded: (label, dirPath) => `Added ${label} to PATH: ${dirPath}`,
    pathAutoAddedSessionOnly: (label, dirPath, details) => `Added ${label} to current PATH only: ${dirPath} (${details})`,
    pathPersistFailed: (label, details) => `Failed to persist PATH update for ${label}: ${details}`,
    dependencyFoundOutsidePath: (source) => `Found via ${source}, but not visible from PATH`,
    dependencyProbeFailed: (details) => `Found, but version check failed: ${details}`,
    dependencyCriticalTitle: 'Critical requirements',
    dependencyHelpfulTitle: 'Helpful but optional',
    dependencyUsefulTitle: 'Sometimes useful',
    subtitle: 'Provider setup and chat history migration',
    failureBanner: 'Failure',
    unknownMenuTryAgain: 'Unknown menu option. Try again.',
    missingCritical: (labels) => `Missing critical dependencies: ${labels}. Install them and run the wizard again.`,
    codexCliInstallHint: 'Install Codex CLI first.',
    codexAppInstallHint: 'Install Codex App for Windows first.',
    sshHint: 'https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse',
    missingConfigArg: 'Missing --config argument from launcher.',
    interactiveTtyRequired: 'Interactive mode requires a TTY.',
    noLegacyChatsFound: 'No chats were found for the selected legacy provider names.',
    oldRefsRemain: 'Some old provider references still remain after conversion.',
    endpointEmpty: 'Endpoint cannot be empty.',
    invalidEndpoint: (value) => `Invalid endpoint: ${value}`,
    invalidApiKeyBoundary: 'API key must start and end with a letter or digit.',
    invalidEnvKey: (value) => `Invalid environment variable name: ${value}`,
    descriptionNotFound: (description, filePath) => `${description} not found: ${filePath}`,
    setupConfigLabel: 'Setup config',
    codexHomeLabel: 'Codex home',
    setupConfigInvalidJson: (configPath) => `Setup config is not valid JSON: ${configPath}`,
    setupConfigMissingObject: (field) => `Setup config must contain object field "${field}".`,
    setupConfigMissingString: (field) => `Setup config must contain string field "${field}".`,
    setupConfigMissingBoolean: (field) => `Setup config must contain boolean field "${field}".`,
    setupConfigFieldString: (field) => `Setup config field "${field}" must be a string when present.`,
    setupConfigMissingDefault: (field) => `Setup config is missing defaults.${field}`,
    backupArchiveCreationFailed: (details) => `Backup archive creation failed. ${details}`,
    numericTomlFinite: 'Numeric TOML values must be finite.',
    unsupportedTomlValueType: (type) => `Unsupported TOML value type: ${type}`,
    languageOptionEnglish: '  1. English',
    languageOptionRussian: '  2. Русский',
    languagePrompt: 'Language / Язык (default: 2): ',
    unknownLanguageOption: 'Unknown language option. Try again.',
  },
  ru: {
    appTitle: 'Мастер настройки Codex',
    setupConfig: (value) => `Конфиг мастера: ${value}`,
    codexHome: (value) => `Папка Codex: ${value}`,
    provider: (value) => `Провайдер: ${value}`,
    baseUrl: (value) => `Базовый URL: ${value}`,
    enterEndpoint: (value) => `Введите endpoint (по умолчанию: ${value}): `,
    enterApiKey: 'Введите API key: ',
    sessionsIntro: (provider) => `Старые чаты можно перетегать в ${provider}, чтобы они появились в истории Codex.`,
    sessionsNoDefault: 'Нет, не менять провайдеры старых чатов (по умолчанию)',
    sessionsYes: (provider) => `Да, обновить старые чаты на ${provider}`,
    updateSessionsPrompt: 'Обновлять существующие сессии: ',
    backupMenuTitle: 'Создать backup-архив перед изменениями?',
    backupYesDefault: 'Да, создать новый backup или переиспользовать свежий (по умолчанию)',
    backupNo: 'Нет, пропустить backup',
    backupPrompt: 'Создать backup-архив: ',
    detectedProviders: (source) => `Найденные провайдеры (${source})`,
    noProviderChats: 'Чаты с тегом провайдера не найдены.',
    chatWord: () => 'чатов',
    sourceSqlite: 'SQLite threads',
    sourceJsonl: 'JSONL sessions',
    menuConvertAll: (provider, total, need) => `Конвертировать все чаты -> ${provider} (${total} всего, ${need} нужно изменить)`,
    menuConvertAllNoChanges: (provider, total) => `Конвертировать все чаты -> ${provider} (${total} всего, 0 нужно изменить)`,
    menuReplace: (from, to, count) => `Заменить ${from} -> ${to} (${count} чатов)`,
    menuCancel: 'Отмена',
    selectOption: 'Выберите пункт: ',
    scanSessionsBanner: 'Сканирование JSONL-сессий',
    scanSessionsProgress: 'Сканирование сессий',
    updateJsonlBanner: 'Обновление JSONL-файлов сессий',
    updateJsonlProgress: 'Обновление сессий',
    updateSqliteBanner: 'Обновление SQLite state',
    updateSqliteProgress: 'Обновление sqlite',
    writeConfigBanner: 'Запись настройки провайдера',
    summaryBanner: 'Итог',
    updatedEnvKey: (name, scope) => `Обновлена переменная окружения ${name} (${scope})`,
    keptEnvKey: (name) => `Переменная окружения ${name} оставлена без изменений`,
    updatedConfig: (pathValue) => `Обновлён config.toml: ${pathValue}`,
    keptConfig: (pathValue) => `Текущий config.toml оставлен без изменений: ${pathValue}`,
    sidecarBackup: (originalName, backupPath) => `Создан backup для ${originalName}: ${backupPath}`,
    sessionsUnchanged: 'Существующие сессии оставлены без изменений.',
    sessionsRetryLater: 'Позже можно снова запустить мастер и выбрать конвертацию сессий, чтобы эти чаты появились в истории Codex.',
    elapsed: (value) => `Время: ${value}`,
    setupCompleted: (provider) => `Настройка завершена. Активный провайдер: ${provider}`,
    cancelled: 'Отменено пользователем.',
    allAlreadyUsing: (provider) => `Все чаты уже используют ${provider}. Изменения не потребовались.`,
    converting: (from, to) => `Конвертация ${from} -> ${to}`,
    backupArchive: (value) => `Backup-архив: ${value}`,
    backupSkipped: 'Backup-архив: пропущен пользователем',
    jsonlUpdated: (updated, scanned) => `Обновлено JSONL-файлов: ${updated}/${scanned}`,
    sqliteChecked: (count) => `Проверено SQLite-файлов: ${count}`,
    remainingJsonl: (count) => `Осталось JSONL-файлов со старыми провайдерами: ${count}`,
    remainingSqlite: (count) => `Осталось строк SQLite со старыми провайдерами: ${count}`,
    setupAndConversionCompleted: (provider) => `Настройка и конвертация провайдеров завершены. Активный провайдер: ${provider}`,
    reusingBackupBanner: 'Переиспользование свежего backup-архива',
    backupAge: (value) => `Возраст backup: ${value}`,
    creatingBackupBanner: 'Создание backup-архива',
    stagingFiles: (count, home) => `Подготовка ${count} файлов из ${home}`,
    compressingBackup: 'Сжатие backup-архива',
    backupCreated: (method, pathValue) => `Backup-архив создан через ${method}: ${pathValue}`,
    pirateQuestionTitle: 'Ты чтишь пиратский кодекс, сухопутная крыса?',
    pirateQuestionBody: 'Капитан обратился к вам с подозрением.',
    pirateOptionYes: 'Да, капитан',
    pirateOptionLoose: 'Сам ты крыса, капитан! Я новый пират!',
    pirateQuestionPrompt: 'Выбери пиратский ответ: ',
    cargoReadyBanner: 'Штурманский стол готов',
    cargoReadyStatus: 'Зависимости проверены. Пора прокладывать курс к endpoint.',
    dependencyMapBanner: 'Карта зависимостей',
    pathRepairBanner: 'Починка PATH',
    pathAutoAdded: (label, dirPath) => `Добавил ${label} в PATH: ${dirPath}`,
    pathAutoAddedSessionOnly: (label, dirPath, details) => `Добавил ${label} только в текущий PATH: ${dirPath} (${details})`,
    pathPersistFailed: (label, details) => `Не удалось сохранить PATH для ${label}: ${details}`,
    dependencyFoundOutsidePath: (source) => `Найдена через ${source}, но не видна из PATH`,
    dependencyProbeFailed: (details) => `Найдена, но проверка версии не прошла: ${details}`,
    dependencyCriticalTitle: 'Смертельно важно',
    dependencyHelpfulTitle: 'Облегчит приключение',
    dependencyUsefulTitle: 'Бывает полезно',
    subtitle: 'Настройка провайдера и истории чатов',
    failureBanner: 'Провал',
    unknownMenuTryAgain: 'Неизвестный пункт меню. Попробуйте снова.',
    missingCritical: (labels) => `Отсутствуют критически важные зависимости: ${labels}. Установите их и запустите мастер снова.`,
    codexCliInstallHint: 'Сначала установите Codex CLI.',
    codexAppInstallHint: 'Сначала установите Codex App for Windows.',
    sshHint: 'https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse',
    missingConfigArg: 'Launcher не передал аргумент --config.',
    interactiveTtyRequired: 'Интерактивному режиму нужен TTY.',
    noLegacyChatsFound: 'Для выбранных старых провайдеров чаты не найдены.',
    oldRefsRemain: 'После конвертации ещё остались ссылки на старых провайдеров.',
    endpointEmpty: 'Endpoint не может быть пустым.',
    invalidEndpoint: (value) => `Некорректный endpoint: ${value}`,
    invalidApiKeyBoundary: 'API key должен начинаться и заканчиваться буквой или цифрой.',
    invalidEnvKey: (value) => `Некорректное имя переменной окружения: ${value}`,
    descriptionNotFound: (description, filePath) => `${description} не найден: ${filePath}`,
    setupConfigLabel: 'Конфиг мастера',
    codexHomeLabel: 'Папка Codex',
    setupConfigInvalidJson: (configPath) => `Конфиг мастера содержит невалидный JSON: ${configPath}`,
    setupConfigMissingObject: (field) => `В конфиге мастера должен быть объект "${field}".`,
    setupConfigMissingString: (field) => `В конфиге мастера должно быть строковое поле "${field}".`,
    setupConfigMissingBoolean: (field) => `В конфиге мастера должно быть булево поле "${field}".`,
    setupConfigFieldString: (field) => `Поле "${field}" в конфиге мастера должно быть строкой, если оно задано.`,
    setupConfigMissingDefault: (field) => `В конфиге мастера отсутствует defaults.${field}`,
    backupArchiveCreationFailed: (details) => `Не удалось создать backup-архив. ${details}`,
    numericTomlFinite: 'Числовые TOML-значения должны быть конечными.',
    unsupportedTomlValueType: (type) => `Неподдерживаемый тип TOML-значения: ${type}`,
    languageOptionEnglish: '  1. English',
    languageOptionRussian: '  2. Русский',
    languagePrompt: 'Language / Язык (по умолчанию: 2): ',
    unknownLanguageOption: 'Неизвестный вариант языка. Попробуйте снова.',
  },
};

function t(locale, key, ...args) {
  const table = MESSAGES[locale] || MESSAGES.en;
  const value = table[key] ?? MESSAGES.en[key];
  return typeof value === 'function' ? value(...args) : value;
}

function supportsEmoji() {
  if (!process.stdout.isTTY) {
    return false;
  }

  if (process.env.NO_EMOJI === '1') {
    return false;
  }

  return true;
}

function icon(name) {
  const enabled = supportsEmoji();
  const icons = {
    skull: enabled ? '☠️ ' : '',
    pirate: enabled ? '🏴‍☠️ ' : '',
    gold: enabled ? '🪙 ' : '',
    anchor: enabled ? '⚓ ' : '',
    spark: enabled ? '✨ ' : '',
    warn: enabled ? '⚠️ ' : '',
  };

  return icons[name] || '';
}

function getPathEntries() {
  return String(process.env.PATH || process.env.Path || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getWindowsExecutableExtensions() {
  return String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveExistingFile(candidate) {
  if (!candidate) {
    return null;
  }

  try {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  } catch (error) {
    return null;
  }

  return null;
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = path.normalize(value);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(value);
  }

  return result;
}

function normalizePathKey(value) {
  return path.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isPathEntryPresent(entries, targetEntry) {
  const targetKey = normalizePathKey(targetEntry);
  return entries.some((entry) => normalizePathKey(entry) === targetKey);
}

function findExecutableInPath(names) {
  const entries = getPathEntries();
  const extensions = process.platform === 'win32' ? getWindowsExecutableExtensions() : [''];

  for (const rawName of names) {
    const name = String(rawName || '').trim();
    if (!name) {
      continue;
    }

    if (name.includes(path.sep) || name.includes('/')) {
      const direct = resolveExistingFile(name);
      if (direct) {
        return direct;
      }
    }

    const hasExtension = Boolean(path.extname(name));
    for (const entry of entries) {
      if (hasExtension) {
        const candidate = resolveExistingFile(path.join(entry, name));
        if (candidate) {
          return candidate;
        }
        continue;
      }

      for (const extension of extensions) {
        const candidate = resolveExistingFile(path.join(entry, `${name}${extension.toLowerCase()}`))
          || resolveExistingFile(path.join(entry, `${name}${extension}`));
        if (candidate) {
          return candidate;
        }
      }

      const bareCandidate = resolveExistingFile(path.join(entry, name));
      if (bareCandidate) {
        return bareCandidate;
      }
    }
  }

  return null;
}

function quoteCmdArg(value) {
  const text = String(value || '');
  if (!/[\s"]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function runCommandFromPath(commandName, args) {
  if (!commandName) {
    return { ok: false, stdout: '', stderr: 'missing command name', code: -1 };
  }

  const commandLine = [quoteCmdArg(commandName), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
  try {
    const result = spawnSync(commandLine, {
      shell: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });

    return {
      ok: !result.error && result.status === 0,
      stdout: String(result.stdout || ''),
      stderr: result.error ? result.error.message : String(result.stderr || ''),
      code: result.status ?? -1,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
    };
  }
}

function runExecutable(executablePath, args) {
  if (!executablePath) {
    return { ok: false, stdout: '', stderr: 'missing executable path', code: -1 };
  }

  try {
    let result;
    if (/\.(cmd|bat)$/i.test(executablePath)) {
      const commandLine = [quoteCmdArg(executablePath), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
      result = spawnSync(commandLine, {
        shell: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
    } else {
      result = spawnSync(executablePath, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
    }

    return {
      ok: !result.error && result.status === 0,
      stdout: String(result.stdout || ''),
      stderr: result.error ? result.error.message : String(result.stderr || ''),
      code: result.status ?? -1,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
    };
  }
}

function canRunFromPath(commandNames, args) {
  for (const commandName of commandNames) {
    const result = runCommandFromPath(commandName, args);
    if (result.ok) {
      return result;
    }
  }

  return { ok: false, stdout: '', stderr: '', code: -1 };
}

function findPowerShell7ExecutableInPath() {
  return findFirstExistingCandidate([
    process.env.CODEX_PWSH_PATH || '',
    process.env.PWSH_EXE || '',
    findExecutableInPath(['pwsh.exe', 'pwsh']),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'PowerShell', '7-preview', 'pwsh.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'PowerShell', '7', 'pwsh.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'PowerShell', '7-preview', 'pwsh.exe') : '',
  ]);
}

function findFirstExistingCandidate(candidates) {
  for (const candidate of candidates) {
    const resolved = resolveExistingFile(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

const APPX_PACKAGE_CACHE = new Map();

function parseAppxPackageJson(jsonText) {
  const trimmed = String(jsonText || '').trim();
  if (!trimmed) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return [];
  }

  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((entry) => ({
      name: String(entry.Name || entry.name || '').trim(),
      version: String(entry.Version || entry.version || '').trim(),
      packageFullName: String(entry.PackageFullName || entry.packageFullName || '').trim(),
      installLocation: String(entry.InstallLocation || entry.installLocation || '').trim(),
    }))
    .filter((pkg) => pkg.name || pkg.packageFullName);
}

function listAppxPackages(packageQuery) {
  const cacheKey = String(packageQuery || '').trim();
  if (APPX_PACKAGE_CACHE.has(cacheKey)) {
    return APPX_PACKAGE_CACHE.get(cacheKey);
  }

  const shellPath = findPowerShell7ExecutableInPath() || findExecutableInPath(['powershell.exe', 'powershell']);
  if (!shellPath) {
    APPX_PACKAGE_CACHE.set(cacheKey, []);
    return [];
  }

  const packageName = quotePowerShellString(cacheKey);
  const command =
    `$ErrorActionPreference='SilentlyContinue';` +
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `$packages=@();` +
    `$packages+=@(Get-AppxPackage -Name ${packageName});` +
    `try { $packages+=@(Get-AppxPackage -AllUsers -Name ${packageName}); } catch {};` +
    `$packages | ` +
    `Sort-Object PackageFullName -Unique | ` +
    `Sort-Object Version -Descending | ` +
    `Select-Object Name,Version,PackageFullName,InstallLocation | ` +
    `ConvertTo-Json -Depth 3`;

  let result;
  try {
    result = spawnSync(shellPath, ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
  } catch (error) {
    APPX_PACKAGE_CACHE.set(cacheKey, []);
    return [];
  }

  if (result.error || result.status !== 0) {
    APPX_PACKAGE_CACHE.set(cacheKey, []);
    return [];
  }

  const packages = parseAppxPackageJson(result.stdout);

  APPX_PACKAGE_CACHE.set(cacheKey, packages);
  return packages;
}

function addCodexWindowsAppPaths(pkg) {
  const resourcesDir = pkg.installLocation ? path.join(pkg.installLocation, 'app', 'resources') : '';
  return {
    ...pkg,
    resourcesDir,
    resourcesAvailable: Boolean(resourcesDir && fs.existsSync(resourcesDir)),
    appAsarUnpackedDir: resourcesDir ? path.join(resourcesDir, 'app.asar.unpacked') : '',
  };
}

function listCodexWindowsAppsPackages() {
  return listAppxPackages('OpenAI.Codex*')
    .map(addCodexWindowsAppPaths);
}

function listCodexWindowsAppsResourceDirs() {
  return listCodexWindowsAppsPackages()
    .filter((pkg) => pkg.resourcesAvailable)
    .map((pkg) => pkg.resourcesDir);
}

function getLatestCodexAppPackage() {
  return listCodexWindowsAppsPackages()[0] || null;
}

function firstNonEmptyLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function runVersionCommand(executablePath, args) {
  if (!executablePath) {
    return '';
  }

  try {
    let result;
    if (/\.(cmd|bat)$/i.test(executablePath)) {
      const commandLine = [quoteCmdArg(executablePath), ...args.map((arg) => quoteCmdArg(arg))].join(' ');
      result = spawnSync(commandLine, {
        shell: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
    } else {
      result = spawnSync(executablePath, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
    }

    if (result.error) {
      return '';
    }

    return firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
  } catch (error) {
    return '';
  }
}

function runPowerShellQuery(command) {
  const powershell = findPowerShell7ExecutableInPath() || findExecutableInPath(['powershell.exe', 'powershell']);
  if (!powershell) {
    return '';
  }

  return runVersionCommand(powershell, ['-NoProfile', '-Command', command]);
}

function getCodexExecutableCandidates() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.resolve(__dirname, '..', '..', 'dist', 'Codex-win32-x64', 'resources', 'codex.exe'),
    path.resolve(__dirname, '..', '..', 'dist', 'Codex-win32-arm64', 'resources', 'codex.exe'),
    process.env.CODEX_CLI_PATH || '',
    localAppData ? path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'resources', 'codex.exe') : '',
    ...listCodexWindowsAppsResourceDirs().map((resourceDir) => path.join(resourceDir, 'codex.exe')),
    findExecutableInPath(['codex.exe', 'codex.cmd', 'codex']),
  ];

  return uniquePaths(candidates);
}

function getToolCandidatesNearCodex(codexPath, fileName) {
  const codexDirs = [];
  if (codexPath) {
    codexDirs.push(path.dirname(codexPath));
  }

  codexDirs.push(...listCodexWindowsAppsResourceDirs());

  return uniquePaths(codexDirs.flatMap((codexDir) => [
    path.join(codexDir, fileName),
    path.join(codexDir, 'path', fileName),
    path.join(codexDir, 'tools', fileName),
  ]));
}

function getProgramFilesCandidate(subPath) {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, subPath) : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], subPath) : '',
  ];

  return findFirstExistingCandidate(candidates);
}

function getUserPathEntries() {
  const raw = runPowerShellQuery("[Environment]::GetEnvironmentVariable('Path', 'User')");
  return String(raw || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function quotePowerShellString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function validateApiKey(apiKey, locale = CURRENT_LOCALE) {
  if (!/^[A-Za-z0-9](?:[^\s]*[A-Za-z0-9])?$/u.test(apiKey)) {
    throw new Error(t(locale, 'invalidApiKeyBoundary'));
  }
}

function validateEnvKeyName(name, locale = CURRENT_LOCALE) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(name || ''))) {
    throw new Error(t(locale, 'invalidEnvKey', name));
  }
}

function setUserEnvironmentVariable(name, value) {
  validateEnvKeyName(name);
  const powershell = findPowerShell7ExecutableInPath() || findExecutableInPath(['powershell.exe', 'powershell']);
  if (!powershell) {
    throw new Error('PowerShell is not available');
  }

  const command = `[Environment]::SetEnvironmentVariable(${quotePowerShellString(name)}, ${quotePowerShellString(value)}, 'User')`;
  const result = spawnSync(powershell, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });

  if (result.error || result.status !== 0) {
    throw new Error(firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `exit ${result.status ?? -1}`);
  }

  process.env[name] = value;
  return { name, scope: 'User' };
}

function persistUserPathEntries(entries) {
  const powershell = findPowerShell7ExecutableInPath() || findExecutableInPath(['powershell.exe', 'powershell']);
  if (!powershell) {
    return { ok: false, details: 'PowerShell is not available' };
  }

  const pathValue = uniquePaths(entries).join(path.delimiter);
  const command = `[Environment]::SetEnvironmentVariable('Path', ${quotePowerShellString(pathValue)}, 'User')`;

  try {
    const result = spawnSync(powershell, ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        details: firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || `exit ${result.status ?? -1}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, details: '' };
}

function prependProcessPathEntries(entries) {
  const currentEntries = getPathEntries();
  const additions = uniquePaths(entries).filter((entry) => !isPathEntryPresent(currentEntries, entry));
  if (additions.length === 0) {
    return;
  }

  process.env.PATH = [...additions, ...currentEntries].join(path.delimiter);
  process.env.Path = process.env.PATH;
}

function getNodeExecutableCandidates() {
  return uniquePaths([
    process.execPath || '',
    getProgramFilesCandidate(path.join('nodejs', 'node.exe')),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
  ]);
}

function getNpmExecutableCandidates() {
  const nodeDir = process.execPath ? path.dirname(process.execPath) : '';
  return uniquePaths([
    nodeDir ? path.join(nodeDir, 'npm.cmd') : '',
    nodeDir ? path.join(nodeDir, 'npm.exe') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'npm.cmd') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'npm.exe') : '',
    getProgramFilesCandidate(path.join('nodejs', 'npm.cmd')),
    getProgramFilesCandidate(path.join('nodejs', 'npm.exe')),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.cmd') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.exe') : '',
  ]);
}

function getGitExecutableCandidates() {
  return uniquePaths([
    getProgramFilesCandidate(path.join('Git', 'cmd', 'git.exe')),
    getProgramFilesCandidate(path.join('Git', 'bin', 'git.exe')),
  ]);
}

function getSshExecutableCandidates() {
  return uniquePaths([
    process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe') : '',
    getProgramFilesCandidate(path.join('Git', 'usr', 'bin', 'ssh.exe')),
    getProgramFilesCandidate(path.join('Git', 'bin', 'ssh.exe')),
  ]);
}

function getPythonExecutableCandidates() {
  const candidates = [];
  const pythonRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '';
  if (pythonRoot && fs.existsSync(pythonRoot)) {
    const entries = fs.readdirSync(pythonRoot, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.isDirectory() && /^Python\d+/i.test(entry.name)) {
        candidates.push(path.join(pythonRoot, entry.name, 'python.exe'));
      }
    }
  }

  return uniquePaths(candidates);
}

function getJavaExecutableCandidates() {
  const candidates = [];
  const roots = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Zulu') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Eclipse Adoptium') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Java') : '',
  ];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) {
      continue;
    }

    const entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(root, entry.name, 'bin', 'java.exe'));
      }
    }
  }

  return uniquePaths(candidates);
}

function getSevenZipExecutableCandidates() {
  return uniquePaths([
    getProgramFilesCandidate(path.join('7-Zip', '7z.exe')),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'shims', '7z.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', '7-Zip', '7z.exe') : '',
  ]);
}

function getRipgrepExecutableCandidates() {
  const codexPath = findFirstExistingCandidate(getCodexExecutableCandidates());
  const repoRoot = path.resolve(__dirname, '..', '..');
  return uniquePaths([
    ...listCodexWindowsAppsResourceDirs().map((resourceDir) => path.join(resourceDir, 'rg.exe')),
    ...getToolCandidatesNearCodex(codexPath, 'rg.exe'),
    path.join(repoRoot, 'work', 'tools', 'ripgrep', 'ripgrep-14.1.1-x86_64-pc-windows-msvc', 'rg.exe'),
  ]);
}

function repairPathForDependencies(locale) {
  const actions = [];
  const specs = [
    {
      label: 'Node.js',
      commandNames: ['node.exe', 'node'],
      args: ['-v'],
      candidates: getNodeExecutableCandidates,
    },
    {
      label: 'npm',
      commandNames: ['npm.cmd', 'npm.exe', 'npm'],
      args: ['-v'],
      candidates: getNpmExecutableCandidates,
    },
    {
      label: 'PowerShell 7+',
      commandNames: ['pwsh.exe', 'pwsh'],
      args: ['-v'],
      candidates: () => [findPowerShell7ExecutableInPath()],
    },
    {
      label: 'git (Git for Windows)',
      commandNames: ['git.exe', 'git.cmd', 'git'],
      args: ['--version'],
      candidates: getGitExecutableCandidates,
    },
    {
      label: 'ssh',
      commandNames: ['ssh.exe', 'ssh'],
      args: ['-V'],
      candidates: getSshExecutableCandidates,
    },
    {
      label: 'rg',
      commandNames: ['rg.exe', 'rg'],
      args: ['--version'],
      candidates: getRipgrepExecutableCandidates,
    },
  ];

  for (const spec of specs) {
    if (canRunFromPath(spec.commandNames, spec.args).ok) {
      continue;
    }

    const executablePath = findFirstExistingCandidate(spec.candidates());
    if (!executablePath) {
      continue;
    }

    const targetDir = path.dirname(executablePath);
    prependProcessPathEntries([targetDir]);
    const repairedInProcess = canRunFromPath(spec.commandNames, spec.args).ok;

    const userPathEntries = getUserPathEntries();
    if (isPathEntryPresent(userPathEntries, targetDir)) {
      if (repairedInProcess) {
        actions.push({ level: 'OK', message: t(locale, 'pathAutoAdded', spec.label, targetDir) });
      }
      continue;
    }

    const persistResult = persistUserPathEntries([...userPathEntries, targetDir]);
    if (persistResult.ok) {
      if (repairedInProcess) {
        actions.push({ level: 'OK', message: t(locale, 'pathAutoAdded', spec.label, targetDir) });
      } else {
        actions.push({ level: 'WARN', message: t(locale, 'pathPersistFailed', spec.label, 'command still does not run from PATH') });
      }
      continue;
    }

    if (repairedInProcess) {
      actions.push({ level: 'WARN', message: t(locale, 'pathAutoAddedSessionOnly', spec.label, targetDir, persistResult.details) });
    } else {
      actions.push({ level: 'WARN', message: t(locale, 'pathPersistFailed', spec.label, persistResult.details) });
    }
  }

  return actions;
}

function parseMajorVersion(text) {
  const match = String(text || '').match(/(\d+)(?:\.\d+)?(?:\.\d+)?/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function sanitizeVersionText(label, text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return '';
  }

  if (/is not recognized as an internal or external command/i.test(raw)) {
    return '';
  }

  switch (label) {
    case 'Node.js':
      return firstNonEmptyLine(raw);
    case 'npm': {
      const match = raw.match(/\b\d+\.\d+\.\d+(?:[-+][^\s]+)?\b/);
      return match ? match[0] : '';
    }
    case 'Codex CLI': {
      const match = raw.match(/codex-cli\s+[^\s]+/i);
      return match ? match[0] : firstNonEmptyLine(raw);
    }
    case 'rg': {
      const match = raw.match(/ripgrep\s+[^\s]+/i);
      return match ? match[0] : firstNonEmptyLine(raw);
    }
    case 'SQLite': {
      if (/better-sqlite3/i.test(raw)) {
        return 'better-sqlite3';
      }
      const match = raw.match(/\b\d+\.\d+\.\d+\b/);
      return match ? match[0] : '';
    }
    case 'PowerShell 7+': {
      const match = raw.match(/\b\d+\.\d+\.\d+\b/);
      return match ? match[0] : firstNonEmptyLine(raw);
    }
    case 'git (Git for Windows)':
      return firstNonEmptyLine(raw).replace(/^git version\s+/i, 'git ');
    case 'python': {
      const match = raw.match(/Python\s+\S+/i);
      return match ? match[0] : firstNonEmptyLine(raw);
    }
    case 'java': {
      const match = raw.match(/(?:openjdk|java)\s+version\s+"([^"]+)"/i);
      return match ? `Java ${match[1]}` : firstNonEmptyLine(raw);
    }
    case '7zip': {
      const match = raw.match(/7-Zip\s+\S+(?:\s+\([^)]+\))?/i);
      return match ? match[0] : firstNonEmptyLine(raw);
    }
    case 'ssh':
      return firstNonEmptyLine(raw).split(',')[0];
    default:
      return firstNonEmptyLine(raw);
  }
}

function makeDependency(label, state, pathValue, detail, hint = '', source = '', visibleFromPath = true) {
  return {
    label,
    state,
    path: pathValue || '',
    detail: sanitizeVersionText(label, detail),
    hint,
    source,
    visibleFromPath,
  };
}

function resolveRunnableDependency(commandNames, candidates, args) {
  const pathExecutable = findExecutableInPath(commandNames);
  const pathExecutableKey = pathExecutable ? normalizePathKey(pathExecutable) : '';
  const allCandidates = uniquePaths([
    pathExecutable,
    ...candidates,
  ]);
  let firstExisting = '';
  let firstFailure = null;

  for (const candidate of allCandidates) {
    const executablePath = resolveExistingFile(candidate);
    if (!executablePath) {
      continue;
    }

    if (!firstExisting) {
      firstExisting = executablePath;
    }

    const result = runExecutable(executablePath, args);
    if (result.ok) {
      const visibleFromPath = normalizePathKey(executablePath) === pathExecutableKey;
      return {
        ok: true,
        path: executablePath,
        result,
        source: visibleFromPath ? 'PATH' : describeExecutableSource(executablePath),
        visibleFromPath,
      };
    }

    if (!firstFailure) {
      firstFailure = result;
    }
  }

  return {
    ok: false,
    path: firstExisting,
    result: firstFailure || { ok: false, stdout: '', stderr: '', code: -1 },
    source: firstExisting ? describeExecutableSource(firstExisting) : '',
    visibleFromPath: Boolean(pathExecutableKey && normalizePathKey(firstExisting) === pathExecutableKey),
  };
}

function dependencyStateFromProbe(probe) {
  if (probe.ok) {
    return 'ok';
  }

  return probe.path ? 'warn' : 'missing';
}

function dependencyDetailFromProbe(probe) {
  if (!probe.path) {
    return '';
  }

  return firstNonEmptyLine(probe.result.stdout || probe.result.stderr)
    || (probe.result.code >= 0 ? `exit ${probe.result.code}` : 'spawn failed');
}

function makeProbeDependency(label, probe, hint = '', detail = '') {
  return makeDependency(
    label,
    dependencyStateFromProbe(probe),
    probe.path || '',
    probe.ok ? (detail || firstNonEmptyLine(probe.result.stdout || probe.result.stderr)) : dependencyDetailFromProbe(probe),
    hint,
    probe.source,
    probe.visibleFromPath,
  );
}

function describeExecutableSource(executablePath) {
  const normalized = path.normalize(String(executablePath || '')).toLowerCase();
  const localAppData = path.normalize(process.env.LOCALAPPDATA || '').toLowerCase();
  const appData = path.normalize(process.env.APPDATA || '').toLowerCase();
  const userProfile = path.normalize(process.env.USERPROFILE || '').toLowerCase();
  const programFiles = path.normalize(process.env.ProgramFiles || '').toLowerCase();
  const programFilesX86 = path.normalize(process.env['ProgramFiles(x86)'] || '').toLowerCase();

  if (normalized.includes(path.normalize('\\WindowsApps\\OpenAI.Codex_').toLowerCase())) {
    return 'Codex App resources';
  }
  if (localAppData && normalized.startsWith(path.join(localAppData, 'openai', 'codex', 'bin'))) {
    return 'Codex tool bin';
  }
  if (appData && normalized.startsWith(path.join(appData, 'npm'))) {
    return 'npm user bin';
  }
  if (localAppData && normalized.startsWith(path.join(localAppData, 'programs', 'python'))) {
    return 'Python user install';
  }
  if (userProfile && normalized.startsWith(path.join(userProfile, 'scoop', 'shims'))) {
    return 'Scoop shims';
  }
  if (programFiles && normalized.startsWith(programFiles)) {
    return 'Program Files';
  }
  if (programFilesX86 && normalized.startsWith(programFilesX86)) {
    return 'Program Files (x86)';
  }
  if (normalized.startsWith(path.normalize(path.resolve(__dirname, '..', '..')).toLowerCase())) {
    return 'repository candidate';
  }

  return 'known location';
}

function getNpmVersion(npmPath) {
  const direct = runVersionCommand(npmPath, ['--version']);
  if (direct) {
    return direct;
  }

  if (!npmPath) {
    return '';
  }

  try {
    const npmDir = path.dirname(npmPath);
    const packageJsonPath = path.join(npmDir, 'node_modules', 'npm', 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (parsed && typeof parsed.version === 'string') {
        return parsed.version;
      }
    }

    const nodePackageJsonPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'package.json');
    if (fs.existsSync(nodePackageJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(nodePackageJsonPath, 'utf8'));
      if (parsed && typeof parsed.version === 'string') {
        return parsed.version;
      }
    }
  } catch (error) {
    return '';
  }

  return '';
}

function getCodexCliVersion(codexPath) {
  const direct = runVersionCommand(codexPath, ['--version']);
  if (direct) {
    return direct;
  }

  if (!codexPath) {
    return '';
  }

  try {
    const normalized = path.normalize(codexPath).toLowerCase();
    if (normalized.endsWith(path.normalize('\\AppData\\Roaming\\npm\\codex.cmd').toLowerCase())) {
      const packageJsonPath = path.join(path.dirname(codexPath), 'node_modules', '@openai', 'codex', 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (parsed && typeof parsed.version === 'string') {
          return `codex-cli ${parsed.version}`;
        }
      }
    }
  } catch (error) {
    return '';
  }

  return '';
}

function dependencyStateLine(state) {
  if (state === 'ok') {
    return color(`${icon('spark')}OK`, ANSI.green);
  }

  if (state === 'warn') {
    return color(`${icon('warn')}WARN`, ANSI.yellow);
  }

  return color(`${icon('skull')}MISSING`, ANSI.red);
}

function buildDependencyMap(locale) {
  const codexAppPackage = getLatestCodexAppPackage();
  const windowsTerminalPackage = listAppxPackages('Microsoft.WindowsTerminal')[0] || null;
  const codexPath = findFirstExistingCandidate(getCodexExecutableCandidates());
  const nodeProbe = resolveRunnableDependency(['node.exe', 'node'], getNodeExecutableCandidates(), ['-v']);
  const npmProbe = resolveRunnableDependency(['npm.cmd', 'npm.exe', 'npm'], getNpmExecutableCandidates(), ['-v']);
  const pwshProbe = resolveRunnableDependency(['pwsh.exe', 'pwsh'], [findPowerShell7ExecutableInPath()], ['-v']);
  const gitProbe = resolveRunnableDependency(['git.exe', 'git.cmd', 'git'], getGitExecutableCandidates(), ['--version']);
  const pythonProbe = resolveRunnableDependency(['python.exe', 'python', 'py.exe', 'py'], getPythonExecutableCandidates(), ['--version']);
  const javaProbe = resolveRunnableDependency(['java.exe', 'java'], getJavaExecutableCandidates(), ['-version']);
  const sevenZipProbe = resolveRunnableDependency(['7z.exe', '7za.exe', '7z'], getSevenZipExecutableCandidates(), []);
  const sshProbe = resolveRunnableDependency(['ssh.exe', 'ssh'], getSshExecutableCandidates(), ['-V']);
  const rgProbe = resolveRunnableDependency(['rg.exe', 'rg'], getRipgrepExecutableCandidates(), ['--version']);
  const wtPath = findFirstExistingCandidate([
    findExecutableInPath(['wt.exe', 'wt']),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'WindowsApps', 'wt.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'WindowsApps', 'wt.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe') : '',
    ...(windowsTerminalPackage ? [windowsTerminalPackage.installLocation] : []),
  ]);

  const pwshVersion = pwshProbe.path ? runVersionCommand(pwshProbe.path, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']) : '';
  const pwshMajor = parseMajorVersion(pwshVersion);
  const executionPolicy = runPowerShellQuery('Get-ExecutionPolicy');
  const executionPolicyOk = executionPolicy && !/^Restricted$/i.test(executionPolicy);

  return {
    critical: [
      makeProbeDependency('Node.js', nodeProbe, 'https://nodejs.org/'),
      makeProbeDependency('npm', npmProbe, 'https://nodejs.org/', npmProbe.ok ? getNpmVersion(npmProbe.path) : ''),
      makeDependency('PowerShell 7+', pwshProbe.ok && pwshMajor !== null && pwshMajor >= 7 ? 'ok' : dependencyStateFromProbe(pwshProbe), pwshProbe.path || '', pwshProbe.ok ? pwshVersion : dependencyDetailFromProbe(pwshProbe), 'https://aka.ms/powershell-release?tag=stable', pwshProbe.source, pwshProbe.visibleFromPath),
      makeDependency('Codex CLI', codexPath ? 'ok' : 'missing', codexPath || '', codexPath ? getCodexCliVersion(codexPath) : '', t(locale, 'codexCliInstallHint')),
      makeDependency('Codex App', codexAppPackage ? 'ok' : 'missing', codexAppPackage ? codexAppPackage.installLocation : '', codexAppPackage ? codexAppPackage.version : '', t(locale, 'codexAppInstallHint')),
    ],
    important: [
      makeProbeDependency('rg', rgProbe, 'https://ripgrep.dev/download/'),
      makeDependency('Windows Terminal', wtPath ? 'ok' : 'missing', wtPath || '', windowsTerminalPackage ? windowsTerminalPackage.version : '', 'https://aka.ms/terminal'),
      makeDependency('PowerShell script execution', executionPolicyOk ? 'ok' : 'warn', '', executionPolicy || 'Restricted or unavailable', 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'),
      makeProbeDependency('git (Git for Windows)', gitProbe, 'https://git-scm.com/download/win'),
    ],
    optional: [
      makeProbeDependency('python', pythonProbe, 'https://www.python.org/downloads/windows/'),
      makeProbeDependency('java', javaProbe, 'https://adoptium.net/'),
      makeProbeDependency('7zip', sevenZipProbe, 'https://www.7-zip.org/download.html'),
      makeProbeDependency('ssh', sshProbe, t(locale, 'sshHint')),
    ],
  };
}

function printDependencyGroup(locale, titleEn, titleRu, dependencies) {
  const title = locale === 'ru' ? titleRu : titleEn;
  console.log('');
  console.log(color(title, ANSI.yellow));

  for (const dependency of dependencies) {
    const stateText = dependencyStateLine(dependency.state);
    const summary = [dependency.detail].filter(Boolean).join('  ');
    console.log(`  ${stateText} ${color(dependency.label.padEnd(28), ANSI.bold)} ${summary}`.trimEnd());
    if (dependency.path) {
      console.log(color(`      ${dependency.path}`, ANSI.gray));
    }
    if (dependency.state === 'warn' && dependency.path) {
      console.log(color(`      ${t(locale, 'dependencyProbeFailed', dependency.detail || 'unknown error')}`, ANSI.yellow));
    }
    if (dependency.state === 'ok' && dependency.visibleFromPath === false) {
      console.log(color(`      ${t(locale, 'dependencyFoundOutsidePath', dependency.source || 'known location')}`, ANSI.yellow));
    }
    if (dependency.state === 'missing' && dependency.hint) {
      console.log(color(`      ${dependency.hint}`, ANSI.cyan));
    }
  }
}

function printDependencyMap(locale, dependencyMap) {
  banner(`${icon('anchor')}${t(locale, 'dependencyMapBanner')}`, ANSI.blue);
  printDependencyGroup(locale, t(locale, 'dependencyCriticalTitle'), t(locale, 'dependencyCriticalTitle'), dependencyMap.critical);
  printDependencyGroup(locale, t(locale, 'dependencyHelpfulTitle'), t(locale, 'dependencyHelpfulTitle'), dependencyMap.important);
  printDependencyGroup(locale, t(locale, 'dependencyUsefulTitle'), t(locale, 'dependencyUsefulTitle'), dependencyMap.optional);
}

function ensureCriticalDependencies(dependencyMap, locale) {
  const missing = dependencyMap.critical.filter((dependency) => dependency.state === 'missing');
  if (missing.length === 0) {
    return;
  }

  const labels = missing.map((dependency) => dependency.label).join(', ');
  throw new Error(t(locale, 'missingCritical', labels));
}

async function runDependencyWarnSelfTest(locale = CURRENT_LOCALE) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-dependency-warn-'));
  const badToolPath = path.join(tempRoot, 'bad-tool.cmd');

  try {
    await fsp.writeFile(badToolPath, ['@echo off', 'echo bad tool probe 1>&2', 'exit /b 9', ''].join('\r\n'), 'ascii');
    const probe = resolveRunnableDependency([], [badToolPath], ['--version']);
    const dependency = makeProbeDependency('rg', probe);

    if (dependency.state !== 'warn') {
      throw new Error(`Dependency warn self-test failed: expected warn, got ${dependency.state}`);
    }

    ensureCriticalDependencies({ critical: [dependency] }, locale);
    status('OK', `Dependency warn self-test: ${dependency.detail}`);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function runStoreAppDetectionSelfTest() {
  const appxJson = JSON.stringify({
    Name: 'OpenAI.Codex',
    Version: '26.429.3425.0',
    PackageFullName: 'OpenAI.Codex_26.429.3425.0_x64__2p2nqsd0c76g0',
    InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.429.3425.0_x64__2p2nqsd0c76g0',
  });
  const packages = parseAppxPackageJson(appxJson).map(addCodexWindowsAppPaths);
  const packageInfo = packages[0];

  if (!packageInfo) {
    throw new Error('Store app detection self-test failed: AppX JSON was not parsed');
  }

  const dependency = makeDependency(
    'Codex App',
    packageInfo ? 'ok' : 'missing',
    packageInfo ? packageInfo.installLocation : '',
    packageInfo ? packageInfo.version : '',
  );

  if (dependency.state !== 'ok') {
    throw new Error(`Store app detection self-test failed: expected ok, got ${dependency.state}`);
  }

  if (!packageInfo.resourcesDir.endsWith(path.join('app', 'resources'))) {
    throw new Error(`Store app detection self-test failed: bad resources path ${packageInfo.resourcesDir}`);
  }

  status('OK', 'Store app detection self-test');
}

async function askMenuChoice(prompt, question, validChoices, { defaultChoice = '', locale = 'en', invalidMessage } = {}) {
  while (true) {
    const answer = await prompt.ask(question);
    const normalized = answer || defaultChoice;
    if (validChoices.includes(normalized)) {
      return normalized;
    }

    status('WARN', invalidMessage || t(locale, 'unknownMenuTryAgain'));
  }
}

function printPirateLogo(locale) {
  const lines = [
    color(`                  ${icon('pirate')}${icon('gold')}${icon('skull')}`.trimEnd(), ANSI.yellow),
    color('                         .-""""-.', ANSI.yellow),
    color("                       .'  _   _  '.", ANSI.yellow),
    color('                      /   (o) (o)   \\', ANSI.yellow),
    color("                     |      .-.      |", ANSI.white),
    color("                     |     /###\\     |", ANSI.white),
    color("                      \\    \\___/    /", ANSI.white),
    color("                  _.-'`'--._____.--'`'-._", ANSI.red),
    color(`                .'  _   ${icon('pirate')}PIRATE CODEX   _ '.`, ANSI.red),
    color(`               /___/ \\___ ${icon('gold')}GOLD & BONES ___\\`, ANSI.yellow),
  ];

  console.log('');
  for (const line of lines) {
    console.log(line);
  }
  console.log(color(`             ${t(locale, 'subtitle')}`, ANSI.cyan));
}

function centerText(text) {
  const width = Number(process.stdout.columns || 80);
  const plain = String(text || '');
  const visibleLength = plain.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, Math.floor((width - visibleLength) / 2));
  return `${' '.repeat(padding)}${plain}`;
}

async function promptPirateCode(prompt, locale) {
  console.log('');
  console.log(color(centerText(`${icon('pirate')}${t(locale, 'pirateQuestionTitle')}`), ANSI.yellow));
  console.log(color(centerText(t(locale, 'pirateQuestionBody')), ANSI.gray));
  console.log('');
  console.log(centerText(`1. ${t(locale, 'pirateOptionYes')}`));
  console.log(centerText(`2. ${t(locale, 'pirateOptionLoose')}`));
  await askMenuChoice(
    prompt,
    color(centerText(t(locale, 'pirateQuestionPrompt')), ANSI.cyan),
    ['1', '2'],
    {
      defaultChoice: '1',
      locale,
    },
  );
}

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
  banner(t(CURRENT_LOCALE, 'failureBanner'), ANSI.red);
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

function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTopLevelAssignment(line, key) {
  const pattern = new RegExp(`^(\\s*${escapeRegex(key)}\\s*=\\s*)([^#\\n]*?)(\\s*(#.*)?)$`);
  const match = line.match(pattern);
  if (!match) {
    return null;
  }

  return {
    prefix: match[1],
    rawValue: match[2].trim(),
    suffix: match[3] || '',
  };
}

function findTopLevelKeyIndex(lines, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  return lines.findIndex((line) => pattern.test(line));
}

function parseTomlInteger(valueText) {
  const normalized = String(valueText || '').trim().replace(/_/g, '');
  if (!/^[+-]?\d+$/.test(normalized)) {
    return null;
  }

  return Number.parseInt(normalized, 10);
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function clampManagedNumber(key, value) {
  if (!Number.isFinite(value) || value <= 410000) {
    return value;
  }

  const base = key === 'model_context_window' ? 340000 : 290000;
  const clamped = roundToStep(base + ((value - 400000) * 0.12), 10000);
  return Math.min(value, clamped);
}

function updateExistingTopLevelLine(line, key, replacementValue) {
  const parts = splitTopLevelAssignment(line, key);
  if (!parts) {
    return `${key} = ${serializeTomlValue(replacementValue)}`;
  }

  return `${parts.prefix}${serializeTomlValue(replacementValue)}${parts.suffix}`;
}

function applyManagedDefaultsToPreamble(preambleLines, defaults, targetProviderId) {
  const lines = [...preambleLines];
  const existingDefaultIndices = [];
  const pendingDefaultInsertions = [];

  for (const key of DEFAULTS_KEY_ORDER) {
    const index = findTopLevelKeyIndex(lines, key);
    if (index === -1) {
      pendingDefaultInsertions.push({ key, value: defaults[key] });
      continue;
    }

    existingDefaultIndices.push(index);

    if (key === 'model_context_window' || key === 'model_auto_compact_token_limit') {
      const parts = splitTopLevelAssignment(lines[index], key);
      const parsed = parts ? parseTomlInteger(parts.rawValue) : null;
      if (parsed !== null) {
        const clamped = clampManagedNumber(key, parsed);
        if (clamped !== parsed) {
          lines[index] = updateExistingTopLevelLine(lines[index], key, clamped);
        }
      }
    }
  }

  const modelProviderIndex = findTopLevelKeyIndex(lines, 'model_provider');
  const isModelProviderMissing = modelProviderIndex === -1;
  if (!isModelProviderMissing) {
    lines[modelProviderIndex] = updateExistingTopLevelLine(lines[modelProviderIndex], 'model_provider', targetProviderId);
  }

  if (pendingDefaultInsertions.length > 0 || isModelProviderMissing) {
    const insertionLines = [
      ...pendingDefaultInsertions.map(({ key, value }) => `${key} = ${serializeTomlValue(value)}`),
    ];
    if (isModelProviderMissing) {
      insertionLines.push(`model_provider = ${serializeTomlValue(targetProviderId)}`);
    }

    const insertAt = !isModelProviderMissing
      ? modelProviderIndex
      : existingDefaultIndices.length > 0
        ? Math.max(...existingDefaultIndices) + 1
        : lines.length;
    lines.splice(insertAt, 0, ...insertionLines);
  }

  return lines;
}

function parseConfigDocument(text) {
  if (!text) {
    return {
      preambleLines: [],
      sections: [],
    };
  }

  const lines = normalizeNewlines(text).split('\n');
  const preambleLines = [];
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      currentSection = {
        name: match[1],
        headerLine: line,
        bodyLines: [],
      };
      sections.push(currentSection);
      continue;
    }

    if (currentSection) {
      currentSection.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  return { preambleLines, sections };
}

function renderConfigDocument(document, lineEnding) {
  const lines = [...document.preambleLines];
  for (const section of document.sections) {
    lines.push(section.headerLine, ...section.bodyLines);
  }

  let rendered = lines.join('\n');
  rendered = rendered.replace(/\n*$/, '\n');
  return rendered.replace(/\n/g, lineEnding);
}

function isProviderSection(section) {
  return /^model_providers\./.test(section.name);
}

function getProviderId(section) {
  const match = section.name.match(/^model_providers\.(.+)$/);
  return match ? match[1] : null;
}

function getProviderBaseUrl(section) {
  for (const line of section.bodyLines) {
    const match = line.match(/^\s*base_url\s*=\s*"([^"]+)"\s*(#.*)?$/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function cloneSection(section) {
  return {
    name: section.name,
    headerLine: section.headerLine,
    bodyLines: [...section.bodyLines],
  };
}

function getProviderSectionIndex(sections, providerId) {
  return sections.findIndex((section) => isProviderSection(section) && getProviderId(section) === providerId);
}

function getUniqueOldProviderId(sections) {
  const providerIds = new Set(
    sections.filter(isProviderSection).map((section) => getProviderId(section)),
  );

  if (!providerIds.has('codex-old')) {
    return 'codex-old';
  }

  let counter = 2;
  while (providerIds.has(`codex-old${counter}`)) {
    counter += 1;
  }

  return `codex-old${counter}`;
}

function buildManagedProviderSection(setupConfig) {
  return {
    name: `model_providers.${setupConfig.provider.id}`,
    headerLine: `[model_providers.${setupConfig.provider.id}]`,
    bodyLines: [
      `name = ${serializeTomlValue(setupConfig.provider.name, CURRENT_LOCALE)}`,
      `base_url = ${serializeTomlValue(setupConfig.provider.baseUrl, CURRENT_LOCALE)}`,
      `wire_api = ${serializeTomlValue(setupConfig.provider.wireApi, CURRENT_LOCALE)}`,
      `supports_websockets = ${serializeTomlValue(setupConfig.provider.supportsWebsockets, CURRENT_LOCALE)}`,
      '',
    ],
  };
}

function findMatchingProviderSectionIndex(sections, baseUrl) {
  let fallbackIndex = -1;

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!isProviderSection(section)) {
      continue;
    }

    if (getProviderBaseUrl(section) !== baseUrl) {
      continue;
    }

    const providerId = getProviderId(section);
    if (providerId === 'codex') {
      return index;
    }

    if (fallbackIndex === -1) {
      fallbackIndex = index;
    }
  }

  return fallbackIndex;
}

function getManagedProviderInsertIndex(sections, originalCodexIndex) {
  if (originalCodexIndex >= 0) {
    return originalCodexIndex;
  }

  const firstProviderIndex = sections.findIndex(isProviderSection);
  if (firstProviderIndex >= 0) {
    return firstProviderIndex;
  }

  return sections.length;
}

function ensureCanonicalProviderSection(document, setupConfig) {
  const sections = document.sections.map(cloneSection);
  const targetProviderId = setupConfig.provider.id;
  const baseUrl = setupConfig.provider.baseUrl;
  const matchingIndex = findMatchingProviderSectionIndex(sections, baseUrl);
  let codexIndex = getProviderSectionIndex(sections, targetProviderId);
  const managedSection = buildManagedProviderSection(setupConfig);

  if (matchingIndex === codexIndex && codexIndex >= 0) {
    sections[codexIndex] = managedSection;
    return sections;
  }

  if (codexIndex >= 0) {
    const renamedProviderId = getUniqueOldProviderId(sections);
    sections[codexIndex] = {
      ...sections[codexIndex],
      name: `model_providers.${renamedProviderId}`,
      headerLine: `[model_providers.${renamedProviderId}]`,
    };
  }

  const insertAt = getManagedProviderInsertIndex(sections, codexIndex);
  sections.splice(insertAt, 0, managedSection);
  return sections;
}

function ensureExists(filePath, description, locale = CURRENT_LOCALE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(t(locale, 'descriptionNotFound', description, filePath));
  }
}

function openSqliteDatabase(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { timeout: 5000 });
}

function parseArgs(argv) {
  const options = {
    configPath: '',
    codexHome: process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'),
    backupDir: DEFAULT_BACKUP_DIR,
    checkDependencies: false,
    checkProviderConfig: false,
    selfTestDependencyWarn: false,
    selfTestStoreAppDetection: false,
    locale: CURRENT_LOCALE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check-dependencies') {
      options.checkDependencies = true;
      continue;
    }

    if (arg === '--check-provider-config') {
      options.checkProviderConfig = true;
      continue;
    }

    if (arg === '--self-test-dependency-warn') {
      options.selfTestDependencyWarn = true;
      continue;
    }

    if (arg === '--self-test-store-app-detection') {
      options.selfTestStoreAppDetection = true;
      continue;
    }

    if (arg === '--locale') {
      index += 1;
      const locale = String(argv[index] || '').trim().toLowerCase();
      if (locale === 'en' || locale === 'ru') {
        options.locale = locale;
      }
      continue;
    }

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

function readSetupConfig(configPath, locale = CURRENT_LOCALE) {
  ensureExists(configPath, t(locale, 'setupConfigLabel'), locale);
  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(t(locale, 'setupConfigInvalidJson', configPath));
  }

  const provider = parsed && typeof parsed === 'object' ? parsed.provider : null;
  const defaults = parsed && typeof parsed === 'object' ? parsed.defaults : null;
  const defaultEndpoint = parsed && typeof parsed === 'object' ? parsed.defaultEndpoint : null;

  if (!provider || typeof provider !== 'object') {
    throw new Error(t(locale, 'setupConfigMissingObject', 'provider'));
  }

  if (!provider.id || typeof provider.id !== 'string') {
    throw new Error(t(locale, 'setupConfigMissingString', 'provider.id'));
  }

  if (!provider.name || typeof provider.name !== 'string') {
    throw new Error(t(locale, 'setupConfigMissingString', 'provider.name'));
  }

  if (!provider.wireApi || typeof provider.wireApi !== 'string') {
    throw new Error(t(locale, 'setupConfigMissingString', 'provider.wireApi'));
  }

  if (typeof provider.supportsWebsockets !== 'boolean') {
    throw new Error(t(locale, 'setupConfigMissingBoolean', 'provider.supportsWebsockets'));
  }

  if (provider.envKey != null && typeof provider.envKey !== 'string') {
    throw new Error(t(locale, 'setupConfigFieldString', 'provider.envKey'));
  }
  validateEnvKeyName(provider.envKey || 'CODEX_LB_API_KEY', locale);

  if (provider.requiresOpenaiAuth != null && typeof provider.requiresOpenaiAuth !== 'boolean') {
    throw new Error(t(locale, 'setupConfigMissingBoolean', 'provider.requiresOpenaiAuth'));
  }

  if (!defaults || typeof defaults !== 'object') {
    throw new Error(t(locale, 'setupConfigMissingObject', 'defaults'));
  }

  if (defaultEndpoint != null && typeof defaultEndpoint !== 'string') {
    throw new Error(t(locale, 'setupConfigFieldString', 'defaultEndpoint'));
  }

  for (const key of DEFAULTS_KEY_ORDER) {
    if (!(key in defaults)) {
      throw new Error(t(locale, 'setupConfigMissingDefault', key));
    }
  }

  return {
    defaultEndpoint: defaultEndpoint || 'http://144.31.220.80:2455/backend-api/codex',
    provider: {
      id: provider.id,
      name: provider.name,
      wireApi: provider.wireApi,
      envKey: provider.envKey || 'CODEX_LB_API_KEY',
      supportsWebsockets: provider.supportsWebsockets,
      requiresOpenaiAuth: provider.requiresOpenaiAuth === true,
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
  const powershell = findPowerShell7ExecutableInPath();
  if (!powershell) {
    return { code: -1, stdout: '', stderr: 'pwsh.exe not found' };
  }

  return runProcessCapture(powershell, [
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
  const powershell = findPowerShell7ExecutableInPath();
  if (!powershell) {
    return { code: -1, stdout: '', stderr: 'pwsh.exe not found' };
  }

  return runProcessCapture(powershell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ]);
}

async function createZipArchive(sourceDir, zipPath, locale = CURRENT_LOCALE) {
  const attempts = [
    {
      name: 'PowerShell ZipFile',
      run: () => tryPowerShellDotNetZip(sourceDir, zipPath),
    },
    {
      name: 'Compress-Archive',
      run: () => tryPowerShellCompressArchive(sourceDir, zipPath),
    },
    {
      name: 'tar.exe',
      run: () => tryTarZip(path.dirname(sourceDir), path.basename(sourceDir), zipPath),
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

  throw new Error(t(locale, 'backupArchiveCreationFailed', failures.join(' | ')));
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

async function createBackupArchive(codexHome, backupDir, locale = 'en') {
  await fsp.mkdir(backupDir, { recursive: true });
  const recentBackup = await findRecentBackupZip(backupDir);
  if (recentBackup) {
    banner(t(locale, 'reusingBackupBanner'), ANSI.yellow);
    status('INFO', t(locale, 'backupAge', formatDuration(Date.now() - recentBackup.mtimeMs)));
    status('OK', t(locale, 'backupArchive', recentBackup.path));
    return recentBackup.path;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const zipPath = path.join(backupDir, `codex-setup-${stamp}.zip`);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-setup-'));
  const stageRoot = path.join(tempRoot, 'codex-home-snapshot');

  await fsp.mkdir(stageRoot, { recursive: true });

  try {
    const files = await listFilesRecursive(codexHome);
    banner(t(locale, 'creatingBackupBanner'), ANSI.yellow);
    status('INFO', t(locale, 'stagingFiles', files.length, codexHome));

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      const relativePath = path.relative(codexHome, filePath);
      const destination = path.join(stageRoot, relativePath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(filePath, destination);
      renderProgress('Backup snapshot', index + 1, files.length || 1, relativePath);
    }

    const spinner = createSpinner(t(locale, 'compressingBackup'));
    spinner.start();
    let archiveMethod = '';
    try {
      archiveMethod = await createZipArchive(stageRoot, zipPath, locale);
    } finally {
      spinner.stop();
    }

    status('OK', t(locale, 'backupCreated', archiveMethod, zipPath));
    return zipPath;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function normalizeTextForComparison(text) {
  return normalizeNewlines(String(text || '')).replace(/\n*$/, '\n');
}

function getNextSidecarBackupPath(filePath) {
  const parsed = path.parse(filePath);
  for (let counter = 1; ; counter += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}${counter}${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

function writeFileWithSidecarBackup(filePath, nextText) {
  const normalizedNext = normalizeTextForComparison(nextText);
  const existed = fs.existsSync(filePath);
  const currentText = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const normalizedCurrent = normalizeTextForComparison(currentText);

  if (existed && normalizedCurrent === normalizedNext) {
    return {
      changed: false,
      created: false,
      backupPath: '',
    };
  }

  let backupPath = '';
  if (existed) {
    backupPath = getNextSidecarBackupPath(filePath);
    fs.writeFileSync(backupPath, currentText, 'utf8');
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextText, 'utf8');
  return {
    changed: true,
    created: !existed,
    backupPath,
  };
}

function serializeTomlValue(value, locale = CURRENT_LOCALE) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(t(locale, 'numericTomlFinite'));
    }

    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  throw new Error(t(locale, 'unsupportedTomlValueType', typeof value));
}

function buildDefaultsBlock(defaults, locale = CURRENT_LOCALE) {
  const seen = new Set();
  const lines = [];

  for (const key of DEFAULTS_KEY_ORDER) {
    lines.push(`${key} = ${serializeTomlValue(defaults[key], locale)}`);
    seen.add(key);
  }

  for (const key of Object.keys(defaults)) {
    if (seen.has(key)) {
      continue;
    }

    lines.push(`${key} = ${serializeTomlValue(defaults[key], locale)}`);
  }

  return lines.join('\n');
}

function buildConfigTomlText(setupConfig, lineEnding = '\r\n') {
  const provider = setupConfig.provider;
  const lines = [
    ...buildDefaultsBlock(setupConfig.defaults, CURRENT_LOCALE).split('\n'),
    `model_provider = ${serializeTomlValue(provider.id, CURRENT_LOCALE)}`,
    '',
    `[model_providers.${provider.id}]`,
    `name = ${serializeTomlValue(provider.name, CURRENT_LOCALE)}`,
    `base_url = ${serializeTomlValue(provider.baseUrl, CURRENT_LOCALE)}`,
    ...CODEX_PROVIDER_COMMENTED_BASE_URLS.map((baseUrl) => `#base_url = ${serializeTomlValue(baseUrl, CURRENT_LOCALE)}`),
    `wire_api = ${serializeTomlValue(provider.wireApi, CURRENT_LOCALE)}`,
    `env_key = ${serializeTomlValue(provider.envKey, CURRENT_LOCALE)}`,
    `supports_websockets = ${serializeTomlValue(provider.supportsWebsockets, CURRENT_LOCALE)}`,
    `requires_openai_auth = ${serializeTomlValue(provider.requiresOpenaiAuth, CURRENT_LOCALE)} # required for codex app`,
    '',
  ];

  return lines.join(lineEnding);
}

function updateConfigToml(configPath, setupConfig) {
  const originalText = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8')
    : '';
  const lineEnding = originalText ? detectLineEnding(originalText) : '\r\n';
  const nextText = buildConfigTomlText(setupConfig, lineEnding);
  return writeFileWithSidecarBackup(configPath, nextText);
}

function assertProviderConfigSmoke(setupConfig, locale = CURRENT_LOCALE) {
  const configText = buildConfigTomlText({
    ...setupConfig,
    provider: {
      ...setupConfig.provider,
      baseUrl: setupConfig.defaultEndpoint,
    },
  }, '\n');
  const requiredLines = [
    `model_provider = ${serializeTomlValue(setupConfig.provider.id, locale)}`,
    `[model_providers.${setupConfig.provider.id}]`,
    `base_url = ${serializeTomlValue(setupConfig.defaultEndpoint, locale)}`,
    `wire_api = ${serializeTomlValue(setupConfig.provider.wireApi, locale)}`,
    `env_key = ${serializeTomlValue(setupConfig.provider.envKey, locale)}`,
    `supports_websockets = ${serializeTomlValue(setupConfig.provider.supportsWebsockets, locale)}`,
    `requires_openai_auth = ${serializeTomlValue(setupConfig.provider.requiresOpenaiAuth, locale)} # required for codex app`,
  ];

  for (const line of requiredLines) {
    if (!configText.includes(line)) {
      throw new Error(`Provider config smoke failed: missing ${line}`);
    }
  }

  validateApiKey('sk-omni-v2-clb-1db625538245-d569315a.0afb8ff473860de2ff1e805f156', locale);
  for (const badKey of ['-sk-example', 'sk-example.', '.']) {
    let rejected = false;
    try {
      validateApiKey(badKey, locale);
    } catch (error) {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`Provider config smoke failed: invalid API key accepted: ${badKey}`);
    }
  }

  return configText;
}

async function scanSessions(sessionsRoot) {
  const locale = scanSessions.locale || 'en';
  const entries = [];
  const allFiles = await listFilesRecursive(sessionsRoot);
  const jsonlFiles = allFiles.filter((filePath) => filePath.toLowerCase().endsWith('.jsonl'));
  const providerRegex = /"model_provider":"([^"]+)"/;

  banner(t(locale, 'scanSessionsBanner'), ANSI.cyan);
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
    renderProgress(t(locale, 'scanSessionsProgress'), index + 1, jsonlFiles.length || 1, relativePath);
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
    const db = openSqliteDatabase(dbPath);
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

function printProviderSummary(providerCounts, sourceLabel, locale = 'en') {
  banner(t(locale, 'detectedProviders', sourceLabel), ANSI.cyan);

  const rows = [...providerCounts.entries()]
    .map(([provider, count]) => ({ provider, count }))
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider));

  if (rows.length === 0) {
    status('WARN', t(locale, 'noProviderChats'));
    return;
  }

  for (const row of rows) {
    console.log(`  ${color(row.provider, ANSI.bold)}: ${color(String(row.count), ANSI.green)} ${t(locale, 'chatWord', row.count)}`);
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

async function promptLanguage(prompt) {
  console.log('');
  console.log(color(t('ru', 'languageOptionEnglish'), ANSI.cyan));
  console.log(color(t('ru', 'languageOptionRussian'), ANSI.green));
  const answer = await askMenuChoice(
    prompt,
    color(t('ru', 'languagePrompt'), ANSI.yellow),
    ['1', '2', 'en', 'EN', 'ru', 'RU'],
    {
      defaultChoice: '2',
      invalidMessage: t('ru', 'unknownLanguageOption'),
    },
  );
  if (answer === '2' || /^ru$/i.test(answer)) {
    return 'ru';
  }

  if (answer === '1' || /^en$/i.test(answer)) {
    return 'en';
  }

  return 'ru';
}

function normalizeEndpointInput(value, locale = 'en') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error(t(locale, 'endpointEmpty'));
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsedUrl;
  try {
    parsedUrl = new URL(withScheme);
  } catch (error) {
    throw new Error(t(locale, 'invalidEndpoint', trimmed));
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
  const locale = prompt.locale || 'en';
  const defaultEndpoint = setupConfig.defaultEndpoint;
  const endpointAnswer = await prompt.ask(
    color(t(locale, 'enterEndpoint', color(defaultEndpoint, ANSI.gray)), ANSI.cyan),
  );
  const apiKeyAnswer = await prompt.ask(color(t(locale, 'enterApiKey'), ANSI.cyan));

  const endpointInput = String(endpointAnswer || '').trim() || defaultEndpoint;
  const baseUrl = normalizeEndpointInput(endpointInput, locale);
  const apiKey = String(apiKeyAnswer || '').trim();

  let envAction = { mode: 'keep', name: setupConfig.provider.envKey };
  if (apiKey) {
    validateApiKey(apiKey, locale);
    envAction = {
      mode: 'set',
      name: setupConfig.provider.envKey,
      apiKey,
    };
  }

  console.log('');
  console.log(t(locale, 'sessionsIntro', color(setupConfig.provider.id, ANSI.green)));
  console.log(`  1. ${t(locale, 'sessionsNoDefault')}`);
  console.log(`  2. ${t(locale, 'sessionsYes', color(setupConfig.provider.id, ANSI.green))}`);
  const sessionChoice = await askMenuChoice(
    prompt,
    color(t(locale, 'updateSessionsPrompt'), ANSI.cyan),
    ['1', '2'],
    {
      defaultChoice: '1',
      locale,
      invalidMessage: locale === 'ru'
        ? 'Неизвестный вариант обновления сессий. Попробуйте снова.'
        : 'Unknown session update option. Try again.',
    },
  );
  const updateSessions = sessionChoice === '2';

  console.log('');
  console.log(color(t(locale, 'backupMenuTitle'), ANSI.yellow));
  console.log(`  1. ${t(locale, 'backupYesDefault')}`);
  console.log(`  2. ${t(locale, 'backupNo')}`);
  const backupChoice = await askMenuChoice(
    prompt,
    color(t(locale, 'backupPrompt'), ANSI.cyan),
    ['1', '2'],
    {
      defaultChoice: '1',
      locale,
      invalidMessage: locale === 'ru'
        ? 'Неизвестный вариант backup. Попробуйте снова.'
        : 'Unknown backup option. Try again.',
    },
  );
  const createBackup = backupChoice === '1';

  return {
    ...setupConfig,
    envAction,
    updateSessions,
    createBackup,
    provider: {
      ...setupConfig.provider,
      baseUrl,
    },
  };
}

async function chooseProviders(prompt, providerCounts) {
  const locale = prompt.locale || 'en';
  const targetProvider = prompt.targetProvider;
  const rows = [...providerCounts.entries()]
    .map(([provider, count]) => ({ provider, count: Number(count || 0) }))
    .sort((left, right) => right.count - left.count || left.provider.localeCompare(right.provider));
  const selectableRows = rows.filter((row) => row.provider !== targetProvider);
  const totalChats = rows.reduce((sum, row) => sum + row.count, 0);
  const convertibleChats = selectableRows.reduce((sum, row) => sum + row.count, 0);

  console.log('');
  if (selectableRows.length === 0) {
    console.log(`  1. ${t(locale, 'menuConvertAllNoChanges', color(targetProvider, ANSI.green), totalChats)}`);
    console.log(`  0. ${t(locale, 'menuCancel')}`);

    const answer = await askMenuChoice(
      prompt,
      color(t(locale, 'selectOption'), ANSI.cyan),
      ['0', '1'],
      {
        locale,
      },
    );
    if (answer === '0') {
      return null;
    }

    if (answer === '1') {
      return [];
    }
  }

  selectableRows.forEach((row, index) => {
    console.log(`  ${index + 1}. ${t(locale, 'menuReplace', color(row.provider, ANSI.bold), color(targetProvider, ANSI.green), row.count)}`);
  });

  const convertAllOption = selectableRows.length + 1;
  console.log(`  ${convertAllOption}. ${t(locale, 'menuConvertAll', color(targetProvider, ANSI.green), totalChats, convertibleChats)}`);
  console.log(`  0. ${t(locale, 'menuCancel')}`);

  const validChoices = ['0', ...Array.from({ length: convertAllOption }, (_, index) => String(index + 1))];
  const answer = await askMenuChoice(
    prompt,
    color(t(locale, 'selectOption'), ANSI.cyan),
    validChoices,
    {
      locale,
    },
  );
  if (answer === '0') {
    return null;
  }

  const choice = Number.parseInt(answer, 10);

  if (choice === convertAllOption) {
    return selectableRows.map((row) => row.provider);
  }

  return [selectableRows[choice - 1].provider];
}

async function retagSessionFiles(sessionEntries, fromProviders, toProvider) {
  const locale = retagSessionFiles.locale || 'en';
  let updated = 0;
  const matchingEntries = sessionEntries.filter((entry) => fromProviders.includes(entry.provider));

  banner(t(locale, 'updateJsonlBanner'), ANSI.cyan);
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

    renderProgress(t(locale, 'updateJsonlProgress'), index + 1, matchingEntries.length || 1, entry.relativePath);
  }

  return { scanned: matchingEntries.length, updated };
}

function retagSqliteFiles(dbPaths, fromProviders, toProvider) {
  const locale = retagSqliteFiles.locale || 'en';
  const results = [];

  banner(t(locale, 'updateSqliteBanner'), ANSI.cyan);
  for (let index = 0; index < dbPaths.length; index += 1) {
    const dbPath = dbPaths[index];
    const db = openSqliteDatabase(dbPath);
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
    renderProgress(t(locale, 'updateSqliteProgress'), index + 1, dbPaths.length || 1, path.basename(dbPath));
  }

  return results;
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  if (options.checkDependencies) {
    CURRENT_LOCALE = options.locale;
    const dependencyMap = buildDependencyMap(options.locale);
    printDependencyMap(options.locale, dependencyMap);
    ensureCriticalDependencies(dependencyMap, options.locale);
    return;
  }

  if (options.checkProviderConfig) {
    CURRENT_LOCALE = options.locale;
    if (!options.configPath) {
      throw new Error(t(CURRENT_LOCALE, 'missingConfigArg'));
    }

    const setupConfig = readSetupConfig(options.configPath, options.locale);
    const configText = assertProviderConfigSmoke(setupConfig, options.locale);
    console.log(configText.trimEnd());
    return;
  }

  if (options.selfTestDependencyWarn) {
    CURRENT_LOCALE = options.locale;
    await runDependencyWarnSelfTest(options.locale);
    return;
  }

  if (options.selfTestStoreAppDetection) {
    CURRENT_LOCALE = options.locale;
    runStoreAppDetectionSelfTest(options.locale);
    return;
  }

  if (!options.configPath) {
    throw new Error(t(CURRENT_LOCALE, 'missingConfigArg'));
  }

  const codexHome = options.codexHome;
  const configPath = path.join(codexHome, 'config.toml');
  const sessionsRoot = path.join(codexHome, 'sessions');

  await fsp.mkdir(codexHome, { recursive: true });

  if (!process.stdin.isTTY) {
    throw new Error(t(CURRENT_LOCALE, 'interactiveTtyRequired'));
  }

  const prompt = createPrompt();
  try {
    const locale = await promptLanguage(prompt);
    CURRENT_LOCALE = locale;
    prompt.locale = locale;
    const staticConfig = readSetupConfig(options.configPath, locale);
    printPirateLogo(locale);
    banner(t(locale, 'appTitle'), ANSI.magenta);
    status('INFO', t(locale, 'setupConfig', options.configPath));
    status('INFO', t(locale, 'codexHome', codexHome));
    status('INFO', t(locale, 'provider', staticConfig.provider.id));
    await promptPirateCode(prompt, locale);
    const pathRepairActions = repairPathForDependencies(locale);
    if (pathRepairActions.length > 0) {
      banner(t(locale, 'pathRepairBanner'), ANSI.yellow);
      for (const action of pathRepairActions) {
        status(action.level, action.message);
      }
    }
    const dependencyMap = buildDependencyMap(locale);
    printDependencyMap(locale, dependencyMap);
    ensureCriticalDependencies(dependencyMap, locale);
    banner(`${icon('anchor')}${t(locale, 'cargoReadyBanner')}`, ANSI.green);
    status('INFO', t(locale, 'cargoReadyStatus'));

    const setupConfig = await promptConnectionDetails(prompt, staticConfig);
    const targetProvider = setupConfig.provider.id;
    status('INFO', t(locale, 'baseUrl', setupConfig.provider.baseUrl));

    let backupZip = null;
    if (setupConfig.createBackup) {
      backupZip = await createBackupArchive(codexHome, options.backupDir, locale);
    }

    banner(t(locale, 'writeConfigBanner'), ANSI.cyan);
    const configUpdate = updateConfigToml(configPath, setupConfig);
    if (setupConfig.envAction.mode === 'set') {
      const envUpdate = setUserEnvironmentVariable(setupConfig.envAction.name, setupConfig.envAction.apiKey);
      status('OK', t(locale, 'updatedEnvKey', envUpdate.name, envUpdate.scope));
    } else {
      status('OK', t(locale, 'keptEnvKey', setupConfig.envAction.name));
    }
    if (configUpdate.backupPath) {
      status('INFO', t(locale, 'sidecarBackup', 'config.toml', configUpdate.backupPath));
    }
    if (configUpdate.changed) {
      status('OK', t(locale, 'updatedConfig', configPath));
    } else {
      status('OK', t(locale, 'keptConfig', configPath));
    }

    if (!setupConfig.updateSessions) {
      banner(t(locale, 'summaryBanner'), ANSI.green);
      status('INFO', backupZip ? t(locale, 'backupArchive', backupZip) : t(locale, 'backupSkipped'));
      status('INFO', t(locale, 'sessionsUnchanged'));
      status('INFO', t(locale, 'sessionsRetryLater'));
      status('INFO', t(locale, 'elapsed', formatDuration(Date.now() - startedAt)));
      status('OK', t(locale, 'setupCompleted', targetProvider));
      return;
    }

    ensureExists(codexHome, 'Codex home');
    scanSessions.locale = locale;
    retagSessionFiles.locale = locale;
    retagSqliteFiles.locale = locale;
    const sessionEntries = await scanSessions(sessionsRoot);
    const sqliteFiles = await findStateDatabases(codexHome);
    const sqliteProviderCounts = collectProviderCountsFromSqlite(sqliteFiles);
    const sessionProviderCounts = collectProviderCountsFromSessions(sessionEntries);
    const providerCounts = sqliteProviderCounts.size > 0 ? sqliteProviderCounts : sessionProviderCounts;
    const providerSource = sqliteProviderCounts.size > 0 ? t(locale, 'sourceSqlite') : t(locale, 'sourceJsonl');

    printProviderSummary(providerCounts, providerSource, locale);
    prompt.targetProvider = targetProvider;
    const fromProviders = await chooseProviders(prompt, providerCounts);
    if (fromProviders === null) {
      status('WARN', t(locale, 'cancelled'));
      return;
    }

    const availableLegacyProviders = fromProviders.filter((provider) => providerCount(providerCounts, provider) > 0);
    if (fromProviders.length === 0) {
      banner(t(locale, 'summaryBanner'), ANSI.green);
      status('INFO', backupZip ? t(locale, 'backupArchive', backupZip) : t(locale, 'backupSkipped'));
      status('INFO', t(locale, 'allAlreadyUsing', targetProvider));
      status('INFO', t(locale, 'elapsed', formatDuration(Date.now() - startedAt)));
      status('OK', t(locale, 'setupCompleted', targetProvider));
      return;
    }

    if (availableLegacyProviders.length === 0) {
      throw new Error(t(locale, 'noLegacyChatsFound'));
    }

    console.log('');
    status('INFO', t(locale, 'converting', availableLegacyProviders.join(', '), targetProvider));

    const sessionUpdate = await retagSessionFiles(sessionEntries, availableLegacyProviders, targetProvider);
    const sqliteUpdate = retagSqliteFiles(sqliteFiles, availableLegacyProviders, targetProvider);

    let remainingRows = 0;
    for (const dbPath of sqliteFiles) {
      const db = openSqliteDatabase(dbPath);
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

    banner(t(locale, 'summaryBanner'), ANSI.green);
    status('INFO', backupZip ? t(locale, 'backupArchive', backupZip) : t(locale, 'backupSkipped'));
    status('INFO', t(locale, 'jsonlUpdated', sessionUpdate.updated, sessionUpdate.scanned));
    status('INFO', t(locale, 'sqliteChecked', sqliteUpdate.length));
    for (const row of sqliteUpdate) {
      console.log(`  - ${path.basename(row.dbPath)}: ${row.before} -> ${row.after} (changed ${row.changed})`);
    }
    status('INFO', t(locale, 'remainingJsonl', remainingSessionFiles));
    status('INFO', t(locale, 'remainingSqlite', remainingRows));
    status('INFO', t(locale, 'elapsed', formatDuration(Date.now() - startedAt)));

    if (remainingSessionFiles === 0 && remainingRows === 0) {
      status('OK', t(locale, 'setupAndConversionCompleted', targetProvider));
      return;
    }

    throw new Error(t(locale, 'oldRefsRemain'));
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
