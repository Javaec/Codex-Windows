import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeProfileName } from "../args";
import { fileExists, removePath, writeWarn } from "../exec";
import { writeRuntimeLaneCompareTools } from "./runtime-compare";

type LauncherVariant = {
  fileName: string;
  env: Record<string, string>;
  laneName: string;
  userDataSuffix: string;
};

function buildPortableLauncherScript(
  profile: string,
  userDataFolder: string,
  cacheFolder: string,
  laneName: string,
  extraEnv: Record<string, string>,
): string {
  const extraEnvLines = Object.entries(extraEnv)
    .map(([key, value]) => `set "${key}=${value}"`)
    .join("\n");
  return `@echo off
setlocal

set "BASE=%~dp0"
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\\Windows"

set "PATH=%WINROOT%\\System32;%WINROOT%;%WINROOT%\\System32\\Wbem;%WINROOT%\\System32\\WindowsPowerShell\\v1.0;%ProgramFiles%\\PowerShell\\7;%ProgramFiles%\\nodejs;%ProgramFiles(x86)%\\nodejs;%APPDATA%\\npm;%PATH%"
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
if not exist "%BASE%resources\\mods" (
  echo [ERROR] Portable modpack missing: "%BASE%resources\\mods"
  exit /b 1
)
set "CODEX_MODS_DIR=%BASE%resources\\mods"
if not exist "%BASE%resources\\mod-api" (
  echo [ERROR] Portable mod API missing: "%BASE%resources\\mod-api"
  exit /b 1
)
set "CODEX_MOD_API_DIR=%BASE%resources\\mod-api"
set "CODEX_WINDOWS_PROFILE=${profile}"
set "CODEX_GIT_CAPABILITY_CACHE=%BASE%resources\\git-capability-cache.json"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"
set "ELECTRON_ENABLE_LOGGING=1"
set "CODEX_RUNTIME_LANE=${laneName}"
${extraEnvLines}

if defined CODEX_HOME if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%" >nul 2>nul
if not exist "%BASE%${userDataFolder}" mkdir "%BASE%${userDataFolder}" >nul 2>nul
if not exist "%BASE%${cacheFolder}" mkdir "%BASE%${cacheFolder}" >nul 2>nul
if not exist "%BASE%runtime-logs" mkdir "%BASE%runtime-logs" >nul 2>nul
if not exist "%BASE%runtime-logs\\${laneName}" mkdir "%BASE%runtime-logs\\${laneName}" >nul 2>nul

set "CHROME_LOG_FILE=%BASE%runtime-logs\\${laneName}\\chromium.log"
set "CODEX_RUNTIME_STDOUT_LOG=%BASE%runtime-logs\\${laneName}\\stdout-latest.log"
set "CODEX_RUNTIME_ENV_LOG=%BASE%runtime-logs\\${laneName}\\launch.env.txt"

> "%CODEX_RUNTIME_ENV_LOG%" (
  echo lane=${laneName}
  echo profile=${profile}
  echo userData=%BASE%${userDataFolder}
  echo cache=%BASE%${cacheFolder}
  echo codexHome=%CODEX_HOME%
  echo cli=%BASE%resources\\codex.exe
  echo mods=%BASE%resources\\mods
  echo modApi=%BASE%resources\\mod-api
  echo runtimeMods=%CODEX_ENABLE_RUNTIME_MODS%
  echo runtimeModsDisabled=%CODEX_MODS_DISABLED%
  echo runtimeModsOnly=%CODEX_MODS_ONLY%
  echo minimal=%CODEX_WINDOWS_MINIMAL%
  echo launchTime=%DATE% %TIME%
)

"%BASE%Codex.exe" --enable-logging --log-file="%CHROME_LOG_FILE%" --user-data-dir="%BASE%${userDataFolder}" --disk-cache-dir="%BASE%${cacheFolder}" > "%CODEX_RUNTIME_STDOUT_LOG%" 2>&1
exit /b %ERRORLEVEL%
`;
}

function writePortableVariantLaunchers(outputDir: string, profile: string, userDataFolder: string, cacheFolder: string): void {
  const variants: LauncherVariant[] = [
    {
      fileName: "Launch-Codex-no-mods.cmd",
      env: { CODEX_ENABLE_RUNTIME_MODS: "0", CODEX_MODS_DISABLED: "1" },
      laneName: "no-mods",
      userDataSuffix: "-no-mods",
    },
    {
      fileName: "Launch-Codex-minimal.cmd",
      env: { CODEX_ENABLE_RUNTIME_MODS: "0", CODEX_MODS_DISABLED: "1", CODEX_WINDOWS_MINIMAL: "1" },
      laneName: "minimal",
      userDataSuffix: "-minimal",
    },
    {
      fileName: "Launch-Codex-with-mods.cmd",
      env: { CODEX_ENABLE_RUNTIME_MODS: "1" },
      laneName: "with-mods",
      userDataSuffix: "-with-mods",
    },
    {
      fileName: "Launch-Codex-isolated-home.cmd",
      env: {
        CODEX_ENABLE_RUNTIME_MODS: "0",
        CODEX_MODS_DISABLED: "1",
        CODEX_HOME: "%BASE%codex-home-isolated",
      },
      laneName: "isolated-home",
      userDataSuffix: "-isolated-home",
    },
  ];
  const modsDir = path.join(outputDir, "resources", "mods");
  if (fileExists(modsDir)) {
    for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      variants.push({
        fileName: `Launch-Codex-only-${entry.name}.cmd`,
        env: { CODEX_ENABLE_RUNTIME_MODS: "1", CODEX_MODS_ONLY: entry.name },
        laneName: `only-${entry.name}`,
        userDataSuffix: `-only-${entry.name}`,
      });
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
        variant.env,
      ),
      "ascii",
    );
  }
}

export function writePortableLauncher(outputDir: string, profileName: string): string {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
  const cacheFolder = isDefault ? "cache" : `cache-${profile}`;
  const launcherPath = path.join(outputDir, "Launch-Codex.cmd");
  fs.writeFileSync(
    launcherPath,
    buildPortableLauncherScript(profile, userDataFolder, cacheFolder, "default", {
      CODEX_ENABLE_RUNTIME_MODS: "0",
      CODEX_MODS_DISABLED: "1",
    }),
    "ascii",
  );
  writePortableVariantLaunchers(outputDir, profile, userDataFolder, cacheFolder);
  writeRuntimeLaneCompareTools(outputDir);
  return launcherPath;
}

export function writeLatestPortableLaunchers(distDir: string, outputDir: string): void {
  const launchers = [
    { outputPath: path.join(distDir, "Launch-Codex-latest.cmd"), targetPath: path.join(outputDir, "Launch-Codex.cmd") },
    { outputPath: path.join(distDir, "Launch-Codex-latest-no-mods.cmd"), targetPath: path.join(outputDir, "Launch-Codex-no-mods.cmd") },
    { outputPath: path.join(distDir, "Launch-Codex-latest-minimal.cmd"), targetPath: path.join(outputDir, "Launch-Codex-minimal.cmd") },
    { outputPath: path.join(distDir, "Launch-Codex-latest-with-mods.cmd"), targetPath: path.join(outputDir, "Launch-Codex-with-mods.cmd") },
    { outputPath: path.join(distDir, "Launch-Codex-latest-isolated-home.cmd"), targetPath: path.join(outputDir, "Launch-Codex-isolated-home.cmd") },
  ];
  for (const launcher of launchers) {
    if (!fileExists(launcher.targetPath)) {
      throw new Error(`Portable launcher missing: ${launcher.targetPath}`);
    }
    const relativeTarget = path.relative(distDir, launcher.targetPath).replace(/\//g, "\\");
    fs.writeFileSync(
      launcher.outputPath,
      `@echo off\nsetlocal\ncall "%~dp0${relativeTarget}"\nexit /b %ERRORLEVEL%\n`,
      "ascii",
    );
  }
}

export function pruneStalePortableOutputs(distDir: string, outputName: string): void {
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
      const message = error instanceof Error ? error.message : String(error);
      writeWarn(`Stale portable output could not be removed: ${targetPath} (${message})`);
    }
  }
}
