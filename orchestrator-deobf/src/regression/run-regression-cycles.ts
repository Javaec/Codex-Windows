import * as path from "node:path";
import { cleanupKeepLastN } from "./cleanup";
import { executeRegressionSuite, RegressionSuiteExecution } from "./execute-suite";
import { applyMergedEvidencePromotion, ApplyMergedEvidencePromotionResult } from "./merged-evidence-promotion";
import { loadRegressionSuite } from "./suite-loader";
import { resolveNamingMemoryProfilePath } from "../naming/profile-store";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  snapshotAsarPath: string;
  suiteConfigPath: string;
  weightsConfigPath: string;
  outputRoot: string;
  baselinePath: string;
  keepLastN: number;
  maxCycles: number;
  stagnationLimit: number;
  minQualityDelta: number;
  suiteRunPrefix: string;
  promotionBudgetPerCycle: number;
}

interface CycleExecutionSummary {
  cycleIndex: number;
  suiteRunId: string;
  averageScore: number;
  nameQualityAverage: number;
  highConfidenceSymbolsAverage: number;
  mappedSymbolsAverage: number;
  variableCoverageAverage: number;
  promotionSelectedCount: number;
  promotionUpdatedCount: number;
  promotionInsertedCount: number;
  promotionAverageQuality: number;
  qualityDeltaFromPrevious: number;
  highConfidenceDeltaFromPrevious: number;
  stagnationStrike: number;
}

interface CycleReport {
  generatedAtIso: string;
  snapshotAsarPath: string;
  maxCycles: number;
  stagnationLimit: number;
  minQualityDelta: number;
  promotionBudgetPerCycle: number;
  completedCycles: number;
  stopReason: string;
  cycles: CycleExecutionSummary[];
  finalBaselinePath: string;
  namingMemoryProfilePath: string;
}

function buildRunId(prefix: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${prefix}-${y}${m}${d}-${hh}${mm}${ss}`;
}

function parseIntegerOption(token: string, value: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function parseFloatOption(token: string, value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let snapshotAsarPath = "";
  let suiteConfigPath = path.join(projectRoot, "config", "regression-suite.json");
  let weightsConfigPath = path.join(projectRoot, "config", "tool-weights.json");
  let outputRoot = path.join(projectRoot, "regression", "runs");
  let baselinePath = path.join(projectRoot, "regression", "baseline-metrics.json");
  let keepLastN = 8;
  let maxCycles = 8;
  let stagnationLimit = 3;
  let minQualityDelta = 0.02;
  let suiteRunPrefix = "cycle";
  let promotionBudgetPerCycle = 100;

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
      case "--suite-config": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --suite-config");
        }
        suiteConfigPath = path.resolve(value);
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
      case "--output-root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-root");
        }
        outputRoot = path.resolve(value);
        index += 1;
        break;
      }
      case "--baseline-path": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --baseline-path");
        }
        baselinePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--keep-last-n": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --keep-last-n");
        }
        keepLastN = parseIntegerOption("--keep-last-n", value, 1);
        index += 1;
        break;
      }
      case "--max-cycles": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --max-cycles");
        }
        maxCycles = parseIntegerOption("--max-cycles", value, 1);
        index += 1;
        break;
      }
      case "--stagnation-limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --stagnation-limit");
        }
        stagnationLimit = parseIntegerOption("--stagnation-limit", value, 1);
        index += 1;
        break;
      }
      case "--min-quality-delta": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --min-quality-delta");
        }
        minQualityDelta = parseFloatOption("--min-quality-delta", value, 0);
        index += 1;
        break;
      }
      case "--suite-run-prefix": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --suite-run-prefix");
        }
        suiteRunPrefix = value;
        index += 1;
        break;
      }
      case "--promotion-budget-per-cycle": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --promotion-budget-per-cycle");
        }
        promotionBudgetPerCycle = parseIntegerOption("--promotion-budget-per-cycle", value, 1);
        index += 1;
        break;
      }
      case "--help": {
        const usage = [
          "Usage:",
          "  node dist/regression/run-regression-cycles.js --snapshot <path-to-app.asar>",
          "",
          "Options:",
          "  --suite-config <path>",
          "  --weights-config <path>",
          "  --output-root <path>",
          "  --baseline-path <path>",
          "  --keep-last-n <n>",
          "  --max-cycles <n>",
          "  --stagnation-limit <n>",
          "  --min-quality-delta <float>",
          "  --suite-run-prefix <token>",
          "  --promotion-budget-per-cycle <n>",
        ].join("\n");
        process.stdout.write(`${usage}\n`);
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (snapshotAsarPath.length === 0) {
    throw new Error("Argument --snapshot is required");
  }

  return {
    snapshotAsarPath,
    suiteConfigPath,
    weightsConfigPath,
    outputRoot,
    baselinePath,
    keepLastN,
    maxCycles,
    stagnationLimit,
    minQualityDelta,
    suiteRunPrefix,
    promotionBudgetPerCycle,
  };
}

function summarizeCycle(
  cycleIndex: number,
  suiteRunId: string,
  execution: RegressionSuiteExecution,
  promotion: ApplyMergedEvidencePromotionResult,
  previous: CycleExecutionSummary | undefined,
  minQualityDelta: number,
  stagnationStrike: number,
): CycleExecutionSummary {
  const qualityDeltaRaw = previous ? execution.aggregate.averageScore - previous.averageScore : execution.aggregate.averageScore;
  const qualityDelta = Number(qualityDeltaRaw.toFixed(4));
  const highConfidenceDeltaRaw = previous
    ? execution.aggregate.highConfidenceSymbolsAverage - previous.highConfidenceSymbolsAverage
    : execution.aggregate.highConfidenceSymbolsAverage;
  const highConfidenceDelta = Number(highConfidenceDeltaRaw.toFixed(4));
  const strike =
    previous && qualityDelta < minQualityDelta && highConfidenceDelta <= 0
      ? stagnationStrike + 1
      : 0;
  return {
    cycleIndex,
    suiteRunId,
    averageScore: execution.aggregate.averageScore,
    nameQualityAverage: execution.aggregate.nameQualityAverage,
    highConfidenceSymbolsAverage: execution.aggregate.highConfidenceSymbolsAverage,
    mappedSymbolsAverage: execution.aggregate.mappedSymbolsAverage,
    variableCoverageAverage: execution.aggregate.variableCoverageAverage,
    promotionSelectedCount: promotion.selectedCount,
    promotionUpdatedCount: promotion.updatedEntryCount,
    promotionInsertedCount: promotion.insertedEntryCount,
    promotionAverageQuality: promotion.averageSelectedQuality,
    qualityDeltaFromPrevious: qualityDelta,
    highConfidenceDeltaFromPrevious: highConfidenceDelta,
    stagnationStrike: strike,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  await ensureDirectory(cli.outputRoot);
  const suite = await loadRegressionSuite(cli.suiteConfigPath);
  const snapshotDigest = await hashFileSha256(cli.snapshotAsarPath);
  const snapshotKey = snapshotDigest.sha256.slice(0, 12);
  const namingMemoryProfile = await resolveNamingMemoryProfilePath(projectRoot, snapshotKey);

  const cycleSummaries: CycleExecutionSummary[] = [];
  let previous: CycleExecutionSummary | undefined;
  let lastExecution: RegressionSuiteExecution | undefined;
  let stopReason = "max_cycles_reached";
  const baseRunToken = buildRunId(cli.suiteRunPrefix);

  for (let cycleIndex = 1; cycleIndex <= cli.maxCycles; cycleIndex += 1) {
    const cycleRunId = `${baseRunToken}-c${String(cycleIndex).padStart(2, "0")}`;
    const execution = await executeRegressionSuite({
      projectRoot,
      snapshotAsarPath: cli.snapshotAsarPath,
      suite,
      weightsConfigPath: cli.weightsConfigPath,
      suiteRunId: cycleRunId,
      outputProfile: "regression-latest",
      outputDirectory: cli.outputRoot,
    });
    const promotion = await applyMergedEvidencePromotion({
      mergedEvidencePath: execution.mergedEvidencePath,
      namingMemoryPath: namingMemoryProfile.profilePath,
      legacyNamingMemoryPath: namingMemoryProfile.legacyPath,
      runId: `${cycleRunId}:merged-evidence-promotion`,
      promotionBudget: cli.promotionBudgetPerCycle,
    });

    const previousStrike = previous ? previous.stagnationStrike : 0;
    const summary = summarizeCycle(
      cycleIndex,
      cycleRunId,
      execution,
      promotion,
      previous,
      cli.minQualityDelta,
      previousStrike,
    );
    cycleSummaries.push(summary);
    previous = summary;
    lastExecution = execution;

    await writeJsonFile(cli.baselinePath, execution);
    await cleanupKeepLastN(cli.outputRoot, cli.keepLastN);

    if (summary.stagnationStrike >= cli.stagnationLimit) {
      stopReason = `stagnation_limit_reached:${cli.stagnationLimit}`;
      break;
    }
  }

  if (!lastExecution) {
    throw new Error("No regression cycle was executed");
  }

  const report: CycleReport = {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    maxCycles: cli.maxCycles,
    stagnationLimit: cli.stagnationLimit,
    minQualityDelta: cli.minQualityDelta,
    promotionBudgetPerCycle: cli.promotionBudgetPerCycle,
    completedCycles: cycleSummaries.length,
    stopReason,
    cycles: cycleSummaries,
    finalBaselinePath: cli.baselinePath,
    namingMemoryProfilePath: namingMemoryProfile.profilePath,
  };

  const reportPath = path.join(path.dirname(cli.baselinePath), "cycle-report.json");
  await writeJsonFile(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
