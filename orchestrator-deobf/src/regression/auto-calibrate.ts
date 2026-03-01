import * as path from "node:path";
import { ToolWeights } from "../contracts";
import { ensureDirectory, writeJsonFile } from "../utils/fs-json";
import { cleanupKeepLastN } from "./cleanup";
import { executeRegressionSuite, RegressionSuiteExecution } from "./execute-suite";
import { loadRegressionSuite, loadToolWeights } from "./suite-loader";

interface CliOptions {
  snapshotAsarPath: string;
  suiteConfigPath: string;
  baseWeightsPath: string;
  outputWeightsPath: string;
  outputRoot: string;
  keepLastN: number;
  maxCandidates: number;
  calibrationRunId: string;
}

interface CandidateResult {
  candidateId: string;
  weightsPath: string;
  weights: ToolWeights;
  status: "executed" | "failed";
  score: number;
  reason: string;
  execution?: RegressionSuiteExecution;
}

const TOOL_KEYS: Array<keyof ToolWeights> = [
  "asar",
  "webcrack",
  "wakaru",
  "javascriptDeobfuscator",
  "synchrony",
  "unwebpackSourcemap",
];

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

function parseIntegerOption(token: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let snapshotAsarPath = "";
  let suiteConfigPath = path.join(projectRoot, "config", "regression-suite.json");
  let baseWeightsPath = path.join(projectRoot, "config", "tool-weights.json");
  let outputWeightsPath = path.join(projectRoot, "config", "tool-weights.json");
  let outputRoot = path.join(projectRoot, "regression", "calibration-runs");
  let keepLastN = 4;
  let maxCandidates = 8;
  let calibrationRunId = buildRunId("calibration");

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
      case "--base-weights": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --base-weights");
        }
        baseWeightsPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--output-weights": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-weights");
        }
        outputWeightsPath = path.resolve(value);
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
      case "--keep-last-n": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --keep-last-n");
        }
        keepLastN = parseIntegerOption("--keep-last-n", value);
        index += 1;
        break;
      }
      case "--max-candidates": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --max-candidates");
        }
        maxCandidates = parseIntegerOption("--max-candidates", value);
        index += 1;
        break;
      }
      case "--calibration-run-id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --calibration-run-id");
        }
        calibrationRunId = value;
        index += 1;
        break;
      }
      case "--help": {
        const usage = [
          "Usage:",
          "  node dist/regression/auto-calibrate.js --snapshot <path-to-app.asar>",
          "",
          "Options:",
          "  --suite-config <path>",
          "  --base-weights <path>",
          "  --output-weights <path>",
          "  --output-root <path>",
          "  --keep-last-n <n>",
          "  --max-candidates <n>",
          "  --calibration-run-id <id>",
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
    baseWeightsPath,
    outputWeightsPath,
    outputRoot,
    keepLastN,
    maxCandidates,
    calibrationRunId,
  };
}

function clampWeight(value: number): number {
  if (value < 0.5) {
    return 0.5;
  }
  if (value > 1.5) {
    return 1.5;
  }
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function minTargetScore(value: number, minValue: number): number {
  if (value >= minValue) {
    return 1;
  }
  return Math.max(0, value / minValue);
}

function scoreExecution(execution: RegressionSuiteExecution): number {
  const mappedFilesScore = minTargetScore(execution.aggregate.mappedFilesAverage, 5);
  const mappedSymbolsScore = Math.max(0, Math.min(1, execution.aggregate.mappedSymbolsAverage / 16));
  const nameQualityScore = Math.max(0, Math.min(1, execution.aggregate.nameQualityAverage));
  const healthScore = execution.aggregate.buildHealthAllGreen && execution.aggregate.devHealthAllGreen ? 1 : 0;
  const total =
    execution.aggregate.averageScore * 0.45 +
    execution.aggregate.minScore * 0.2 +
    mappedFilesScore * 0.15 +
    mappedSymbolsScore * 0.15 +
    nameQualityScore * 0.05 +
    healthScore * 0.05;
  return Number(clamp01(total).toFixed(4));
}

function candidateIdFromWeights(weights: ToolWeights): string {
  return TOOL_KEYS.map((key) => `${key}-${weights[key].toFixed(2)}`).join("_");
}

function makeCandidate(base: ToolWeights, key: keyof ToolWeights, delta: number): ToolWeights {
  return {
    ...base,
    [key]: clampWeight(base[key] + delta),
  };
}

function uniqueCandidates(candidates: ToolWeights[]): ToolWeights[] {
  const seen = new Set<string>();
  const result: ToolWeights[] = [];
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function buildCandidates(baseWeights: ToolWeights): ToolWeights[] {
  const candidates: ToolWeights[] = [baseWeights];
  for (const key of TOOL_KEYS) {
    candidates.push(makeCandidate(baseWeights, key, 0.08));
    candidates.push(makeCandidate(baseWeights, key, -0.08));
  }
  for (const key of ["webcrack", "wakaru", "unwebpackSourcemap"] as Array<keyof ToolWeights>) {
    candidates.push(makeCandidate(baseWeights, key, 0.12));
    candidates.push(makeCandidate(baseWeights, key, -0.12));
  }
  return uniqueCandidates(candidates);
}

async function runCandidate(
  projectRoot: string,
  snapshotAsarPath: string,
  suiteConfigPath: string,
  outputRoot: string,
  calibrationRunId: string,
  candidateIndex: number,
  weights: ToolWeights,
): Promise<CandidateResult> {
  const suite = await loadRegressionSuite(suiteConfigPath);
  const candidateLabel = `candidate-${String(candidateIndex + 1).padStart(2, "0")}`;
  const candidateRoot = path.join(outputRoot, calibrationRunId, candidateLabel);
  const candidateWeightsPath = path.join(candidateRoot, "tool-weights.json");
  await ensureDirectory(candidateRoot);
  await writeJsonFile(candidateWeightsPath, weights);

  try {
    const execution = await executeRegressionSuite({
      projectRoot,
      snapshotAsarPath,
      suite,
      weightsConfigPath: candidateWeightsPath,
      suiteRunId: `${calibrationRunId}-${candidateLabel}`,
      outputProfile: "regression-latest",
      outputDirectory: path.join(candidateRoot, "suite-runs"),
      gateMode: "full",
      artifactRetention: "minimal",
    });
    const score = scoreExecution(execution);
    return {
      candidateId: candidateIdFromWeights(weights),
      weightsPath: candidateWeightsPath,
      weights,
      status: "executed",
      score,
      reason: "ok",
      execution,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidateId: candidateIdFromWeights(weights),
      weightsPath: candidateWeightsPath,
      weights,
      status: "failed",
      score: 0,
      reason: message,
    };
  }
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const globalRunsRoot = path.join(projectRoot, "runs");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const baseWeights = await loadToolWeights(cli.baseWeightsPath);
  const candidates = buildCandidates(baseWeights).slice(0, cli.maxCandidates);
  await ensureDirectory(cli.outputRoot);
  await ensureDirectory(globalRunsRoot);

  const results: CandidateResult[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      throw new Error("Missing candidate");
    }
    const result = await runCandidate(
      projectRoot,
      cli.snapshotAsarPath,
      cli.suiteConfigPath,
      cli.outputRoot,
      cli.calibrationRunId,
      index,
      candidate,
    );
    results.push(result);
  }

  const successful = results
    .filter((entry) => entry.status === "executed")
    .sort((left, right) => right.score - left.score);
  if (successful.length === 0) {
    throw new Error("Calibration failed: all candidates failed");
  }
  const best = successful[0];
  if (!best) {
    throw new Error("Calibration failed: missing best candidate");
  }

  await writeJsonFile(cli.outputWeightsPath, best.weights);

  const report = {
    generatedAtIso: new Date().toISOString(),
    calibrationRunId: cli.calibrationRunId,
    snapshotAsarPath: cli.snapshotAsarPath,
    suiteConfigPath: cli.suiteConfigPath,
    baseWeightsPath: cli.baseWeightsPath,
    outputWeightsPath: cli.outputWeightsPath,
    candidateCount: candidates.length,
    successfulCount: successful.length,
    bestCandidateId: best.candidateId,
    bestScore: best.score,
    bestWeightsPath: best.weightsPath,
    results,
  };

  const reportPath = path.join(cli.outputRoot, cli.calibrationRunId, "calibration-report.json");
  await writeJsonFile(reportPath, report);
  await cleanupKeepLastN(cli.outputRoot, cli.keepLastN);
  await cleanupKeepLastN(globalRunsRoot, Math.max(cli.keepLastN * 3, 24));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
