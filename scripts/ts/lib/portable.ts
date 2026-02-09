import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, runRobocopy, writeInfo, writeWarn } from "./exec";
import { normalizeProfileName } from "./args";
import { patchMainForWindowsEnvironment } from "./launch";

export interface PortableBuildResult {
  outputDir: string;
  launcherPath: string;
}

function bundleCodexCliResources(resourcesDir: string, bundledCliPath: string): void {
  const cliSrcDir = path.dirname(bundledCliPath);
  fs.copyFileSync(bundledCliPath, path.join(resourcesDir, "codex.exe"));

  for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase() === path.basename(bundledCliPath).toLowerCase()) continue;
    fs.copyFileSync(path.join(cliSrcDir, entry.name), path.join(resourcesDir, entry.name));
  }

  const vendorArchDir = path.resolve(cliSrcDir, "..");
  const vendorPathDir = path.join(vendorArchDir, "path");
  if (fileExists(vendorPathDir)) {
    writeInfo("Bundling Codex CLI companion tools...");
    runRobocopy(vendorPathDir, path.join(resourcesDir, "path"));
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
    fs.rmSync(primary, { recursive: true, force: true });
    ensureDir(primary);
    return primary;
  } catch (error) {
    if (!isBusyDirectoryError(error)) throw error;
  }

  const fallbackName = `${outputName}-next`;
  const fallback = path.join(distDir, fallbackName);
  fs.rmSync(fallback, { recursive: true, force: true });
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

export function invokePortableBuild(
  distDir: string,
  nativeDir: string,
  appDir: string,
  buildNumber: string,
  buildFlavor: string,
  bundledCliPath: string | null,
  profileName: string,
): PortableBuildResult {
  const profile = normalizeProfileName(profileName);
  const isDefault = profile === "default";
  const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
  const electronDistDir = path.join(nativeDir, "node_modules", "electron", "dist");
  if (!fileExists(electronDistDir)) throw new Error("Electron runtime not found.");

  const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
  const outputDir = preparePortableOutputDir(distDir, outputName);

  writeInfo("Copying Electron runtime...");
  runRobocopy(electronDistDir, outputDir);

  const srcExe = path.join(outputDir, "electron.exe");
  const dstExe = path.join(outputDir, "Codex.exe");
  if (fileExists(srcExe)) {
    fs.renameSync(srcExe, dstExe);
  } else if (!fileExists(dstExe)) {
    throw new Error("electron.exe not found in Electron dist.");
  }

  writeInfo("Copying app files...");
  const resourcesDir = ensureDir(path.join(outputDir, "resources"));
  const appDstDir = path.join(resourcesDir, "app");
  runRobocopy(appDir, appDstDir);

  const defaultAsar = path.join(resourcesDir, "default_app.asar");
  if (fileExists(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

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
