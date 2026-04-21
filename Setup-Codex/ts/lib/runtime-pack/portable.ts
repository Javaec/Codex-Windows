import * as fs from "node:fs";
import * as path from "node:path";
import {
  copyFileSafe,
  copyDirectory,
  describePathLock,
  ensureDir,
  fileExists,
  isBusyFsError,
  movePathSafe,
  removePath,
  writeInfo,
  writeWarn,
} from "../exec";
import { applyExecutableBranding, copyCodexIconToOutput, resolveDefaultCodexIconPath } from "../branding";
import { isCanonicalProfileName, isForgeProfileName, normalizeProfileName } from "../args";
import { patchMainForWindowsEnvironment } from "../platform-patches/bundle-patches";
import type { RuntimeDescriptor } from "../runtime-donor/native";
import { ensureElectronDistCacheForPackaging } from "../runtime-donor/native";
import { bundleCodexCliResources, bundlePackagedRuntimeSupportResources } from "./codex-resources";
import { startPortableDirectLaunch } from "./direct-launch";
import { pruneStalePortableOutputs, writeLatestPortableLaunchers, writePortableLauncher } from "./launchers";
import { verifyPortableRuntimeContract } from "./verify";

export interface PortableBuildResult {
  outputDir: string;
  launcherPath: string;
  canonicalOutputReady: boolean;
  latestLaunchersReady: boolean;
  portableShellRuntime: RuntimeDescriptor;
  nativeRuntime: RuntimeDescriptor;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CODEX_MODS_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods");
const CODEX_MOD_API_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "api");
const CODEX_MOD_LOADER_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader");
const CODEX_MOD_COMPATIBILITY_SRC_PATH = path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs");
const CODEX_VERSION_IDENTITY_SRC_DIR = path.join(REPO_ROOT, "shared", "version-identity");

function resolvePortableShellRuntime(runtime: RuntimeDescriptor): RuntimeDescriptor {
  if (runtime.sourceKind !== "packaged-runtime-cache" && runtime.sourceKind !== "windows-runtime-donor-copy") {
    return runtime;
  }

  const nativeRoot = path.dirname(runtime.runtimeRoot);
  const electronArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";
  const shellRuntime = ensureElectronDistCacheForPackaging(nativeRoot, runtime.electronVersion, electronArch);
  writeInfo(
    `Portable shell runtime switched from ${runtime.sourceKind} to ${shellRuntime.sourceKind}: ${shellRuntime.executablePath} (source=${shellRuntime.sourceLabel})`,
  );
  return shellRuntime;
}

function preparePortableOutputDir(
  distDir: string,
  workDir: string,
  outputName: string,
  allowWorkFallback: boolean,
): string {
  const primary = path.join(distDir, outputName);
  try {
    removePath(primary);
    ensureDir(primary);
    return primary;
  } catch (error) {
    if (!isBusyFsError(error)) throw error;
    if (!allowWorkFallback) {
      throw new Error(describePathLock("prepare canonical portable output", primary, error));
    }
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
      if (!isBusyFsError(error)) throw error;
    }
  }

  throw new Error(`Portable output directory is locked and no fallback path could be prepared. Primary: ${primary}`);
}

export { startPortableDirectLaunch };

export async function invokePortableBuild(
  distDir: string,
  runtime: RuntimeDescriptor,
  appDir: string,
  buildNumber: string,
  buildFlavor: string,
  bundledCliPath: string | null,
  profileName: string,
  workDir: string,
  appVersion: string,
): Promise<PortableBuildResult> {
  const profile = normalizeProfileName(profileName);
  const isDefault = isCanonicalProfileName(profile);
  const includeRuntimeMods = isForgeProfileName(profile);
  const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
  const nativeRuntime = runtime;
  const portableShellRuntime = resolvePortableShellRuntime(nativeRuntime);
  const electronExe = portableShellRuntime.executablePath;
  if (!fileExists(electronExe)) throw new Error("Electron runtime not found.");
  const electronRuntimeDir = portableShellRuntime.runtimeRoot;
  const isPackagedRuntime =
    portableShellRuntime.sourceKind === "packaged-runtime-cache" ||
    portableShellRuntime.sourceKind === "windows-runtime-donor-copy" ||
    path.basename(electronExe).toLowerCase() === "codex.exe";

  const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
  const canonicalOutputDir = path.join(distDir, outputName);
  const outputDir = preparePortableOutputDir(distDir, workDir, outputName, !isDefault);

  writeInfo(`Copying Electron runtime (${portableShellRuntime.sourceKind})...`);
  if (isPackagedRuntime) {
    for (const entry of fs.readdirSync(electronRuntimeDir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === "resources") continue;
      const sourcePath = path.join(electronRuntimeDir, entry.name);
      const destinationPath = path.join(outputDir, entry.name);
      if (entry.isDirectory()) {
        copyDirectory(sourcePath, destinationPath);
      } else {
        copyFileSafe(sourcePath, destinationPath);
      }
    }
    ensureDir(path.join(outputDir, "resources"));
  } else {
    copyDirectory(electronRuntimeDir, outputDir);
  }

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
  const donorSupportResourcesDir = path.join(nativeRuntime.runtimeRoot, "resources");
  if (fileExists(donorSupportResourcesDir)) {
    bundlePackagedRuntimeSupportResources(resourcesDir, donorSupportResourcesDir);
  }
  const appStagingDir = path.join(outputDir, ".app-staging");
  removePath(appStagingDir);
  copyDirectory(appDir, appStagingDir);

  if (includeRuntimeMods) {
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
  } else {
    writeInfo("Building Codex Lite runtime (no Forge mod stack bundled)...");
  }

  removePath(path.join(resourcesDir, "default_app.asar"));
  patchMainForWindowsEnvironment(appStagingDir, buildNumber, buildFlavor);
  copyDirectory(appStagingDir, path.join(resourcesDir, "app"));
  removePath(appStagingDir);

  if (!bundledCliPath || !fileExists(bundledCliPath)) {
    throw new Error("Portable build requires a valid codex.exe source path.");
  }
  writeInfo("Bundling Codex CLI...");
  bundleCodexCliResources(resourcesDir, bundledCliPath);

  const launcherPath = writePortableLauncher(outputDir, profile);
  for (const requiredLauncher of [
    "Launch-Codex.cmd",
    ...(includeRuntimeMods ? ["Launch-Codex-with-mods.cmd"] : []),
  ]) {
    const candidate = path.join(outputDir, requiredLauncher);
    if (!fileExists(candidate)) {
      throw new Error(`Portable launcher missing after packaging: ${candidate}`);
    }
  }
  verifyPortableRuntimeContract({
    outputDir,
    includeRuntimeMods,
    requireWebviewCwdPatch: true,
  });
  let latestLaunchersReady = false;
  if (isDefault) {
    pruneStalePortableOutputs(distDir, outputName, true);
    writeLatestPortableLaunchers(distDir, outputDir, includeRuntimeMods);
    latestLaunchersReady = [
      path.join(distDir, "Launch-Codex-latest.cmd"),
      path.join(distDir, "Launch-Codex-latest-compact-debug.cmd"),
      ...(includeRuntimeMods ? [path.join(distDir, "Launch-Codex-latest-with-mods.cmd")] : []),
    ].every((candidate) => fileExists(candidate));
  }
  return {
    outputDir,
    launcherPath,
    canonicalOutputReady: isDefault && path.resolve(outputDir) === path.resolve(canonicalOutputDir),
    latestLaunchersReady,
    portableShellRuntime,
    nativeRuntime,
  };
}
