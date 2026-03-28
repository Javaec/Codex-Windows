import * as path from "node:path";
import { fileExists, resolveCommand, runCommand, uniqueExistingDirs } from "../exec";

const WINDOWS_APPS_PACKAGE_QUERY = "OpenAI.Codex*";

export interface WindowsCodexPackage {
  packageFullName: string;
  packageVersion: string;
  packageRoot: string;
  appDir: string;
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
    `ForEach-Object { '{0}|{1}|{2}' -f $_.PackageFullName, $_.Version, $_.InstallLocation }`;
  const result = runCommand(shellPath, ["-NoProfile", "-Command", command], {
    capture: true,
    allowNonZero: true,
  });
  if (result.status !== 0) return cachedWindowsCodexPackages;

  const packages: WindowsCodexPackage[] = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("|");
    if (parts.length < 3) continue;
    const packageFullName = String(parts[0] || "").trim();
    const packageVersion = String(parts[1] || "").trim();
    const packageRoot = String(parts.slice(2).join("|") || "").trim();
    if (!packageFullName || !packageRoot || !fileExists(packageRoot)) continue;
    packages.push({
      packageFullName,
      packageVersion,
      packageRoot,
      appDir: path.join(packageRoot, "app"),
      resourcesDir: path.join(packageRoot, "app", "resources"),
      appAsarUnpackedDir: path.join(packageRoot, "app", "resources", "app.asar.unpacked"),
    });
  }

  cachedWindowsCodexPackages = packages;
  return cachedWindowsCodexPackages;
}

export function listWindowsCodexPackages(): WindowsCodexPackage[] {
  return [...loadWindowsCodexPackages()];
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
