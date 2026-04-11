import * as fs from "node:fs";
import * as path from "node:path";
import { isCanonicalProfileName, isForgeProfileName, normalizeProfileName } from "../args";
import { describePathLock, fileExists, isBusyFsError, removePath, writeWarn } from "../exec";

type LauncherVariant = {
  fileName: string;
  env: Record<string, string>;
  laneName: string;
  runtimeModsEnabled: boolean;
  userDataSuffix: string;
};

function buildPortableLauncherScript(
  profile: string,
  userDataFolder: string,
  cacheFolder: string,
  laneName: string,
  runtimeModsEnabled: boolean,
  extraEnv: Record<string, string>,
): string {
  const extraEnvLines = Object.entries(extraEnv)
    .map(([key, value]) => `set "${key}=${value}"`)
    .join("\n");
  const runtimeModLines = runtimeModsEnabled
    ? `if not exist "%BASE%resources\\mods" (
  echo [ERROR] Portable modpack missing: "%BASE%resources\\mods"
  exit /b 1
)
set "CODEX_MODS_DIR=%BASE%resources\\mods"
if not exist "%BASE%resources\\mod-api" (
  echo [ERROR] Portable mod API missing: "%BASE%resources\\mod-api"
  exit /b 1
)
set "CODEX_MOD_API_DIR=%BASE%resources\\mod-api"
if not exist "%BASE%resources\\mod-loader" (
  echo [ERROR] Portable mod loader missing: "%BASE%resources\\mod-loader"
  exit /b 1
)
set "CODEX_MOD_LOADER_DIR=%BASE%resources\\mod-loader"`
    : `set "CODEX_MODS_DIR="
set "CODEX_MOD_API_DIR="
set "CODEX_MOD_LOADER_DIR="`;
  const runtimeLogLines = runtimeModsEnabled
    ? `  echo mods=%BASE%resources\\mods
  echo modApi=%BASE%resources\\mod-api
  echo modLoader=%BASE%resources\\mod-loader`
    : "";
  return `@echo off
setlocal

set "BASE=%~dp0"
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\\Windows"

set "PATH=%BASE%resources\\path;%BASE%resources;%BASE%;%WINROOT%\\System32;%WINROOT%;%WINROOT%\\System32\\Wbem;%WINROOT%\\System32\\WindowsPowerShell\\v1.0;%WINROOT%\\System32\\OpenSSH;%ProgramFiles%\\PowerShell\\7;%ProgramFiles%\\nodejs;%ProgramFiles%\\Git\\cmd;%ProgramFiles%\\Git\\bin;%ProgramFiles%\\Git\\usr\\bin;%ProgramFiles(x86)%\\nodejs;%ProgramFiles(x86)%\\Git\\cmd;%ProgramFiles(x86)%\\Git\\bin;%ProgramFiles(x86)%\\Git\\usr\\bin;%APPDATA%\\npm;%PATH%"
set "PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
set "COMSPEC=%WINROOT%\\System32\\cmd.exe"

if exist "%ProgramFiles%\\PowerShell\\7\\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles%\\PowerShell\\7\\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" set "CODEX_PWSH_PATH=%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

if not exist "%BASE%resources\\codex.exe" (
  echo [ERROR] Portable Codex CLI missing: "%BASE%resources\\codex.exe"
  exit /b 1
)
set "CODEX_CLI_PATH=%BASE%resources\\codex.exe"
${runtimeModLines}
set "CODEX_WINDOWS_PROFILE=${profile}"
set "CODEX_GIT_CAPABILITY_CACHE=%BASE%resources\\git-capability-cache.json"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"
set "ELECTRON_ENABLE_LOGGING=1"
set "CODEX_RUNTIME_LANE=${laneName}"
${extraEnvLines}

if defined CODEX_HOME if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%" >nul 2>nul
if /I "%CODEX_WINDOWS_SMOKE_MODE%"=="1" if defined CODEX_HOME if exist "%CODEX_HOME%\\vendor_imports\\skills\\.git\\index.lock" del /f /q "%CODEX_HOME%\\vendor_imports\\skills\\.git\\index.lock" >nul 2>nul
if not exist "%BASE%${userDataFolder}" mkdir "%BASE%${userDataFolder}" >nul 2>nul
if not exist "%BASE%${cacheFolder}" mkdir "%BASE%${cacheFolder}" >nul 2>nul
if not exist "%BASE%runtime-logs" mkdir "%BASE%runtime-logs" >nul 2>nul
if not exist "%BASE%runtime-logs\\${laneName}" mkdir "%BASE%runtime-logs\\${laneName}" >nul 2>nul

set "CHROME_LOG_FILE=%BASE%runtime-logs\\${laneName}\\chromium.log"
set "CODEX_RUNTIME_STDOUT_LOG=%BASE%runtime-logs\\${laneName}\\stdout-latest.log"
set "CODEX_RUNTIME_ENV_LOG=%BASE%runtime-logs\\${laneName}\\launch.env.txt"
set "CODEX_COMPACT_RUNTIME_LOG=%BASE%runtime-logs\\${laneName}\\compact-events.log"

> "%CODEX_RUNTIME_ENV_LOG%" (
  echo lane=${laneName}
  echo profile=${profile}
  echo userData=%BASE%${userDataFolder}
  echo cache=%BASE%${cacheFolder}
  echo codexHome=%CODEX_HOME%
  echo cli=%BASE%resources\\codex.exe
  echo rg=%BASE%resources\\rg.exe
  echo compactLog=%CODEX_COMPACT_RUNTIME_LOG%
${runtimeLogLines}
  echo runtimeMods=%CODEX_ENABLE_RUNTIME_MODS%
  echo runtimeModsDisabled=%CODEX_MODS_DISABLED%
  echo runtimeModsOnly=%CODEX_MODS_ONLY%
  echo minimal=%CODEX_WINDOWS_MINIMAL%
  echo launchTime=%DATE% %TIME%
)

if /I "%CODEX_COMPACT_DEBUG%"=="1" > "%CODEX_COMPACT_RUNTIME_LOG%" type nul
if /I "%CODEX_COMPACT_DEBUG%"=="1" (
  echo [INFO] Compact debug log: "%CODEX_COMPACT_RUNTIME_LOG%"
  echo [INFO] Full runtime stdout log: "%CODEX_RUNTIME_STDOUT_LOG%"
)

"%BASE%Codex.exe" --enable-logging --log-file="%CHROME_LOG_FILE%" --user-data-dir="%BASE%${userDataFolder}" --disk-cache-dir="%BASE%${cacheFolder}" > "%CODEX_RUNTIME_STDOUT_LOG%" 2>&1
exit /b %ERRORLEVEL%
`;
}

function writePortableVariantLaunchers(outputDir: string, profile: string, userDataFolder: string, cacheFolder: string): void {
  const variants: LauncherVariant[] = [
    {
      fileName: "Launch-Codex-compact-debug.cmd",
      env: {
        CODEX_ENABLE_RUNTIME_MODS: "0",
        CODEX_MODS_DISABLED: "1",
        CODEX_COMPACT_DEBUG: "1",
        CODEX_COMPACT_RUST_BACKTRACE: "1",
        CODEX_COMPACT_RUST_LOG: "info,codex_core::compact_remote=trace,codex_api::endpoint::compact=trace,codex_api::endpoint::responses=debug,codex_app_server_client=debug",
        CODEX_COMPACT_RUST_LOG_STYLE: "never",
      },
      laneName: "compact-debug",
      runtimeModsEnabled: false,
      userDataSuffix: "-compact-debug",
    },
    ...(isForgeProfileName(profile)
      ? [
      {
        fileName: "Launch-Codex-with-mods.cmd",
        env: { CODEX_ENABLE_RUNTIME_MODS: "1" },
        laneName: "with-mods",
        runtimeModsEnabled: true,
        userDataSuffix: "-with-mods",
      },
      ]
      : []),
  ];
  const expectedVariantLaunchers = new Set(["Launch-Codex.cmd", ...variants.map((variant) => variant.fileName)]);
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("Launch-Codex-")) continue;
    if (expectedVariantLaunchers.has(entry.name)) continue;
    const staleLauncherPath = path.join(outputDir, entry.name);
    try {
      removePath(staleLauncherPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeWarn(`Stale launcher could not be removed: ${staleLauncherPath} (${message})`);
    }
  }
  for (const variant of variants) {
    fs.writeFileSync(
      path.join(outputDir, variant.fileName),
      buildPortableLauncherScript(
        profile,
        `${userDataFolder}${variant.userDataSuffix}`,
        `${cacheFolder}${variant.userDataSuffix}`,
        variant.laneName,
        variant.runtimeModsEnabled,
        variant.env,
      ),
      "ascii",
    );
  }
}

export function writePortableLauncher(outputDir: string, profileName: string): string {
  const profile = normalizeProfileName(profileName);
  const isDefault = isCanonicalProfileName(profile);
  const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
  const cacheFolder = isDefault ? "cache" : `cache-${profile}`;
  const launcherPath = path.join(outputDir, "Launch-Codex.cmd");
  fs.writeFileSync(
    launcherPath,
    buildPortableLauncherScript(profile, userDataFolder, cacheFolder, "default", false, {
      CODEX_ENABLE_RUNTIME_MODS: "0",
      CODEX_MODS_DISABLED: "1",
    }),
    "ascii",
  );
  writePortableVariantLaunchers(outputDir, profile, userDataFolder, cacheFolder);
  return launcherPath;
}

export function writeLatestPortableLaunchers(distDir: string, outputDir: string, includeRuntimeMods: boolean): void {
  const launchers = [
    { outputPath: path.join(distDir, "Launch-Codex-latest.cmd"), targetPath: path.join(outputDir, "Launch-Codex.cmd") },
    { outputPath: path.join(distDir, "Launch-Codex-latest-compact-debug.cmd"), targetPath: path.join(outputDir, "Launch-Codex-compact-debug.cmd") },
    ...(includeRuntimeMods
      ? [{ outputPath: path.join(distDir, "Launch-Codex-latest-with-mods.cmd"), targetPath: path.join(outputDir, "Launch-Codex-with-mods.cmd") }]
      : []),
  ];
  const staleLatestLaunchers = [
    path.join(distDir, "Launch-Codex-latest-no-mods.cmd"),
    path.join(distDir, "Launch-Codex-latest-minimal.cmd"),
    path.join(distDir, "Launch-Codex-latest-isolated-home.cmd"),
    ...(fileExists(path.join(outputDir, "Launch-Codex-compact-debug.cmd")) ? [] : [path.join(distDir, "Launch-Codex-latest-compact-debug.cmd")]),
    ...(includeRuntimeMods ? [] : [path.join(distDir, "Launch-Codex-latest-with-mods.cmd")]),
  ];
  for (const staleLauncherPath of staleLatestLaunchers) {
    try {
      removePath(staleLauncherPath);
    } catch (error) {
      if (isBusyFsError(error)) {
        throw new Error(describePathLock("update latest portable launchers", staleLauncherPath, error));
      }
      throw error;
    }
  }
  for (const launcher of launchers) {
    if (!fileExists(launcher.targetPath)) {
      throw new Error(`Portable launcher missing: ${launcher.targetPath}`);
    }
    const relativeTarget = path.relative(distDir, launcher.targetPath).replace(/\//g, "\\");
    try {
      fs.writeFileSync(
        launcher.outputPath,
        `@echo off\nsetlocal\ncall "%~dp0${relativeTarget}"\nexit /b %ERRORLEVEL%\n`,
        "ascii",
      );
    } catch (error) {
      if (isBusyFsError(error)) {
        throw new Error(describePathLock("write latest portable launcher", launcher.outputPath, error));
      }
      throw error;
    }
  }
}

export function pruneStalePortableOutputs(distDir: string, outputName: string, strict = false): void {
  const staleNames = [`${outputName}-work`, `${outputName}-next`];
  if (!fileExists(distDir)) return;
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const isDirectStale = staleNames.includes(entry.name);
    const isNextVariant = entry.name.startsWith(`${outputName}-next-`);
    if (!isDirectStale && !isNextVariant) continue;
    const targetPath = path.join(distDir, entry.name);
    try {
      removePath(targetPath);
    } catch (error) {
      if (strict && isBusyFsError(error)) {
        throw new Error(describePathLock("prune stale portable output", targetPath, error));
      }
      const message = error instanceof Error ? error.message : String(error);
      writeWarn(`Stale portable output could not be removed: ${targetPath} (${message})`);
    }
  }
}
