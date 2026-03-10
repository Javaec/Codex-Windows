import * as path from "node:path";
import {
  copyFileSafe,
  copyDirectory,
  ensureDir,
  fileExists,
  movePathSafe,
  removePath,
  writeInfo,
  writeWarn,
} from "../exec";
import { applyExecutableBranding, copyCodexIconToOutput, resolveDefaultCodexIconPath } from "../branding";
import { normalizeProfileName } from "../args";
import { patchMainForWindowsEnvironment } from "../platform-patches/bundle-patches";
import { bundleCodexCliResources } from "./codex-resources";
import { startPortableDirectLaunch } from "./direct-launch";
import { pruneStalePortableOutputs, writeLatestPortableLaunchers, writePortableLauncher } from "./launchers";

export interface PortableBuildResult {
  outputDir: string;
  launcherPath: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CODEX_MODS_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods");
const CODEX_MOD_API_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "api");
const CODEX_MOD_LOADER_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader");
const CODEX_MOD_COMPATIBILITY_SRC_PATH = path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs");
const CODEX_VERSION_IDENTITY_SRC_DIR = path.join(REPO_ROOT, "shared", "version-identity");

function isBusyDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code || "").toUpperCase();
  return code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}

function preparePortableOutputDir(distDir: string, workDir: string, outputName: string): string {
  const primary = path.join(distDir, outputName);
  try {
    removePath(primary);
    ensureDir(primary);
    return primary;
  } catch (error) {
    if (!isBusyDirectoryError(error)) throw error;
  }

  const fallbackRoot = ensureDir(path.join(workDir, "portable-output"));
  const suffix = Date.now();
  for (const fallbackName of [
    `${outputName}-next`,
    `${outputName}-next-${suffix}`,
    `${outputName}-next-${suffix}-1`,
    `${outputName}-next-${suffix}-2`,
  ]) {
    const fallback = path.join(fallbackRoot, fallbackName);
    try {
      removePath(fallback);
      ensureDir(fallback);
      writeWarn(`Portable output directory is busy: ${primary}; using ${fallback} instead.`);
      return fallback;
    } catch (error) {
      if (!isBusyDirectoryError(error)) throw error;
    }
  }

  throw new Error(`Portable output directory is locked and no fallback path could be prepared. Primary: ${primary}`);
}

export { startPortableDirectLaunch };

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
  const outputDir = preparePortableOutputDir(distDir, workDir, outputName);

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

  if (!fileExists(CODEX_MODS_SRC_DIR)) {
    throw new Error(`Codex modpack missing: ${CODEX_MODS_SRC_DIR}`);
  }
  if (!fileExists(CODEX_MOD_API_SRC_DIR)) {
    throw new Error(`Codex mod API missing: ${CODEX_MOD_API_SRC_DIR}`);
  }
  if (!fileExists(CODEX_MOD_LOADER_SRC_DIR)) {
    throw new Error(`Codex mod loader missing: ${CODEX_MOD_LOADER_SRC_DIR}`);
  }
  if (!fileExists(CODEX_MOD_COMPATIBILITY_SRC_PATH)) {
    throw new Error(`Codex mod compatibility helper missing: ${CODEX_MOD_COMPATIBILITY_SRC_PATH}`);
  }
  if (!fileExists(CODEX_VERSION_IDENTITY_SRC_DIR)) {
    throw new Error(`Codex version identity helper missing: ${CODEX_VERSION_IDENTITY_SRC_DIR}`);
  }
  writeInfo("Bundling Codex mods...");
  copyDirectory(CODEX_MODS_SRC_DIR, path.join(resourcesDir, "mods"));
  writeInfo("Bundling Codex mod API...");
  copyDirectory(CODEX_MOD_API_SRC_DIR, path.join(resourcesDir, "mod-api"));
  writeInfo("Bundling Codex mod loader...");
  copyDirectory(CODEX_MOD_LOADER_SRC_DIR, path.join(resourcesDir, "mod-loader"));
  writeInfo("Bundling Codex mod compatibility...");
  copyFileSafe(CODEX_MOD_COMPATIBILITY_SRC_PATH, path.join(resourcesDir, "compatibility.cjs"));
  writeInfo("Bundling version identity helper...");
  copyDirectory(CODEX_VERSION_IDENTITY_SRC_DIR, path.join(resourcesDir, "version-identity"));

  removePath(path.join(resourcesDir, "default_app.asar"));
  patchMainForWindowsEnvironment(appDstDir, buildNumber, buildFlavor);

  if (!bundledCliPath || !fileExists(bundledCliPath)) {
    throw new Error("Portable build requires a valid codex.exe source path.");
  }
  writeInfo("Bundling Codex CLI...");
  bundleCodexCliResources(resourcesDir, bundledCliPath);

  const launcherPath = writePortableLauncher(outputDir, profile);
  for (const requiredLauncher of [
    "Launch-Codex.cmd",
    "Launch-Codex-with-mods.cmd",
  ]) {
    const candidate = path.join(outputDir, requiredLauncher);
    if (!fileExists(candidate)) {
      throw new Error(`Portable launcher missing after packaging: ${candidate}`);
    }
  }
  if (isDefault) {
    pruneStalePortableOutputs(distDir, outputName);
    writeLatestPortableLaunchers(distDir, outputDir);
  }
  return { outputDir, launcherPath };
}
