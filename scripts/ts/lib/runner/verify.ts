import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { probeResolvedCodexCli, resolveCodexCliPathContract } from "../cli";
import {
  ensureRipgrepInPath,
  ensureWindowsEnvironment,
  invokeEnvironmentContractChecks,
} from "../env";
import { mustResolveCommand, runCommand, uniqueExistingDirs, writeError, writeHeader, writeSuccess, writeWarn } from "../exec";
import { getFileDescriptorWithCache, getStepSignature, readStateManifest, writeStateManifest } from "../manifest";
import { resolvePatchProfile } from "../platform-patches/patch-pack";
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

function resolveNativeSupportCandidates(): string[] {
  return uniqueExistingDirs([
    path.join(REPO_ROOT, "dist", "Codex-win32-x64", "resources", "app"),
    path.join(REPO_ROOT, "dist", "Codex-win32-arm64", "resources", "app"),
    path.join(REPO_ROOT, "scripts", "native-seeds", "win32-x64", "app"),
    path.join(REPO_ROOT, "scripts", "native-seeds", "win32-arm64", "app"),
  ]);
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
      selected?: { profileId?: string; modCount?: number; stepCount?: number };
      runtimeModpack?: { modCount?: number };
    };
    const profileId = parsed.selected?.profileId || "unknown";
    const modCount = Number(parsed.selected?.modCount ?? 0);
    const stepCount = Number(parsed.selected?.stepCount ?? 0);
    const runtimeModCount = Number(parsed.runtimeModpack?.modCount ?? 0);
    return `profile=${profileId} selectedMods=${modCount} patchSteps=${stepCount} runtimeMods=${runtimeModCount}`;
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
  };
  return {
    appVersion: typeof pkg.version === "string" ? pkg.version : "",
    buildNumber: typeof pkg.codexBuildNumber === "string" ? pkg.codexBuildNumber : "",
    buildFlavor: typeof pkg.codexBuildFlavor === "string" ? pkg.codexBuildFlavor : "",
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
    addVerifyItem(items, "patch-profile", "OK", `${resolvedProfile.profile.profileId} (${resolvedProfile.source})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    const cliResolution = resolveCodexCliPathContract(preferredCodexCliPath, false);
    if (!cliResolution.found || !cliResolution.path) {
      addVerifyItem(items, "codex-cli", "FAIL", takeLastLine(cliResolution.trace.join("\n")) || "codex.exe not found");
    } else {
      const probe = probeResolvedCodexCli(cliResolution);
      addVerifyItem(
        items,
        "codex-cli",
        probe.ok ? "OK" : "FAIL",
        `${cliResolution.path} (source=${cliResolution.source}; ${probe.details})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addVerifyItem(items, "codex-cli", "FAIL", message);
  }

  const nativeCandidates = resolveNativeSupportCandidates();
  addVerifyItem(
    items,
    "native-support",
    nativeCandidates.length > 0 ? "OK" : "FAIL",
    nativeCandidates.length > 0
      ? `${nativeCandidates.length} donor/seed path(s) available`
      : "no donor/seed app directories found under dist/ or scripts/native-seeds/",
  );

  writeVerifySummary(items);
  return items.some((item) => item.status === "FAIL") ? 1 : 0;
}
