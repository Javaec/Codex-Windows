import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { OutputProfile, GateMode, RunMetrics, RunSummary } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { NamingMemoryModel } from "../ir/naming-memory";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { compactNamingMemoryFile, MAX_NAMING_MEMORY_FILE_BYTES } from "../naming/compact";

interface CliOptions {
  snapshotAsarPath: string;
  snapshotLabel: string;
  patchProfile: string;
  appVersion: string;
  buildNumber: string;
  fromProfile: string;
  overwriteTargetProfile: boolean;
  outputProfile: OutputProfile;
  gateMode: GateMode;
  statementBudget: number;
  promotionBudget: number;
  runIdPrefix: string;
  allowAfterFreeze: boolean;
  disableWakaru: boolean;
  disableJavascriptDeobfuscator: boolean;
  disableSynchrony: boolean;
  disableUnwebpackSourcemap: boolean;
  dryRun: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface NamingMemorySnapshotStats {
  profilePath: string;
  entryCount: number;
  averageNameQuality: number;
  genericNameCount: number;
}

interface VersionBridgeReport {
  version: number;
  generatedAtIso: string;
  snapshotAsarPath: string;
  snapshotLabel: string;
  snapshotSha256: string;
  snapshotKey: string;
  sourceProfilePath: string;
  sourceProfileStats: NamingMemorySnapshotStats;
  baselineCopyPath: string;
  baselineCopyBytes: number;
  baselineCopyCompressed: boolean;
  targetProfilePath: string;
  targetProfileExistedBefore: boolean;
  targetProfilePreseeded: boolean;
  targetProfileStatsBeforeRun: NamingMemorySnapshotStats;
  runExecuted: boolean;
  runId: string;
  runDirectory: string;
  outputProfile: OutputProfile;
  gateMode: GateMode;
  patchProfile: string;
  metricsPath: string;
  summaryPath: string;
  runMetrics: RunMetrics | null;
  namingMemoryStage:
    | {
      insertedEntryCount: number;
      updatedEntryCount: number;
      keptEntryCount: number;
      manualSyncFingerprintResolvedCount: number;
      baselineQualityBefore: number;
      baselineQualityAfter: number;
      baselineGuardPassed: boolean;
    }
    | null;
  targetProfileStatsAfterRun: NamingMemorySnapshotStats;
  notes: string[];
}

const gzipAsync = promisify(zlib.gzip);

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/migration/codex-version-bridge.js --snapshot <path-to-app.asar> [options]",
    "",
    "Options:",
    "  --snapshot-label <label>     default: basename(snapshot path)",
    "  --patch-profile <id>         optional: force patch profile",
    "  --app-version <v>            default: 26.303.1606",
    "  --build-number <n>           default: 806",
    "  --from-profile <path|key>    optional: source naming profile file or snapshot key",
    "  --overwrite-target-profile   default: false",
    "  --profile <latest|regression-latest> default: regression-latest",
    "  --gate-mode <full|light>     default: light",
    "  --statement-budget <n>       default: 32",
    "  --promotion-budget <n>       default: 180",
    "  --run-id-prefix <token>      default: version-bridge",
    "  --allow-after-freeze",
    "  --disable-wakaru",
    "  --disable-javascript-deobfuscator",
    "  --disable-synchrony",
    "  --disable-unwebpack-sourcemap",
    "  --dry-run",
    "",
    "Example:",
    "  node dist/migration/codex-version-bridge.js --snapshot \"C:\\\\...\\\\app.asar\" --snapshot-label Codex-10711.dmg --patch-profile codex-10711",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseInteger(value: string, option: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${option} value: ${value}`);
  }
  return parsed;
}

function parseOutputProfile(value: string): OutputProfile {
  if (value === "latest" || value === "regression-latest") {
    return value;
  }
  throw new Error(`Invalid --profile value: ${value}`);
}

function parseGateMode(value: string): GateMode {
  if (value === "full" || value === "light") {
    return value;
  }
  throw new Error(`Invalid --gate-mode value: ${value}`);
}

function parseCli(argv: readonly string[]): CliOptions {
  let snapshotAsarPath = "";
  let snapshotLabel = "";
  let patchProfile = "";
  let appVersion = "26.303.1606";
  let buildNumber = "806";
  let fromProfile = "";
  let overwriteTargetProfile = false;
  let outputProfile: OutputProfile = "regression-latest";
  let gateMode: GateMode = "light";
  let statementBudget = 32;
  let promotionBudget = 180;
  let runIdPrefix = "version-bridge";
  let allowAfterFreeze = false;
  let disableWakaru = false;
  let disableJavascriptDeobfuscator = false;
  let disableSynchrony = false;
  let disableUnwebpackSourcemap = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --snapshot");
        snapshotAsarPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--snapshot-label": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --snapshot-label");
        snapshotLabel = value.trim();
        index += 1;
        break;
      }
      case "--patch-profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --patch-profile");
        patchProfile = value.trim().toLowerCase();
        index += 1;
        break;
      }
      case "--app-version": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --app-version");
        appVersion = value.trim();
        index += 1;
        break;
      }
      case "--build-number": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --build-number");
        buildNumber = value.trim();
        index += 1;
        break;
      }
      case "--from-profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --from-profile");
        fromProfile = value.trim();
        index += 1;
        break;
      }
      case "--overwrite-target-profile": {
        overwriteTargetProfile = true;
        break;
      }
      case "--profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --profile");
        outputProfile = parseOutputProfile(value.trim());
        index += 1;
        break;
      }
      case "--gate-mode": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --gate-mode");
        gateMode = parseGateMode(value.trim());
        index += 1;
        break;
      }
      case "--statement-budget": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --statement-budget");
        statementBudget = parseInteger(value, "--statement-budget", 1);
        index += 1;
        break;
      }
      case "--promotion-budget": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --promotion-budget");
        promotionBudget = parseInteger(value, "--promotion-budget", 1);
        index += 1;
        break;
      }
      case "--run-id-prefix": {
        const value = argv[index + 1];
        if (!value) throw new Error("Missing value for --run-id-prefix");
        runIdPrefix = value.trim();
        index += 1;
        break;
      }
      case "--allow-after-freeze": {
        allowAfterFreeze = true;
        break;
      }
      case "--disable-wakaru": {
        disableWakaru = true;
        break;
      }
      case "--disable-javascript-deobfuscator": {
        disableJavascriptDeobfuscator = true;
        break;
      }
      case "--disable-synchrony": {
        disableSynchrony = true;
        break;
      }
      case "--disable-unwebpack-sourcemap": {
        disableUnwebpackSourcemap = true;
        break;
      }
      case "--dry-run": {
        dryRun = true;
        break;
      }
      case "--help":
      case "-h": {
        printUsage();
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (snapshotAsarPath.length < 1) {
    throw new Error("Missing required --snapshot");
  }

  return {
    snapshotAsarPath,
    snapshotLabel,
    patchProfile,
    appVersion,
    buildNumber,
    fromProfile,
    overwriteTargetProfile,
    outputProfile,
    gateMode,
    statementBudget,
    promotionBudget,
    runIdPrefix,
    allowAfterFreeze,
    disableWakaru,
    disableJavascriptDeobfuscator,
    disableSynchrony,
    disableUnwebpackSourcemap,
    dryRun,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function runNodeCommand(cwd: string, args: string[], mirrorOutput: boolean): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (mirrorOutput) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (mirrorOutput) process.stderr.write(text);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : -1,
        stdout,
        stderr,
      });
    });
  });
}

function buildUtcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

async function listSnapshotProfiles(namingSnapshotsDirectory: string): Promise<string[]> {
  if (!(await fileExists(namingSnapshotsDirectory))) {
    return [];
  }
  const entries = await fs.readdir(namingSnapshotsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^snapshot-[a-f0-9]{12}\.json$/i.test(entry.name))
    .map((entry) => path.join(namingSnapshotsDirectory, entry.name))
    .sort();
}

async function resolveSourceProfilePath(
  namingSnapshotsDirectory: string,
  fromProfile: string,
  targetProfilePath: string,
): Promise<string> {
  if (fromProfile.length > 0) {
    const asPath = path.resolve(fromProfile);
    if (await fileExists(asPath)) {
      return asPath;
    }
    const asSnapshotKey = fromProfile.replace(/^snapshot-/, "").replace(/\.json$/i, "");
    const byKeyPath = path.join(namingSnapshotsDirectory, `snapshot-${asSnapshotKey}.json`);
    if (await fileExists(byKeyPath)) {
      return byKeyPath;
    }
    throw new Error(`version-bridge: unable to resolve --from-profile '${fromProfile}'`);
  }

  const profiles = await listSnapshotProfiles(namingSnapshotsDirectory);
  const candidates = profiles.filter((entry) => path.resolve(entry) !== path.resolve(targetProfilePath));
  if (candidates.length < 1) {
    throw new Error("version-bridge: no source naming snapshot profile found");
  }
  const scored: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const filePath of candidates) {
    const stats = await fs.stat(filePath);
    scored.push({ filePath, mtimeMs: stats.mtimeMs });
  }
  scored.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = scored[0];
  if (!latest) {
    throw new Error("version-bridge: failed to pick latest source naming profile");
  }
  return latest.filePath;
}

async function readNamingMemoryStats(profilePath: string): Promise<NamingMemorySnapshotStats> {
  const model = await readJsonFile<NamingMemoryModel>(profilePath);
  const entryCount = model.entries.length;
  let qualitySum = 0;
  let genericNameCount = 0;
  for (const entry of model.entries) {
    qualitySum += scoreNameQuality(entry.currentName);
    if (isGenericName(entry.currentName)) {
      genericNameCount += 1;
    }
  }
  const averageNameQuality = entryCount < 1 ? 0 : Number((qualitySum / entryCount).toFixed(4));
  return {
    profilePath,
    entryCount,
    averageNameQuality,
    genericNameCount,
  };
}

function sanitizeRunIdToken(input: string): string {
  const normalized = input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length < 1) {
    throw new Error("version-bridge: run id prefix is empty after normalization");
  }
  return normalized;
}

async function writeCompressedBaselineCopy(sourceProfilePath: string, baselineDirectory: string): Promise<{
  outputPath: string;
  outputBytes: number;
  compressed: boolean;
}> {
  const fileName = `${buildUtcStamp()}-${path.basename(sourceProfilePath).replace(/\.json$/i, "")}.json.gz`;
  const outputPath = path.join(baselineDirectory, fileName);
  const payload = await fs.readFile(sourceProfilePath);
  const compressedPayload = await gzipAsync(payload, { level: zlib.constants.Z_BEST_COMPRESSION });
  if (compressedPayload.length > MAX_NAMING_MEMORY_FILE_BYTES) {
    throw new Error(
      `version-bridge: baseline archive exceeds 100MB after compression: ${outputPath} (${compressedPayload.length} bytes)`,
    );
  }
  await fs.writeFile(outputPath, compressedPayload);
  return {
    outputPath,
    outputBytes: compressedPayload.length,
    compressed: true,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2));
  const snapshotDigest = await hashFileSha256(cli.snapshotAsarPath);
  const snapshotKey = snapshotDigest.sha256.slice(0, 12);
  const snapshotLabel = cli.snapshotLabel.length > 0 ? cli.snapshotLabel : path.basename(cli.snapshotAsarPath);

  const namingSnapshotsDirectory = path.join(projectRoot, "naming-memory-store", "snapshots");
  const targetProfilePath = path.join(namingSnapshotsDirectory, `snapshot-${snapshotKey}.json`);
  const sourceProfilePath = await resolveSourceProfilePath(namingSnapshotsDirectory, cli.fromProfile, targetProfilePath);

  const migrationRoot = path.join(projectRoot, "migration", "version-bridge");
  const baselineDirectory = path.join(migrationRoot, "baselines");
  const reportsDirectory = path.join(migrationRoot, "reports");
  await ensureDirectory(baselineDirectory);
  await ensureDirectory(reportsDirectory);
  await ensureDirectory(namingSnapshotsDirectory);

  const sourceStats = await readNamingMemoryStats(sourceProfilePath);
  const targetProfileExistedBefore = await fileExists(targetProfilePath);
  const targetShouldBePreseeded = !targetProfileExistedBefore || cli.overwriteTargetProfile;
  const notes: string[] = [];

  const sourceCompaction = await compactNamingMemoryFile(sourceProfilePath);
  if (sourceCompaction.afterBytes > MAX_NAMING_MEMORY_FILE_BYTES) {
    throw new Error(
      `version-bridge: source naming snapshot exceeds 100MB after compaction: ${sourceCompaction.filePath} (${sourceCompaction.afterBytes} bytes)`,
    );
  }
  if (sourceCompaction.changed) {
    notes.push(
      `source-compacted:${sourceCompaction.filePath}:${sourceCompaction.beforeBytes}->${sourceCompaction.afterBytes}`,
    );
  }

  if (targetProfileExistedBefore) {
    const targetCompaction = await compactNamingMemoryFile(targetProfilePath);
    if (targetCompaction.afterBytes > MAX_NAMING_MEMORY_FILE_BYTES) {
      throw new Error(
        `version-bridge: target naming snapshot exceeds 100MB after compaction: ${targetCompaction.filePath} (${targetCompaction.afterBytes} bytes)`,
      );
    }
    if (targetCompaction.changed) {
      notes.push(
        `target-compacted:${targetCompaction.filePath}:${targetCompaction.beforeBytes}->${targetCompaction.afterBytes}`,
      );
    }
  }

  const baselineCopy = await writeCompressedBaselineCopy(sourceProfilePath, baselineDirectory);
  notes.push(`baseline-copied:${baselineCopy.outputPath}`);

  if (targetShouldBePreseeded) {
    await fs.copyFile(sourceProfilePath, targetProfilePath);
    notes.push(`target-preseeded:${targetProfilePath}`);
  } else {
    notes.push(`target-preserved:${targetProfilePath}`);
  }

  const targetStatsBeforeRun = await readNamingMemoryStats(targetProfilePath);

  const preflightScriptPath = path.join(projectRoot, "..", "shared", "patch-pack", "preflight.mjs");
  const preflightArgs = [
    preflightScriptPath,
    "--snapshot-label",
    snapshotLabel,
    "--app-version",
    cli.appVersion,
    "--build-number",
    cli.buildNumber,
  ];
  if (cli.patchProfile.length > 0) {
    preflightArgs.push("--patch-profile", cli.patchProfile);
  }
  const preflight = await runNodeCommand(projectRoot, preflightArgs, true);
  if (preflight.exitCode !== 0) {
    throw new Error(`version-bridge: patch-pack preflight failed:\n${preflight.stderr || preflight.stdout}`);
  }

  const runId = `${sanitizeRunIdToken(cli.runIdPrefix)}-${buildUtcStamp()}`;
  const runDirectory = path.join(projectRoot, "runs", runId);
  const metricsPath = path.join(runDirectory, "run-metrics.json");
  const summaryPath = path.join(runDirectory, "summary.json");

  let runExecuted = false;
  let runMetrics: RunMetrics | null = null;
  let namingMemoryStage: VersionBridgeReport["namingMemoryStage"] = null;

  if (!cli.dryRun) {
    const indexScriptPath = path.join(projectRoot, "dist", "index.js");
    const runArgs = [
      indexScriptPath,
      "--snapshot",
      cli.snapshotAsarPath,
      "--snapshot-label",
      snapshotLabel,
      "--run-id",
      runId,
      "--profile",
      cli.outputProfile,
      "--statement-budget",
      String(cli.statementBudget),
      "--promotion-budget",
      String(cli.promotionBudget),
      "--gate-mode",
      cli.gateMode,
      "--artifact-retention",
      "minimal",
      "--enable-manual-sync",
    ];
    if (cli.patchProfile.length > 0) {
      runArgs.push("--patch-profile", cli.patchProfile);
    }
    if (cli.allowAfterFreeze) {
      runArgs.push("--allow-after-freeze");
    }
    if (cli.disableWakaru) {
      runArgs.push("--disable-wakaru");
    }
    if (cli.disableJavascriptDeobfuscator) {
      runArgs.push("--disable-javascript-deobfuscator");
    }
    if (cli.disableSynchrony) {
      runArgs.push("--disable-synchrony");
    }
    if (cli.disableUnwebpackSourcemap) {
      runArgs.push("--disable-unwebpack-sourcemap");
    }

    const execution = await runNodeCommand(projectRoot, runArgs, true);
    if (execution.exitCode !== 0) {
      throw new Error(`version-bridge: orchestrator run failed:\n${execution.stderr || execution.stdout}`);
    }
    runExecuted = true;
    runMetrics = await readJsonFile<RunMetrics>(metricsPath);
    const runSummary = await readJsonFile<RunSummary>(summaryPath);
    namingMemoryStage = {
      insertedEntryCount: runSummary.stageOutputs.namingMemory.insertedEntryCount,
      updatedEntryCount: runSummary.stageOutputs.namingMemory.updatedEntryCount,
      keptEntryCount: runSummary.stageOutputs.namingMemory.keptEntryCount,
      manualSyncFingerprintResolvedCount: runSummary.stageOutputs.namingMemory.manualSyncFingerprintResolvedCount,
      baselineQualityBefore: runSummary.stageOutputs.namingMemory.baselineQualityBefore,
      baselineQualityAfter: runSummary.stageOutputs.namingMemory.baselineQualityAfter,
      baselineGuardPassed: runSummary.stageOutputs.namingMemory.baselineGuardPassed,
    };
  } else {
    notes.push("dry-run:no-orchestrator-run");
  }

  const targetStatsAfterRun = await readNamingMemoryStats(targetProfilePath);

  const report: VersionBridgeReport = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    snapshotLabel,
    snapshotSha256: snapshotDigest.sha256,
    snapshotKey,
    sourceProfilePath,
    sourceProfileStats: sourceStats,
    baselineCopyPath: baselineCopy.outputPath,
    baselineCopyBytes: baselineCopy.outputBytes,
    baselineCopyCompressed: baselineCopy.compressed,
    targetProfilePath,
    targetProfileExistedBefore,
    targetProfilePreseeded: targetShouldBePreseeded,
    targetProfileStatsBeforeRun: targetStatsBeforeRun,
    runExecuted,
    runId,
    runDirectory,
    outputProfile: cli.outputProfile,
    gateMode: cli.gateMode,
    patchProfile: cli.patchProfile,
    metricsPath,
    summaryPath,
    runMetrics,
    namingMemoryStage,
    targetProfileStatsAfterRun: targetStatsAfterRun,
    notes,
  };

  const reportPath = path.join(reportsDirectory, `${runId}.json`);
  const latestReportPath = path.join(migrationRoot, "latest-report.json");
  await writeJsonFile(reportPath, report);
  await writeJsonFile(latestReportPath, report);
  process.stdout.write(`${JSON.stringify({ ...report, reportPath, latestReportPath }, null, 2)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
