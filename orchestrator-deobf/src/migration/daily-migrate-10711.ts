import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { OutputProfile, GateMode, RunMetrics } from "../contracts";

interface CliOptions {
  snapshotAsarPath: string;
  snapshotLabel: string;
  appVersion: string;
  buildNumber: string;
  patchProfile: string;
  outputProfile: OutputProfile;
  gateMode: GateMode;
  statementBudget: number;
  promotionBudget: number;
  allowAfterFreeze: boolean;
  fromProfile: string;
  overwriteTargetProfile: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface VersionBridgeReportSnapshot {
  generatedAtIso: string;
  snapshotLabel: string;
  snapshotKey: string;
  patchProfile: string;
  runId: string;
  runMetrics: RunMetrics | null;
  namingMemoryStage: {
    baselineGuardPassed: boolean;
    baselineQualityBefore: number;
    baselineQualityAfter: number;
  } | null;
  targetProfileStatsAfterRun: {
    averageNameQuality: number;
    entryCount: number;
    genericNameCount: number;
  };
}

interface DailyMigrateReport {
  version: number;
  generatedAtIso: string;
  snapshotAsarPath: string;
  snapshotLabel: string;
  appVersion: string;
  buildNumber: string;
  patchProfile: string;
  outputProfile: OutputProfile;
  gateMode: GateMode;
  steps: Array<{
    id: "size-budget" | "preflight" | "migration-bridge";
    command: string;
    exitCode: number;
    durationMs: number;
  }>;
  kpi: {
    buildHealth: boolean;
    devHealth: boolean;
    mappedSymbols: number;
    nameQuality: number;
    baselineGuardPassed: boolean;
    namingEntries: number;
    genericNames: number;
  };
  migrationRun: {
    runId: string;
    snapshotKey: string;
    reportGeneratedAtIso: string;
  };
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/migration/daily-migrate-10711.js --snapshot <path-to-app.asar> [options]",
    "",
    "Options:",
    "  --snapshot-label <label>   default: Codex-10711.dmg",
    "  --app-version <value>      default: 26.303.1606",
    "  --build-number <value>     default: 806",
    "  --patch-profile <id>       default: codex-10711",
    "  --profile <value>          default: regression-latest",
    "  --gate-mode <value>        default: light",
    "  --statement-budget <n>     default: 32",
    "  --promotion-budget <n>     default: 180",
    "  --allow-after-freeze",
    "  --from-profile <path|key>",
    "  --overwrite-target-profile",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`daily-migrate: invalid ${option} value: ${value}`);
  }
  return parsed;
}

function parseOutputProfile(value: string): OutputProfile {
  if (value === "latest" || value === "regression-latest") {
    return value;
  }
  throw new Error(`daily-migrate: invalid --profile value: ${value}`);
}

function parseGateMode(value: string): GateMode {
  if (value === "light" || value === "full") {
    return value;
  }
  throw new Error(`daily-migrate: invalid --gate-mode value: ${value}`);
}

function parseCli(argv: readonly string[]): CliOptions {
  let snapshotAsarPath = "";
  let snapshotLabel = "Codex-10711.dmg";
  let appVersion = "26.303.1606";
  let buildNumber = "806";
  let patchProfile = "codex-10711";
  let outputProfile: OutputProfile = "regression-latest";
  let gateMode: GateMode = "light";
  let statementBudget = 32;
  let promotionBudget = 180;
  let allowAfterFreeze = false;
  let fromProfile = "";
  let overwriteTargetProfile = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --snapshot");
        snapshotAsarPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--snapshot-label": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --snapshot-label");
        snapshotLabel = value.trim();
        index += 1;
        break;
      }
      case "--app-version": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --app-version");
        appVersion = value.trim();
        index += 1;
        break;
      }
      case "--build-number": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --build-number");
        buildNumber = value.trim();
        index += 1;
        break;
      }
      case "--patch-profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --patch-profile");
        patchProfile = value.trim().toLowerCase();
        index += 1;
        break;
      }
      case "--profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --profile");
        outputProfile = parseOutputProfile(value.trim());
        index += 1;
        break;
      }
      case "--gate-mode": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --gate-mode");
        gateMode = parseGateMode(value.trim());
        index += 1;
        break;
      }
      case "--statement-budget": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --statement-budget");
        statementBudget = parseInteger(value, "--statement-budget");
        index += 1;
        break;
      }
      case "--promotion-budget": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --promotion-budget");
        promotionBudget = parseInteger(value, "--promotion-budget");
        index += 1;
        break;
      }
      case "--allow-after-freeze": {
        allowAfterFreeze = true;
        break;
      }
      case "--from-profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("daily-migrate: missing value for --from-profile");
        fromProfile = value.trim();
        index += 1;
        break;
      }
      case "--overwrite-target-profile": {
        overwriteTargetProfile = true;
        break;
      }
      case "--help":
      case "-h": {
        printUsage();
        process.exit(0);
      }
      default:
        throw new Error(`daily-migrate: unknown argument: ${token}`);
    }
  }

  if (!snapshotAsarPath) {
    throw new Error("daily-migrate: missing required --snapshot");
  }

  return {
    snapshotAsarPath,
    snapshotLabel,
    appVersion,
    buildNumber,
    patchProfile,
    outputProfile,
    gateMode,
    statementBudget,
    promotionBudget,
    allowAfterFreeze,
    fromProfile,
    overwriteTargetProfile,
  };
}

async function runNodeCommand(cwd: string, args: string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const startedAt = Date.now();
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
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => {
      const normalized = typeof exitCode === "number" ? exitCode : -1;
      const result: CommandResult = {
        exitCode: normalized,
        stdout,
        stderr: `${stderr}\n[daily-migrate] durationMs=${Date.now() - startedAt}`,
      };
      resolve(result);
    });
  });
}

function utcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2));

  const sharedPatchPackRoot = path.join(projectRoot, "..", "shared", "patch-pack");
  const preflightScriptPath = path.join(sharedPatchPackRoot, "preflight.mjs");
  const bridgeScriptPath = path.join(projectRoot, "dist", "migration", "codex-version-bridge.js");
  const sizeBudgetScriptPath = path.join(projectRoot, "dist", "migration", "enforce-generated-size-budget.js");

  const stepReports: DailyMigrateReport["steps"] = [];

  {
    const startedAt = Date.now();
    const result = await runNodeCommand(projectRoot, [sizeBudgetScriptPath]);
    stepReports.push({
      id: "size-budget",
      command: `${process.execPath} ${sizeBudgetScriptPath}`,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
    });
    if (result.exitCode !== 0) {
      throw new Error(`daily-migrate: size-budget failed:\n${result.stderr || result.stdout}`);
    }
  }

  const preflightArgs = [
    preflightScriptPath,
    "--snapshot-label",
    cli.snapshotLabel,
    "--app-version",
    cli.appVersion,
    "--build-number",
    cli.buildNumber,
    "--patch-profile",
    cli.patchProfile,
  ];
  {
    const startedAt = Date.now();
    const result = await runNodeCommand(projectRoot, preflightArgs);
    stepReports.push({
      id: "preflight",
      command: `${process.execPath} ${preflightArgs.join(" ")}`,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
    });
    if (result.exitCode !== 0) {
      throw new Error(`daily-migrate: preflight failed:\n${result.stderr || result.stdout}`);
    }
  }

  const bridgeArgs = [
    bridgeScriptPath,
    "--snapshot",
    cli.snapshotAsarPath,
    "--snapshot-label",
    cli.snapshotLabel,
    "--patch-profile",
    cli.patchProfile,
    "--app-version",
    cli.appVersion,
    "--build-number",
    cli.buildNumber,
    "--profile",
    cli.outputProfile,
    "--gate-mode",
    cli.gateMode,
    "--statement-budget",
    String(cli.statementBudget),
    "--promotion-budget",
    String(cli.promotionBudget),
  ];
  if (cli.allowAfterFreeze) {
    bridgeArgs.push("--allow-after-freeze");
  }
  if (cli.fromProfile.length > 0) {
    bridgeArgs.push("--from-profile", cli.fromProfile);
  }
  if (cli.overwriteTargetProfile) {
    bridgeArgs.push("--overwrite-target-profile");
  }

  {
    const startedAt = Date.now();
    const result = await runNodeCommand(projectRoot, bridgeArgs);
    stepReports.push({
      id: "migration-bridge",
      command: `${process.execPath} ${bridgeArgs.join(" ")}`,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
    });
    if (result.exitCode !== 0) {
      throw new Error(`daily-migrate: migration bridge failed:\n${result.stderr || result.stdout}`);
    }
  }

  const latestBridgeReportPath = path.join(projectRoot, "migration", "version-bridge", "latest-report.json");
  const latestBridgeReport = await readJsonFile<VersionBridgeReportSnapshot>(latestBridgeReportPath);

  const nameQualityFromMetrics = latestBridgeReport.runMetrics?.nameQuality;
  const nameQuality = typeof nameQualityFromMetrics === "number"
    ? nameQualityFromMetrics
    : latestBridgeReport.targetProfileStatsAfterRun.averageNameQuality;

  const summary: DailyMigrateReport = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    snapshotLabel: cli.snapshotLabel,
    appVersion: cli.appVersion,
    buildNumber: cli.buildNumber,
    patchProfile: cli.patchProfile,
    outputProfile: cli.outputProfile,
    gateMode: cli.gateMode,
    steps: stepReports,
    kpi: {
      buildHealth: Boolean(latestBridgeReport.runMetrics?.buildHealth),
      devHealth: Boolean(latestBridgeReport.runMetrics?.devHealth),
      mappedSymbols: latestBridgeReport.runMetrics?.mappedSymbols ?? 0,
      nameQuality,
      baselineGuardPassed: Boolean(latestBridgeReport.namingMemoryStage?.baselineGuardPassed),
      namingEntries: latestBridgeReport.targetProfileStatsAfterRun.entryCount,
      genericNames: latestBridgeReport.targetProfileStatsAfterRun.genericNameCount,
    },
    migrationRun: {
      runId: latestBridgeReport.runId,
      snapshotKey: latestBridgeReport.snapshotKey,
      reportGeneratedAtIso: latestBridgeReport.generatedAtIso,
    },
  };

  const reportRoot = path.join(projectRoot, "migration", "daily-migrate-10711");
  await ensureDirectory(reportRoot);
  const stampedReportPath = path.join(reportRoot, `${utcStamp()}.json`);
  const latestReportPath = path.join(reportRoot, "latest-report.json");
  await writeJsonFile(stampedReportPath, summary);
  await writeJsonFile(latestReportPath, summary);
  process.stdout.write(`${JSON.stringify({ ...summary, reportPath: stampedReportPath, latestReportPath }, null, 2)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
