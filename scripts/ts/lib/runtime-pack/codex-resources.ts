import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath, writeInfo } from "../exec";
import { getWindowsRuntimeDonorToolPaths } from "../runtime-donor/windows-apps";

const DONOR_TOOL_NAMES = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe"]);
const CLI_RESOURCE_ALLOWLIST = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe", "notification.wav"]);
const PORTABLE_RESOURCE_ROOT_ALLOWLIST = new Set([
  "app",
  "mods",
  "mod-api",
  "mod-loader",
  "compatibility.cjs",
  "version-identity",
  "path",
  "codex.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "notification.wav",
  "rg.exe",
]);

function bundleVendorPathTools(resourcesDir: string, cliSrcDir: string): void {
  const vendorArchDir = path.resolve(cliSrcDir, "..");
  const vendorPathDir = path.join(vendorArchDir, "path");
  if (!fileExists(vendorPathDir)) return;
  writeInfo("Bundling Codex CLI companion tools...");
  copyDirectory(vendorPathDir, path.join(resourcesDir, "path"));
}

function bundleWindowsRuntimeDonorTools(resourcesDir: string): void {
  const donorToolPaths = getWindowsRuntimeDonorToolPaths();
  if (donorToolPaths.length === 0) return;

  const pathToolsDir = ensureDir(path.join(resourcesDir, "path"));
  writeInfo("Bundling Windows runtime donor tools...");
  for (const donorToolPath of donorToolPaths) {
    const fileName = path.basename(donorToolPath);
    if (!DONOR_TOOL_NAMES.has(fileName.toLowerCase())) continue;
    copyFileSafe(donorToolPath, path.join(resourcesDir, fileName));
    if (fileName.toLowerCase() === "rg.exe") {
      copyFileSafe(donorToolPath, path.join(pathToolsDir, fileName));
    }
  }
}

function trimPortableResourceRoot(resourcesDir: string): void {
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (PORTABLE_RESOURCE_ROOT_ALLOWLIST.has(entry.name.toLowerCase())) continue;
    removePath(path.join(resourcesDir, entry.name));
  }
}

export function bundleCodexCliResources(resourcesDir: string, bundledCliPath: string): void {
  const cliSrcDir = path.dirname(bundledCliPath);
  copyFileSafe(bundledCliPath, path.join(resourcesDir, "codex.exe"));

  for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fileName = entry.name.toLowerCase();
    if (fileName === path.basename(bundledCliPath).toLowerCase()) continue;
    if (!CLI_RESOURCE_ALLOWLIST.has(fileName)) continue;
    copyFileSafe(path.join(cliSrcDir, entry.name), path.join(resourcesDir, entry.name));
  }

  bundleVendorPathTools(resourcesDir, cliSrcDir);
  bundleWindowsRuntimeDonorTools(resourcesDir);
  trimPortableResourceRoot(resourcesDir);
}
