import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { RunMetrics } from "../contracts";
import { defaultManualSyncRootPath, resolveManualSyncPaths } from "./contracts";
import { validateManualSyncContracts } from "./validator";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  snapshotAsarPath: string;
  manualProjectPath: string;
  generatedProjectPath: string;
  manualSyncRootPath: string;
  mergedEvidencePath?: string;
  promotionTopN: number;
  outputProfile: "latest" | "regression-latest";
  statementBudget: number;
  promotionBudget: number;
  weightsConfigPath?: string;
  runPrefix: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RoundTripReport {
  generatedAtIso: string;
  snapshotAsarPath: string;
  manualProjectPath: string;
  mergedEvidencePath?: string;
  beforeRunId: string;
  afterRunId: string;
  beforeMetrics: RunMetrics;
  afterMetrics: RunMetrics;
  deltas: {
    nameQuality: number;
    mappedSymbols: number;
    variableCoverage: number;
    functionCoverage: number;
    classCoverage: number;
    proxyInQualityCount: number;
  };
  passed: boolean;
  violations: string[];
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/manual-sync/roundtrip-check.js --snapshot <path> --manual-project <path> [options]",
    "",
    "Options:",
    "  --generated-project <path>   default: output/regression-latest/project",
    "  --manual-sync-root <path>    default: shared/manual-sync",
    "  --merged-evidence <path>     optional: merged-evidence.json for top-N export promotion",
    "  --promotion-top-n <n>        default: 120",
    "  --profile <latest|regression-latest>   default: regression-latest",
    "  --statement-budget <n>       default: 32",
    "  --promotion-budget <n>       default: 180",
    "  --weights-config <path>      optional",
    "  --run-prefix <token>         default: manual-sync-roundtrip",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseIntegerOption(flag: string, value: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let snapshotAsarPath = "";
  let manualProjectPath = "";
  let generatedProjectPath = path.join(projectRoot, "output", "regression-latest", "project");
  let manualSyncRootPath = defaultManualSyncRootPath(projectRoot);
  let mergedEvidencePath: string | undefined;
  let promotionTopN = 120;
  let outputProfile: "latest" | "regression-latest" = "regression-latest";
  let statementBudget = 32;
  let promotionBudget = 180;
  let weightsConfigPath: string | undefined;
  let runPrefix = "manual-sync-roundtrip";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --snapshot");
        }
        snapshotAsarPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--manual-project": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --manual-project");
        }
        manualProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--generated-project": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --generated-project");
        }
        generatedProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--manual-sync-root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --manual-sync-root");
        }
        manualSyncRootPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--merged-evidence": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --merged-evidence");
        }
        mergedEvidencePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--promotion-top-n": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --promotion-top-n");
        }
        promotionTopN = parseIntegerOption("--promotion-top-n", value, 0);
        index += 1;
        break;
      }
      case "--profile": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --profile");
        }
        if (value !== "latest" && value !== "regression-latest") {
          throw new Error(`Invalid --profile value: ${value}`);
        }
        outputProfile = value;
        index += 1;
        break;
      }
      case "--statement-budget": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --statement-budget");
        }
        statementBudget = parseIntegerOption("--statement-budget", value, 1);
        index += 1;
        break;
      }
      case "--promotion-budget": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --promotion-budget");
        }
        promotionBudget = parseIntegerOption("--promotion-budget", value, 1);
        index += 1;
        break;
      }
      case "--weights-config": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --weights-config");
        }
        weightsConfigPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--run-prefix": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --run-prefix");
        }
        runPrefix = value.trim();
        if (runPrefix.length < 1) {
          throw new Error("Empty --run-prefix is not allowed");
        }
        index += 1;
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
  if (manualProjectPath.length < 1) {
    throw new Error("Missing required --manual-project");
  }

  return {
    snapshotAsarPath,
    manualProjectPath,
    generatedProjectPath,
    manualSyncRootPath,
    mergedEvidencePath,
    promotionTopN,
    outputProfile,
    statementBudget,
    promotionBudget,
    weightsConfigPath,
    runPrefix,
  };
}

async function runNodeCommand(cwd: string, args: string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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

function buildRunId(prefix: string, suffix: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${prefix}-${suffix}-${y}${m}${d}-${hh}${mm}${ss}`;
}

async function runGenerator(
  projectRoot: string,
  cli: CliOptions,
  runId: string,
): Promise<RunMetrics> {
  const args = [
    path.join(projectRoot, "dist", "index.js"),
    "--snapshot",
    cli.snapshotAsarPath,
    "--run-id",
    runId,
    "--profile",
    cli.outputProfile,
    "--statement-budget",
    String(cli.statementBudget),
    "--promotion-budget",
    String(cli.promotionBudget),
    "--gate-mode",
    "full",
    "--artifact-retention",
    "minimal",
    "--enable-manual-sync",
    "--allow-after-freeze",
    "--manual-sync-root",
    cli.manualSyncRootPath,
  ];
  if (cli.weightsConfigPath && cli.weightsConfigPath.length > 0) {
    args.push("--weights-config", cli.weightsConfigPath);
  }
  const result = await runNodeCommand(projectRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(`roundtrip generator run failed (${runId}):\n${result.stderr || result.stdout}`);
  }
  const metricsPath = path.join(projectRoot, "runs", runId, "run-metrics.json");
  return await readJsonFile<RunMetrics>(metricsPath);
}

async function runExport(
  projectRoot: string,
  cli: CliOptions,
): Promise<void> {
  const args = [
    path.join(projectRoot, "dist", "manual-sync", "export-from-manual.js"),
    "--manual-project",
    cli.manualProjectPath,
    "--generated-project",
    cli.generatedProjectPath,
    "--manual-sync-root",
    cli.manualSyncRootPath,
    "--promotion-top-n",
    String(cli.promotionTopN),
  ];
  if (cli.mergedEvidencePath && cli.mergedEvidencePath.length > 0) {
    args.push("--merged-evidence", cli.mergedEvidencePath);
  }
  const result = await runNodeCommand(projectRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(`roundtrip manual-sync export failed:\n${result.stderr || result.stdout}`);
  }
}

function compareMetrics(before: RunMetrics, after: RunMetrics): string[] {
  const nameQualityRegressionTolerance = 0.001;
  const violations: string[] = [];
  if (after.nameQuality + nameQualityRegressionTolerance < before.nameQuality) {
    violations.push(`nameQuality regressed: ${after.nameQuality} < ${before.nameQuality}`);
  }
  if (after.mappedSymbols < before.mappedSymbols) {
    violations.push(`mappedSymbols regressed: ${after.mappedSymbols} < ${before.mappedSymbols}`);
  }
  if (after.classCoverage + 0.0001 < before.classCoverage) {
    violations.push(`classCoverage regressed: ${after.classCoverage} < ${before.classCoverage}`);
  }
  if (after.functionCoverage + 0.0001 < before.functionCoverage) {
    violations.push(`functionCoverage regressed: ${after.functionCoverage} < ${before.functionCoverage}`);
  }
  if (after.variableCoverage + 0.0001 < before.variableCoverage) {
    violations.push(`variableCoverage regressed: ${after.variableCoverage} < ${before.variableCoverage}`);
  }
  if (after.proxyInQualityCount > before.proxyInQualityCount) {
    violations.push(`proxyInQualityCount increased: ${after.proxyInQualityCount} > ${before.proxyInQualityCount}`);
  }
  if (!after.buildHealth) {
    violations.push("buildHealth is false after roundtrip");
  }
  if (!after.devHealth) {
    violations.push("devHealth is false after roundtrip");
  }
  return violations;
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const manualSyncPaths = resolveManualSyncPaths(projectRoot, cli.manualSyncRootPath);
  await fs.mkdir(manualSyncPaths.rootPath, { recursive: true });

  const preValidation = await validateManualSyncContracts(projectRoot, cli.manualSyncRootPath, { requireFiles: true });
  if (preValidation.errors.length > 0) {
    throw new Error(
      `roundtrip pre-validation failed (${preValidation.errors.length} errors): ${preValidation.errors[0]?.message ?? "unknown"}`,
    );
  }

  const beforeRunId = buildRunId(cli.runPrefix, "before");
  const beforeMetrics = await runGenerator(projectRoot, cli, beforeRunId);
  await runExport(projectRoot, cli);
  const postValidation = await validateManualSyncContracts(projectRoot, cli.manualSyncRootPath, { requireFiles: true });
  if (postValidation.errors.length > 0) {
    throw new Error(
      `roundtrip post-export validation failed (${postValidation.errors.length} errors): ${postValidation.errors[0]?.message ?? "unknown"}`,
    );
  }
  const afterRunId = buildRunId(cli.runPrefix, "after");
  const afterMetrics = await runGenerator(projectRoot, cli, afterRunId);

  const violations = compareMetrics(beforeMetrics, afterMetrics);
  const report: RoundTripReport = {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    manualProjectPath: cli.manualProjectPath,
    mergedEvidencePath: cli.mergedEvidencePath,
    beforeRunId,
    afterRunId,
    beforeMetrics,
    afterMetrics,
    deltas: {
      nameQuality: Number((afterMetrics.nameQuality - beforeMetrics.nameQuality).toFixed(4)),
      mappedSymbols: afterMetrics.mappedSymbols - beforeMetrics.mappedSymbols,
      variableCoverage: Number((afterMetrics.variableCoverage - beforeMetrics.variableCoverage).toFixed(4)),
      functionCoverage: Number((afterMetrics.functionCoverage - beforeMetrics.functionCoverage).toFixed(4)),
      classCoverage: Number((afterMetrics.classCoverage - beforeMetrics.classCoverage).toFixed(4)),
      proxyInQualityCount: afterMetrics.proxyInQualityCount - beforeMetrics.proxyInQualityCount,
    },
    passed: violations.length === 0,
    violations,
  };

  const reportPath = path.join(manualSyncPaths.rootPath, "last-roundtrip-report.json");
  await writeJsonFile(reportPath, report);
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);

  if (violations.length > 0) {
    throw new Error(`roundtrip quality degraded:\n${violations.join("\n")}`);
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
