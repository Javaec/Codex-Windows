import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { resolveAndProbeCodexCli } from "./cli-resolution";
import {
  ensureRipgrepInPath,
  ensureWindowsEnvironment,
  invokeEnvironmentContractChecks,
} from "../env";
import { mustResolveCommand, runCommand, uniqueExistingDirs, writeError, writeHeader, writeSuccess, writeWarn } from "../exec";
import { getFileDescriptorWithCache, getStepSignature, readStateManifest, writeStateManifest } from "../manifest";
import { resolvePatchProfile } from "../platform-patches/patch-pack";
import { inspectNativeSupport, inspectRuntimePreflight } from "../runtime-donor/native";
import { invokeExtractionStage, resolveDmgPath } from "../source-bundle/extract";
import { REPO_ROOT, resolvePreferredCodexCliPath, sanitizeRunnerEnvironment } from "./context";

type VerifyStatus = "OK" | "WARN" | "FAIL";

type VerifyItem = {
  name: string;
  status: VerifyStatus;
  details: string;
};

type DmgBuildMetadata = {
  appVersion: string;
  buildNumber: string;
  buildFlavor: string;
  electronVersion: string;
  appDir: string;
};

function addVerifyItem(items: VerifyItem[], name: string, status: VerifyStatus, details: string): void {
  items.push({ name, status, details });
}

function writeVerifySummary(items: VerifyItem[]): void {
  const counts = { OK: 0, WARN: 0, FAIL: 0 };
  for (const item of items) {
    counts[item.status] += 1;
    const line = `[verify] ${item.status.padEnd(4, " ")} ${item.name} :: ${item.details}`;
    if (item.status === "OK") writeSuccess(line);
    else if (item.status === "WARN") writeWarn(line);
    else writeError(line);
  }
  writeHeader("Verify summary");
  writeSuccess(`OK=${counts.OK} WARN=${counts.WARN} FAIL=${counts.FAIL}`);
}

function takeLastLine(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function summarizePatchPackPreflight(output: string): string {
  try {
    const parsed = JSON.parse(output) as {
      selected?: { profileId?: string; matchedBuildId?: string; modCount?: number; stepCount?: number };
      runtimeModpack?: { modCount?: number };
    };
    const profileId = parsed.selected?.profileId || "unknown";
    const matchedBuildId = parsed.selected?.matchedBuildId || "unknown";
    const modCount = Number(parsed.selected?.modCount ?? 0);
    const stepCount = Number(parsed.selected?.stepCount ?? 0);
    const runtimeModCount = Number(parsed.runtimeModpack?.modCount ?? 0);
    return `build=${matchedBuildId} profile=${profileId} selectedMods=${modCount} patchSteps=${stepCount} runtimeMods=${runtimeModCount}`;
  } catch {
    return takeLastLine(output) || "patch-pack is valid";
  }
}

function resolveDmgBuildMetadata(dmgPath: string, workDir: string): DmgBuildMetadata {
  const manifestPath = path.join(workDir, "verify.state.manifest.json");
  const manifest = readStateManifest(manifestPath);
  const descriptor = getFileDescriptorWithCache(dmgPath, manifest.dmg);
  manifest.dmg = descriptor;
  writeStateManifest(manifestPath, manifest);

  const extractResult = invokeExtractionStage(
    dmgPath,
    workDir,
    true,
    false,
    manifest,
    manifestPath,
    getStepSignature({ dmgSha256: descriptor.sha256 }),
  );
  const pkgPath = path.join(extractResult.appDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found after DMG extraction: ${pkgPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version?: string;
    codexBuildNumber?: string;
    codexBuildFlavor?: string;
    devDependencies?: Record<string, string>;
  };
  return {
    appVersion: typeof pkg.version === "string" ? pkg.version : "",
    buildNumber: typeof pkg.codexBuildNumber === "string" ? pkg.codexBuildNumber : "",
    buildFlavor: typeof pkg.codexBuildFlavor === "string" ? pkg.codexBuildFlavor : "",
    electronVersion: typeof pkg.devDependencies?.electron === "string" ? pkg.devDependencies.electron : "",
    appDir: extractResult.appDir,
  };
}

export async function runVerify(options: PipelineOptions): Promise<number> {
  sanitizeRunnerEnvironment();
  ensureWindowsEnvironment();
  mustResolveCommand("node.exe");

  const workDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work"));
  const distDir = path.resolve(options.distDir || path.join(REPO_ROOT, "dist"));
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  const items: VerifyItem[] = [];

  writeHeader("Verify environment");
  const ripgrep = await ensureRipgrepInPath(workDir);
  addVerifyItem(items, "ripgrep", "OK", `${ripgrep.path} (source=${ripgrep.source})`);

  const environmentResult = invokeEnvironmentContractChecks();
  for (const check of environmentResult.checks) {
    addVerifyItem(items, `env:${check.name}`, check.passed ? "OK" : "FAIL", check.details);
  }

  let resolvedDmgPath = "";
  let dmgBuildMetadata: DmgBuildMetadata | null = null;
  try {
    resolvedDmgPath = resolveDmgPath(options.dmgPath, REPO_ROOT);
    addVerifyItem(items, "dmg", "OK", resolvedDmgPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addVerifyItem(items, "dmg", "FAIL", message);
  }

  const snapshotLabel = resolvedDmgPath ? path.basename(resolvedDmgPath) : "";
  if (resolvedDmgPath) {
    try {
      dmgBuildMetadata = resolveDmgBuildMetadata(resolvedDmgPath, workDir);
      addVerifyItem(
        items,
        "dmg-metadata",
        "OK",
        `appVersion=${dmgBuildMetadata.appVersion || "unknown"} buildNumber=${dmgBuildMetadata.buildNumber || "unknown"} buildFlavor=${dmgBuildMetadata.buildFlavor || "unknown"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addVerifyItem(items, "dmg-metadata", "FAIL", message);
    }
  }
  try {
    const resolvedProfile = resolvePatchProfile({
      snapshotLabel,
      buildNumber: dmgBuildMetadata?.buildNumber || "",
      appVersion: dmgBuildMetadata?.appVersion || "",
      forcedProfileId: options.patchProfile || "",
    });
    addVerifyItem(
      items,
      "build-identity",
      resolvedProfile.matchedBuildId ? "OK" : "WARN",
      resolvedProfile.matchedBuildId
        ? `${resolvedProfile.matchedBuildId} (${resolvedProfile.matchedBuildSource || "known-build"})`
        : "internal version not found in known-builds",
    );
    addVerifyItem(items, "patch-profile", "OK", `${resolvedProfile.profile.profileId} (${resolvedProfile.source})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addVerifyItem(items, "build-identity", "FAIL", message);
    addVerifyItem(items, "patch-profile", "FAIL", message);
  }

  const preflightArgs = [path.join(REPO_ROOT, "shared", "patch-pack", "preflight.mjs")];
  if (snapshotLabel) preflightArgs.push("--snapshot-label", snapshotLabel);
  if (dmgBuildMetadata?.appVersion) preflightArgs.push("--app-version", dmgBuildMetadata.appVersion);
  if (dmgBuildMetadata?.buildNumber) preflightArgs.push("--build-number", dmgBuildMetadata.buildNumber);
  const preflight = runCommand(process.execPath, preflightArgs, {
    cwd: REPO_ROOT,
    capture: true,
    allowNonZero: true,
  });
  addVerifyItem(
    items,
    "patch-pack-preflight",
    preflight.status === 0 ? "OK" : "FAIL",
    preflight.status === 0
      ? summarizePatchPackPreflight(preflight.stdout)
      : takeLastLine(preflight.stderr || preflight.stdout) || `exit=${preflight.status}`,
  );

  const preferredCodexCliPath = resolvePreferredCodexCliPath(options.codexCliPath);
  try {
    const cliTracePath = path.join(workDir, "verify-cli-resolution.log");
    const cliResolution = await resolveAndProbeCodexCli(
      preferredCodexCliPath,
      false,
      cliTracePath,
      "Codex CLI verify probe failed",
      undefined,
      { workDir, codexCliChannel: options.codexCliChannel },
    );
    if (!cliResolution.found || !cliResolution.path) {
      addVerifyItem(items, "codex-cli", "FAIL", takeLastLine(cliResolution.trace.join("\n")) || "codex.exe not found");
    } else {
      addVerifyItem(items, "codex-cli", "OK", `${cliResolution.path} (source=${cliResolution.source})`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addVerifyItem(items, "codex-cli", "FAIL", message);
  }

  const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "win32-arm64" : "win32-x64";
  const nativeSupport = inspectNativeSupport(workDir, arch);
  addVerifyItem(
    items,
    "native-support",
    nativeSupport.usableDonorAppDirs.length > 0 || nativeSupport.usableSeedAppDirs.length > 0 ? "OK" : "FAIL",
    `usableDonor=${nativeSupport.usableDonorAppDirs.length}/${nativeSupport.donorAppDirs.length} usableSeed=${nativeSupport.usableSeedAppDirs.length}/${nativeSupport.seedAppDirs.length}`,
  );
  addVerifyItem(
    items,
    "bundled-native-seeds",
    nativeSupport.usableSeedAppDirs.length > 0 ? "OK" : "FAIL",
    nativeSupport.usableSeedAppDirs.length > 0
      ? nativeSupport.usableSeedAppDirs.join(", ")
      : `no usable bundled seeds under Setup-Codex/native-seeds/${arch}/app`,
  );

  if (dmgBuildMetadata?.electronVersion) {
    const runtimePreflight = inspectRuntimePreflight(workDir, dmgBuildMetadata.electronVersion, arch);
    addVerifyItem(
      items,
      "runtime-preflight",
      runtimePreflight.fallbackRequired ? "WARN" : "OK",
      `selected=${runtimePreflight.selectedSourceKind} source=${runtimePreflight.sourceLabel} cacheAvailable=${runtimePreflight.packagedRuntimeCacheAvailable} cacheValid=${runtimePreflight.packagedRuntimeCacheValid} fallbackRequired=${runtimePreflight.fallbackRequired}`,
    );
  } else {
    addVerifyItem(items, "runtime-preflight", "WARN", "electron version missing in extracted package.json");
  }

  writeVerifySummary(items);
  return items.some((item) => item.status === "FAIL") ? 1 : 0;
}
