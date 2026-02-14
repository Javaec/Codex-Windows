import * as fs from "node:fs";
import * as path from "node:path";
import {
  copyDirectory,
  copyFileSafe,
  ensureDir,
  fileExists,
  movePathSafe,
  removePath,
  runCommand,
  writeInfo,
  writeWarn,
} from "./exec";
import { applyExecutableBranding, copyCodexIconToOutput, resolveDefaultCodexIconPath } from "./branding";
import { normalizeProfileName } from "./args";
import { patchMainForWindowsEnvironment } from "./launch";

export interface PortableBuildResult {
  outputDir: string;
  launcherPath: string;
}

function composePortablePath(basePath: string, outputDir: string): string {
  const entries = basePath.split(";").filter(Boolean);
  const seen = new Set<string>();
  const include = (value: string): void => {
    const normalized = value.trim().replace(/^"+|"+$/g, "");
    if (!normalized) return;
    if (!fs.existsSync(normalized)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.unshift(normalized);
  };

  const winRoot = process.env.SystemRoot || "C:\\Windows";
  include(path.join(outputDir, "resources", "path"));
  include(path.join(outputDir, "resources"));
  include(outputDir);
  include(path.join(winRoot, "System32"));
  include(winRoot);
  include(path.join(winRoot, "System32", "Wbem"));
  include(path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "PowerShell", "7"));
  if (process.env.ProgramFiles) include(path.join(process.env.ProgramFiles, "nodejs"));
  if (process.env["ProgramFiles(x86)"]) include(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
  if (process.env.APPDATA) include(path.join(process.env.APPDATA, "npm"));
  return entries.join(";");
}

function bundleCodexCliResources(resourcesDir: string, bundledCliPath: string): void {
  const cliSrcDir = path.dirname(bundledCliPath);
  copyFileSafe(bundledCliPath, path.join(resourcesDir, "codex.exe"));

  for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase() === path.basename(bundledCliPath).toLowerCase()) continue;
    copyFileSafe(path.join(cliSrcDir, entry.name), path.join(resourcesDir, entry.name));
  }

  const vendorArchDir = path.resolve(cliSrcDir, "..");
  const vendorPathDir = path.join(vendorArchDir, "path");
  if (fileExists(vendorPathDir)) {
    writeInfo("Bundling Codex CLI companion tools...");
    copyDirectory(vendorPathDir, path.join(resourcesDir, "path"));
  }
}

function isBusyDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code || "").toUpperCase();
  return code === "EBUSY" || code === "EPERM";
}

function preparePortableOutputDir(distDir: string, outputName: string): string {
  const primary = path.join(distDir, outputName);
  try {
    removePath(primary);
    ensureDir(primary);
    return primary;
  } catch (error) {
    if (!isBusyDirectoryError(error)) throw error;
  }

  const fallbackName = `${outputName}-next`;
  const fallback = path.join(distDir, fallbackName);
  removePath(fallback);
  ensureDir(fallback);
  writeWarn(`Portable output directory is busy: ${primary}; using ${fallback} instead.`);
  return fallback;
}

function writePortableLauncher(outputDir: string, profileName: string): string {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
  const cacheFolder = isDefault ? "cache" : `cache-${profile}`;

  const launcherPath = path.join(outputDir, "Launch-Codex.cmd");
  const launcher = `@echo off
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

if exist "%BASE%resources\\codex.exe" set "CODEX_CLI_PATH=%BASE%resources\\codex.exe"
set "CODEX_WINDOWS_PROFILE=${profile}"
set "CODEX_GIT_CAPABILITY_CACHE=%BASE%resources\\git-capability-cache.json"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"

if not exist "%BASE%${userDataFolder}" mkdir "%BASE%${userDataFolder}" >nul 2>nul
if not exist "%BASE%${cacheFolder}" mkdir "%BASE%${cacheFolder}" >nul 2>nul

"%BASE%Codex.exe" --enable-logging --user-data-dir="%BASE%${userDataFolder}" --disk-cache-dir="%BASE%${cacheFolder}"
exit /b %ERRORLEVEL%
`;
  fs.writeFileSync(launcherPath, launcher, "ascii");
  return launcherPath;
}

export function startPortableDirectLaunch(outputDir: string, profileName: string): number {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
  const cacheFolder = isDefault ? "cache" : `cache-${profile}`;
  const exePath = path.join(outputDir, "Codex.exe");
  if (!fileExists(exePath)) throw new Error(`Portable executable not found: ${exePath}`);

  const userDataDir = path.join(outputDir, userDataFolder);
  const cacheDir = path.join(outputDir, cacheFolder);
  ensureDir(userDataDir);
  ensureDir(cacheDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const normalizedPath = composePortablePath(process.env.PATH || process.env.Path || "", outputDir);
  env.PATH = normalizedPath;
  env.Path = normalizedPath;
  env.PATHEXT = env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  env.CODEX_WINDOWS_PROFILE = profile;
  env.CODEX_GIT_CAPABILITY_CACHE = path.join(outputDir, "resources", "git-capability-cache.json");
  env.ELECTRON_FORCE_IS_PACKAGED = "1";
  env.NODE_ENV = "production";

  const codexCliPath = path.join(outputDir, "resources", "codex.exe");
  if (!fileExists(codexCliPath)) {
    throw new Error(`Portable Codex CLI is missing: ${codexCliPath}`);
  }
  env.CODEX_CLI_PATH = codexCliPath;
  const cliProbe = runCommand(codexCliPath, ["--version"], { capture: true, allowNonZero: true });
  if (cliProbe.status !== 0) {
    throw new Error(
      `Portable Codex CLI failed preflight (exit=${cliProbe.status}): ${(cliProbe.stdout || cliProbe.stderr || "").trim()}`,
    );
  }

  const status = runCommand(
    exePath,
    ["--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`],
    { cwd: outputDir, env, capture: false, allowNonZero: true },
  ).status;
  return status;
}

export async function invokePortableBuild(
  distDir: string,
  nativeDir: string,
  appDir: string,
  buildNumber: string,
  buildFlavor: string,
  bundledCliPath: string | null,
  profileName: string,
  workDir: string,
  appVersion: string,
): Promise<PortableBuildResult> {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
  const electronDistDir = path.join(nativeDir, "node_modules", "electron", "dist");
  if (!fileExists(electronDistDir)) throw new Error("Electron runtime not found.");

  const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
  const outputDir = preparePortableOutputDir(distDir, outputName);

  writeInfo("Copying Electron runtime...");
  copyDirectory(electronDistDir, outputDir);

  const srcExe = path.join(outputDir, "electron.exe");
  const dstExe = path.join(outputDir, "Codex.exe");
  if (fileExists(srcExe)) {
    movePathSafe(srcExe, dstExe);
  } else if (!fileExists(dstExe)) {
    throw new Error("electron.exe not found in Electron dist.");
  }

  const codexIcon = resolveDefaultCodexIconPath();
  if (codexIcon) {
    copyCodexIconToOutput(codexIcon, outputDir);
  } else {
    writeWarn("codex.ico not found; app may keep default Electron icon.");
  }

  const branded = await applyExecutableBranding(dstExe, {
    productName: "Codex",
    fileDescription: "Codex by OpenAI",
    appVersion,
    iconPath: codexIcon,
    workDir,
  });
  if (!branded) {
    writeWarn("Executable branding skipped or failed; binary will keep default metadata.");
  }

  writeInfo("Copying app files...");
  const resourcesDir = ensureDir(path.join(outputDir, "resources"));
  const appDstDir = path.join(resourcesDir, "app");
  copyDirectory(appDir, appDstDir);

  const defaultAsar = path.join(resourcesDir, "default_app.asar");
  removePath(defaultAsar);

  patchMainForWindowsEnvironment(appDstDir, buildNumber, buildFlavor);

  if (bundledCliPath && fileExists(bundledCliPath)) {
    writeInfo("Bundling Codex CLI...");
    bundleCodexCliResources(resourcesDir, bundledCliPath);
  } else {
    writeWarn("codex.exe not found; portable build will rely on PATH auto-detection.");
  }

  const launcherPath = writePortableLauncher(outputDir, profile);
  return { outputDir, launcherPath };
}
