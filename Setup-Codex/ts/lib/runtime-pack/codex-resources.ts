import * as fs from "node:fs";
import * as path from "node:path";
import { copyDirectory, copyFileSafe, ensureDir, fileExists, removePath, resolveCommand, writeInfo } from "../exec";
import { getWindowsRuntimeDonorRipgrepPath, getWindowsRuntimeDonorToolPaths } from "../runtime-donor/windows-apps";

const DONOR_TOOL_NAMES = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]);
const CLI_RESOURCE_ALLOWLIST = new Set([
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "rg.exe",
  "notification.wav",
  "codex-notification.wav",
]);
const PORTABLE_RESOURCE_ROOT_ALLOWLIST = new Set([
  "app",
  "app.asar.unpacked",
  "native",
  "mods",
  "mod-api",
  "mod-loader",
  "compatibility.cjs",
  "version-identity",
  "path",
  "codex",
  "codex.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "icon.ico",
  "notification.wav",
  "rg",
  "rg.exe",
  "third_party_notices.txt",
]);

const PACKAGED_RUNTIME_SUPPORT_ENTRIES = [
  { sourceName: "native", targetName: "native" },
  { sourceName: "codex", targetName: "codex" },
  { sourceName: "icon.ico", targetName: "icon.ico" },
  { sourceName: "notification.wav", targetName: "notification.wav" },
  { sourceName: "codex-notification.wav", targetName: "notification.wav" },
  { sourceName: "rg", targetName: "rg" },
  { sourceName: "THIRD_PARTY_NOTICES.txt", targetName: "THIRD_PARTY_NOTICES.txt" },
];

export interface BundledCliResourceResult {
  bundledRipgrepPath: string;
  bundledRipgrepSourcePath: string;
}

function resolveNotificationSoundSource(resourcesDir: string, runtimeResourcesDir: string): string {
  for (const candidate of [
    path.join(resourcesDir, "notification.wav"),
    path.join(resourcesDir, "codex-notification.wav"),
    path.join(runtimeResourcesDir, "notification.wav"),
    path.join(runtimeResourcesDir, "codex-notification.wav"),
  ]) {
    if (fileExists(candidate)) return path.resolve(candidate);
  }
  return "";
}

export function ensureBundledNotificationSound(resourcesDir: string, runtimeResourcesDir: string): string {
  const bundledNotificationPath = path.join(resourcesDir, "notification.wav");
  if (fileExists(bundledNotificationPath)) return bundledNotificationPath;

  const sourcePath = resolveNotificationSoundSource(resourcesDir, runtimeResourcesDir);
  if (!sourcePath) {
    throw new Error(`Portable build requires bundled notification.wav: ${bundledNotificationPath}`);
  }

  writeInfo(`Bundling notification sound from: ${sourcePath}`);
  copyFileSafe(sourcePath, bundledNotificationPath);
  return bundledNotificationPath;
}

function resolveRipgrepSource(resourcesDir: string, preferredRipgrepPath: string | null): string {
  const pathRipgrepPath = path.join(resourcesDir, "path", "rg.exe");
  const donorRipgrepPath = getWindowsRuntimeDonorRipgrepPath();
  for (const candidate of [
    preferredRipgrepPath || "",
    fileExists(pathRipgrepPath) ? pathRipgrepPath : "",
    donorRipgrepPath,
    resolveCommand("rg.exe") || "",
    resolveCommand("rg") || "",
  ]) {
    if (candidate && fileExists(candidate)) return path.resolve(candidate);
  }
  return "";
}

function installBundledRipgrep(resourcesDir: string, preferredRipgrepPath: string | null): BundledCliResourceResult {
  const bundledRipgrepPath = path.join(resourcesDir, "rg.exe");
  const pathToolsDir = ensureDir(path.join(resourcesDir, "path"));
  const pathRipgrepPath = path.join(pathToolsDir, "rg.exe");
  const ripgrepSourcePath = resolveRipgrepSource(resourcesDir, preferredRipgrepPath);
  if (!ripgrepSourcePath) {
    throw new Error(`Portable build requires bundled rg.exe: ${bundledRipgrepPath}`);
  }

  writeInfo(`Bundling ripgrep from: ${ripgrepSourcePath}`);
  if (path.resolve(ripgrepSourcePath) !== path.resolve(bundledRipgrepPath)) {
    copyFileSafe(ripgrepSourcePath, bundledRipgrepPath);
  }
  if (path.resolve(ripgrepSourcePath) !== path.resolve(pathRipgrepPath)) {
    copyFileSafe(ripgrepSourcePath, pathRipgrepPath);
  }
  return {
    bundledRipgrepPath,
    bundledRipgrepSourcePath: ripgrepSourcePath,
  };
}

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

  writeInfo("Bundling Windows runtime donor tools...");
  for (const donorToolPath of donorToolPaths) {
    const fileName = path.basename(donorToolPath);
    if (!DONOR_TOOL_NAMES.has(fileName.toLowerCase())) continue;
    const destinationPath = path.join(resourcesDir, fileName);
    if (fileExists(destinationPath)) continue;
    copyFileSafe(donorToolPath, destinationPath);
  }
}

function trimPortableResourceRoot(resourcesDir: string): void {
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (PORTABLE_RESOURCE_ROOT_ALLOWLIST.has(entry.name.toLowerCase())) continue;
    removePath(path.join(resourcesDir, entry.name));
  }
}

export function bundlePackagedRuntimeSupportResources(resourcesDir: string, runtimeResourcesDir: string): void {
  if (!fileExists(runtimeResourcesDir)) return;
  const copiedTargets = new Set<string>();
  for (const entry of PACKAGED_RUNTIME_SUPPORT_ENTRIES) {
    if (copiedTargets.has(entry.targetName.toLowerCase())) continue;
    const sourcePath = path.join(runtimeResourcesDir, entry.sourceName);
    if (!fileExists(sourcePath)) continue;
    const destinationPath = path.join(resourcesDir, entry.targetName);
    removePath(destinationPath);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      copyFileSafe(sourcePath, destinationPath);
    }
    copiedTargets.add(entry.targetName.toLowerCase());
  }
}

export function bundleCodexCliResources(
  resourcesDir: string,
  bundledCliPath: string,
  preferredRipgrepPath: string | null,
): BundledCliResourceResult {
  const cliSrcDir = path.dirname(bundledCliPath);
  copyFileSafe(bundledCliPath, path.join(resourcesDir, "codex.exe"));

  for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fileName = entry.name.toLowerCase();
    if (fileName === path.basename(bundledCliPath).toLowerCase()) continue;
    if (!CLI_RESOURCE_ALLOWLIST.has(fileName)) continue;
    const destinationName = fileName === "codex-notification.wav" ? "notification.wav" : entry.name;
    copyFileSafe(path.join(cliSrcDir, entry.name), path.join(resourcesDir, destinationName));
  }

  bundleVendorPathTools(resourcesDir, cliSrcDir);
  bundleWindowsRuntimeDonorTools(resourcesDir);
  const bundledTools = installBundledRipgrep(resourcesDir, preferredRipgrepPath);
  trimPortableResourceRoot(resourcesDir);
  return bundledTools;
}
