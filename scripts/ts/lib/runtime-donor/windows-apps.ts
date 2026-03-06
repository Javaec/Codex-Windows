import * as path from "node:path";
import { fileExists, resolveCommand, runCommand, uniqueExistingDirs } from "../exec";

const WINDOWS_APPS_PACKAGE_QUERY = "OpenAI.Codex*";

export interface WindowsCodexPackage {
  packageFullName: string;
  packageRoot: string;
  resourcesDir: string;
  appAsarUnpackedDir: string;
}

function getPowerShellPath(): string {
  return (
    resolveCommand("pwsh.exe") ||
    resolveCommand("pwsh") ||
    resolveCommand("powershell.exe") ||
    resolveCommand("powershell") ||
    ""
  );
}

let cachedWindowsCodexPackages: WindowsCodexPackage[] = [];
let windowsCodexPackagesLoaded = false;

function loadWindowsCodexPackages(): WindowsCodexPackage[] {
  if (windowsCodexPackagesLoaded) return cachedWindowsCodexPackages;
  windowsCodexPackagesLoaded = true;

  const shellPath = getPowerShellPath();
  if (!shellPath) return cachedWindowsCodexPackages;

  const command =
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `Get-AppxPackage '${WINDOWS_APPS_PACKAGE_QUERY}' | ` +
    `Sort-Object Version -Descending | ` +
    `ForEach-Object { '{0}|{1}' -f $_.PackageFullName, $_.InstallLocation }`;
  const result = runCommand(shellPath, ["-NoProfile", "-Command", command], {
    capture: true,
    allowNonZero: true,
  });
  if (result.status !== 0) return cachedWindowsCodexPackages;

  const packages: WindowsCodexPackage[] = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("|");
    if (separatorIndex <= 0) continue;
    const packageFullName = trimmed.slice(0, separatorIndex).trim();
    const packageRoot = trimmed.slice(separatorIndex + 1).trim();
    if (!packageFullName || !packageRoot || !fileExists(packageRoot)) continue;
    packages.push({
      packageFullName,
      packageRoot,
      resourcesDir: path.join(packageRoot, "app", "resources"),
      appAsarUnpackedDir: path.join(packageRoot, "app", "resources", "app.asar.unpacked"),
    });
  }

  cachedWindowsCodexPackages = packages;
  return cachedWindowsCodexPackages;
}

function findFirstExistingTool(toolName: string): string {
  for (const runtimePackage of loadWindowsCodexPackages()) {
    const candidate = path.join(runtimePackage.resourcesDir, toolName);
    if (fileExists(candidate)) return candidate;
  }
  return "";
}

export function getWindowsRuntimeDonorAppDirs(): string[] {
  return uniqueExistingDirs(loadWindowsCodexPackages().map((runtimePackage) => runtimePackage.appAsarUnpackedDir));
}

export function getWindowsRuntimeDonorCliPath(): string {
  return findFirstExistingTool("codex.exe");
}

export function getWindowsRuntimeDonorRipgrepPath(): string {
  return findFirstExistingTool("rg.exe");
}

export function getWindowsRuntimeDonorBetterSqlite3Path(): string {
  for (const runtimePackage of loadWindowsCodexPackages()) {
    const candidate = path.join(runtimePackage.appAsarUnpackedDir, "node_modules", "better-sqlite3");
    if (fileExists(candidate)) return candidate;
  }
  return "";
}

export function getWindowsRuntimeDonorToolPaths(): string[] {
  return uniqueExistingDirs([
    findFirstExistingTool("codex-command-runner.exe"),
    findFirstExistingTool("codex-windows-sandbox-setup.exe"),
    findFirstExistingTool("rg.exe"),
  ]);
}
