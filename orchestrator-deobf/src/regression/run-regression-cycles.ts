import * as path from "node:path";
import { ToolWeights } from "../contracts";
import { cleanupKeepLastN } from "./cleanup";
import { executeRegressionSuite, RegressionSuiteExecution } from "./execute-suite";
import { applyMergedEvidencePromotion, ApplyMergedEvidencePromotionResult } from "./merged-evidence-promotion";
import { loadRegressionSuite, loadToolWeights } from "./suite-loader";
import { RegressionProfile, RegressionSuite } from "./suite-model";
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

interface AdaptiveProfileWeightsResult {
  reportPath: string;
  profileCount: number;
  weightsByProfileId: Record<string, string>;
}

interface CycleExecutionSummary {
  cycleIndex: number;
  suiteRunId: string;
  averageScore: number;
  nameQualityAverage: number;
  highConfidenceSymbolsAverage: number;
  mappedSymbolsAverage: number;
  classCoverageAverage: number;
  functionCoverageAverage: number;
  functionClassCoverageAverage: number;
  variableCoverageAverage: number;
  worstFileDecileScoreAverage: number;
  lowQualityFileCountAverage: number;
  rerenderedModuleAverage: number;
  hotChunkAverage: number;
  promotionSelectedCount: number;
  promotionUpdatedCount: number;
  promotionInsertedCount: number;
  promotionAverageQuality: number;
  qualityDeltaFromPrevious: number;
  highConfidenceDeltaFromPrevious: number;
  fileQualityDeltaFromPrevious: number;
  fileQualityBaselineGuardPassed: boolean;
  stagnationStrike: number;
  adaptiveWeightsProfileCount: number;
  adaptiveWeightsReportPath: string;
  kpiPassed: boolean;
  kpiViolations: string[];
}

interface CycleReport {
  generatedAtIso: string;
  snapshotAsarPath: string;
  maxCycles: number;
  stagnationLimit: number;
  minQualityDelta: number;
  promotionBudgetPerCycle: number;
  kpiTargets: {
    classCoverage: number;
    functionCoverage: number;
    functionClassCoverage: number;
    variableCoverage: number;
    monotonicNameQuality: boolean;
    buildHealthAllGreen: boolean;
    devHealthAllGreen: boolean;
    fileQualityNoRegression: boolean;
    hotChunkMin: number;
    hotChunkMax: number;
    rerenderedModuleAverageMin: number;
  };
  completedCycles: number;
  stopReason: string;
  cycles: CycleExecutionSummary[];
  finalBaselinePath: string;
  namingMemoryProfilePath: string;
  manualRefactorCandidatesPath: string;
}

interface ManualRefactorCandidate {
  filePath: string;
  averageScore: number;
  minScore: number;
  averageNameQuality: number;
  averageConfidence: number;
  averageLiftedCoverage: number;
  averageSymbolCount: number;
  rerenderedHits: number;
  profiles: string[];
  moduleIds: string[];
  stableProjects: string[];
}

interface ManualRefactorAccumulator {
  filePath: string;
  scoreSum: number;
  minScore: number;
  averageNameQualitySum: number;
  averageConfidenceSum: number;
  liftedCoverageSum: number;
  symbolCountSum: number;
  rerenderedHits: number;
  sampleCount: number;
  profiles: Set<string>;
  moduleIds: Set<string>;
  stableProjects: Set<string>;
}

const KPI_TARGET_CLASS_COVERAGE = 1;
const KPI_TARGET_FUNCTION_COVERAGE = 1;
const KPI_TARGET_FUNCTION_CLASS_COVERAGE = 1;
const KPI_TARGET_VARIABLE_COVERAGE = 0.5;
const FILE_QUALITY_BASELINE_DELTA_FLOOR = -0.005;
const KPI_TARGET_HOT_CHUNK_MIN = 20;
const KPI_TARGET_HOT_CHUNK_MAX = 30;
const KPI_TARGET_RERENDERED_MODULE_AVERAGE_MIN = 1;
const FIXED_REGRESSION_PROFILE_IDS = [
  "core-no-binary",
  "core-no-binary-no-pretty",
  "core-no-binary-top120",
  "core-runtime-probe-soft",
] as const;

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

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return Number(value.toFixed(4));
}

function clampWeight(value: number): number {
  return clamp(value, 0.5, 2.6);
}

function validateFixedRegressionProfiles(suite: RegressionSuite): void {
  if (suite.profiles.length !== FIXED_REGRESSION_PROFILE_IDS.length) {
    throw new Error(
      `regression-suite must contain exactly ${FIXED_REGRESSION_PROFILE_IDS.length} fixed profiles, got ${suite.profiles.length}`,
    );
  }
  const sortedActual = [...suite.profiles.map((profile) => profile.id)].sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...FIXED_REGRESSION_PROFILE_IDS].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < sortedExpected.length; index += 1) {
    if (sortedActual[index] !== sortedExpected[index]) {
      throw new Error(
        `regression-suite profile mismatch; expected [${sortedExpected.join(", ")}], got [${sortedActual.join(", ")}]`,
      );
    }
  }
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
  let promotionBudgetPerCycle = 140;

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

function buildFlagScale(profile: RegressionProfile): ToolWeights {
  const statementScale = profile.flags.statementBudget <= 24 ? 1.08 : profile.flags.statementBudget >= 56 ? 1.04 : 1;
  const sourcemapScale = profile.flags.enableUnwebpackSourcemap
    ? profile.flags.unwebpackSourcemapMaxMaps >= 40
      ? 1.16
      : 1.08
    : 0.72;
  return {
    asar: profile.flags.enableUnwebpackSourcemap ? 1.04 : 1,
    webcrack: statementScale,
    wakaru: statementScale,
    javascriptDeobfuscator: profile.flags.enableJavascriptDeobfuscator ? 1.08 : 0.72,
    synchrony: profile.flags.enableSynchrony ? 1.08 : 0.72,
    unwebpackSourcemap: sourcemapScale,
  };
}

function buildAdaptiveWeights(
  baseWeights: ToolWeights,
  profile: RegressionProfile,
  previousExecution: RegressionSuiteExecution | undefined,
): {
  weights: ToolWeights;
  performanceScale: number;
  flagScale: ToolWeights;
  referenceScore: number;
  referenceAverageScore: number;
} {
  if (!previousExecution) {
    return {
      weights: { ...baseWeights },
      performanceScale: 1,
      flagScale: buildFlagScale(profile),
      referenceScore: 0,
      referenceAverageScore: 0,
    };
  }
  const profileExecution = previousExecution.profiles.find((entry) => entry.profileId === profile.id);
  if (!profileExecution) {
    throw new Error(`adaptive-weights: missing previous profile execution for ${profile.id}`);
  }
  const referenceAverageScore = previousExecution.aggregate.averageScore;
  const referenceScore = profileExecution.score.total;
  const performanceDelta = referenceScore - referenceAverageScore;
  const performanceScale = clamp(1 + performanceDelta * 0.28, 0.88, 1.12);
  const flagScale = buildFlagScale(profile);
  return {
    weights: {
      asar: clampWeight(baseWeights.asar * performanceScale * flagScale.asar),
      webcrack: clampWeight(baseWeights.webcrack * performanceScale * flagScale.webcrack),
      wakaru: clampWeight(baseWeights.wakaru * performanceScale * flagScale.wakaru),
      javascriptDeobfuscator: clampWeight(
        baseWeights.javascriptDeobfuscator * performanceScale * flagScale.javascriptDeobfuscator,
      ),
      synchrony: clampWeight(baseWeights.synchrony * performanceScale * flagScale.synchrony),
      unwebpackSourcemap: clampWeight(baseWeights.unwebpackSourcemap * performanceScale * flagScale.unwebpackSourcemap),
    },
    performanceScale,
    flagScale,
    referenceScore,
    referenceAverageScore,
  };
}

async function createAdaptiveProfileWeights(
  outputRoot: string,
  cycleRunId: string,
  suite: RegressionSuite,
  baseWeights: ToolWeights,
  previousExecution: RegressionSuiteExecution | undefined,
): Promise<AdaptiveProfileWeightsResult> {
  const cycleDirectory = path.join(outputRoot, sanitizeToken(cycleRunId));
  const adaptiveDirectory = path.join(cycleDirectory, "adaptive-weights");
  await ensureDirectory(adaptiveDirectory);

  const weightsByProfileId: Record<string, string> = {};
  const profileEntries: Array<{
    profileId: string;
    weightsPath: string;
    weights: ToolWeights;
    performanceScale: number;
    flagScale: ToolWeights;
    referenceScore: number;
    referenceAverageScore: number;
  }> = [];

  for (const profile of suite.profiles) {
    const adaptive = buildAdaptiveWeights(baseWeights, profile, previousExecution);
    const weightsPath = path.join(adaptiveDirectory, `${sanitizeToken(profile.id)}.weights.json`);
    await writeJsonFile(weightsPath, adaptive.weights);
    weightsByProfileId[profile.id] = weightsPath;
    profileEntries.push({
      profileId: profile.id,
      weightsPath,
      weights: adaptive.weights,
      performanceScale: adaptive.performanceScale,
      flagScale: adaptive.flagScale,
      referenceScore: adaptive.referenceScore,
      referenceAverageScore: adaptive.referenceAverageScore,
    });
  }

  const reportPath = path.join(adaptiveDirectory, "adaptive-weights-report.json");
  await writeJsonFile(reportPath, {
    generatedAtIso: new Date().toISOString(),
    cycleRunId,
    profileCount: profileEntries.length,
    baseWeights,
    profiles: profileEntries,
  });

  return {
    reportPath,
    profileCount: profileEntries.length,
    weightsByProfileId,
  };
}

function summarizeCycle(
  cycleIndex: number,
  suiteRunId: string,
  execution: RegressionSuiteExecution,
  promotion: ApplyMergedEvidencePromotionResult,
  adaptiveWeights: AdaptiveProfileWeightsResult,
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
  const fileQualityDeltaRaw = previous
    ? execution.aggregate.worstFileDecileScoreAverage - previous.worstFileDecileScoreAverage
    : execution.aggregate.worstFileDecileScoreAverage;
  const fileQualityDelta = Number(fileQualityDeltaRaw.toFixed(4));
  const fileQualityBaselineGuardPassed = !previous || fileQualityDelta >= FILE_QUALITY_BASELINE_DELTA_FLOOR;
  const strike =
    previous && qualityDelta < minQualityDelta && highConfidenceDelta <= 0 && fileQualityDelta <= 0
      ? stagnationStrike + 1
      : 0;

  const kpiViolations: string[] = [];
  if (execution.aggregate.classCoverageAverage < KPI_TARGET_CLASS_COVERAGE) {
    kpiViolations.push(`classCoverageAverage ${execution.aggregate.classCoverageAverage} < ${KPI_TARGET_CLASS_COVERAGE}`);
  }
  if (execution.aggregate.functionCoverageAverage < KPI_TARGET_FUNCTION_COVERAGE) {
    kpiViolations.push(
      `functionCoverageAverage ${execution.aggregate.functionCoverageAverage} < ${KPI_TARGET_FUNCTION_COVERAGE}`,
    );
  }
  if (execution.aggregate.functionClassCoverageAverage < KPI_TARGET_FUNCTION_CLASS_COVERAGE) {
    kpiViolations.push(
      `functionClassCoverageAverage ${execution.aggregate.functionClassCoverageAverage} < ${KPI_TARGET_FUNCTION_CLASS_COVERAGE}`,
    );
  }
  if (execution.aggregate.variableCoverageAverage < KPI_TARGET_VARIABLE_COVERAGE) {
    kpiViolations.push(
      `variableCoverageAverage ${execution.aggregate.variableCoverageAverage} < ${KPI_TARGET_VARIABLE_COVERAGE}`,
    );
  }
  if (!execution.aggregate.buildHealthAllGreen) {
    kpiViolations.push("buildHealthAllGreen is false");
  }
  if (!execution.aggregate.devHealthAllGreen) {
    kpiViolations.push("devHealthAllGreen is false");
  }
  if (execution.aggregate.hotChunkAverage < KPI_TARGET_HOT_CHUNK_MIN) {
    kpiViolations.push(
      `hotChunkAverage ${execution.aggregate.hotChunkAverage} < ${KPI_TARGET_HOT_CHUNK_MIN}`,
    );
  }
  if (execution.aggregate.hotChunkAverage > KPI_TARGET_HOT_CHUNK_MAX) {
    kpiViolations.push(
      `hotChunkAverage ${execution.aggregate.hotChunkAverage} > ${KPI_TARGET_HOT_CHUNK_MAX}`,
    );
  }
  if (execution.aggregate.rerenderedModuleAverage < KPI_TARGET_RERENDERED_MODULE_AVERAGE_MIN) {
    kpiViolations.push(
      `rerenderedModuleAverage ${execution.aggregate.rerenderedModuleAverage} < ${KPI_TARGET_RERENDERED_MODULE_AVERAGE_MIN}`,
    );
  }
  if (previous && execution.aggregate.nameQualityAverage < previous.nameQualityAverage) {
    kpiViolations.push(`nameQualityAverage regressed: ${execution.aggregate.nameQualityAverage} < ${previous.nameQualityAverage}`);
  }
  if (!fileQualityBaselineGuardPassed) {
    kpiViolations.push(
      `file-quality baseline guard failed: delta ${fileQualityDelta} < ${FILE_QUALITY_BASELINE_DELTA_FLOOR}`,
    );
  }

  return {
    cycleIndex,
    suiteRunId,
    averageScore: execution.aggregate.averageScore,
    nameQualityAverage: execution.aggregate.nameQualityAverage,
    highConfidenceSymbolsAverage: execution.aggregate.highConfidenceSymbolsAverage,
    mappedSymbolsAverage: execution.aggregate.mappedSymbolsAverage,
    classCoverageAverage: execution.aggregate.classCoverageAverage,
    functionCoverageAverage: execution.aggregate.functionCoverageAverage,
    functionClassCoverageAverage: execution.aggregate.functionClassCoverageAverage,
    variableCoverageAverage: execution.aggregate.variableCoverageAverage,
    worstFileDecileScoreAverage: execution.aggregate.worstFileDecileScoreAverage,
    lowQualityFileCountAverage: execution.aggregate.lowQualityFileCountAverage,
    rerenderedModuleAverage: execution.aggregate.rerenderedModuleAverage,
    hotChunkAverage: execution.aggregate.hotChunkAverage,
    promotionSelectedCount: promotion.selectedCount,
    promotionUpdatedCount: promotion.updatedEntryCount,
    promotionInsertedCount: promotion.insertedEntryCount,
    promotionAverageQuality: promotion.averageSelectedQuality,
    qualityDeltaFromPrevious: qualityDelta,
    highConfidenceDeltaFromPrevious: highConfidenceDelta,
    fileQualityDeltaFromPrevious: fileQualityDelta,
    fileQualityBaselineGuardPassed,
    stagnationStrike: strike,
    adaptiveWeightsProfileCount: adaptiveWeights.profileCount,
    adaptiveWeightsReportPath: adaptiveWeights.reportPath,
    kpiPassed: kpiViolations.length === 0,
    kpiViolations,
  };
}

function finalizeManualRefactorCandidate(source: ManualRefactorAccumulator): ManualRefactorCandidate {
  const count = source.sampleCount;
  if (count < 1) {
    throw new Error(`manual-refactor: invalid sample count for ${source.filePath}`);
  }
  return {
    filePath: source.filePath,
    averageScore: Number((source.scoreSum / count).toFixed(4)),
    minScore: Number(source.minScore.toFixed(4)),
    averageNameQuality: Number((source.averageNameQualitySum / count).toFixed(4)),
    averageConfidence: Number((source.averageConfidenceSum / count).toFixed(4)),
    averageLiftedCoverage: Number((source.liftedCoverageSum / count).toFixed(4)),
    averageSymbolCount: Number((source.symbolCountSum / count).toFixed(2)),
    rerenderedHits: source.rerenderedHits,
    profiles: [...source.profiles].sort((left, right) => left.localeCompare(right)),
    moduleIds: [...source.moduleIds].sort((left, right) => left.localeCompare(right)),
    stableProjects: [...source.stableProjects].sort((left, right) => left.localeCompare(right)),
  };
}

async function writeManualRefactorCandidates(
  execution: RegressionSuiteExecution,
  outputDirectory: string,
): Promise<string> {
  const candidateByFilePath = new Map<string, ManualRefactorAccumulator>();

  for (const profileExecution of execution.profiles) {
    for (const issue of profileExecution.fileQuality.worstFiles) {
      const existing = candidateByFilePath.get(issue.filePath);
      if (existing) {
        existing.scoreSum += issue.score;
        existing.minScore = Math.min(existing.minScore, issue.score);
        existing.averageNameQualitySum += issue.averageNameQuality;
        existing.averageConfidenceSum += issue.averageConfidence;
        existing.liftedCoverageSum += issue.liftedCoverage;
        existing.symbolCountSum += issue.symbolCount;
        existing.sampleCount += 1;
        if (issue.rerendered) {
          existing.rerenderedHits += 1;
        }
        existing.profiles.add(profileExecution.profileId);
        existing.moduleIds.add(issue.moduleId);
        existing.stableProjects.add(profileExecution.fileQuality.stableProjectDirectory);
        continue;
      }

      candidateByFilePath.set(issue.filePath, {
        filePath: issue.filePath,
        scoreSum: issue.score,
        minScore: issue.score,
        averageNameQualitySum: issue.averageNameQuality,
        averageConfidenceSum: issue.averageConfidence,
        liftedCoverageSum: issue.liftedCoverage,
        symbolCountSum: issue.symbolCount,
        rerenderedHits: issue.rerendered ? 1 : 0,
        sampleCount: 1,
        profiles: new Set([profileExecution.profileId]),
        moduleIds: new Set([issue.moduleId]),
        stableProjects: new Set([profileExecution.fileQuality.stableProjectDirectory]),
      });
    }
  }

  const candidates = [...candidateByFilePath.values()]
    .map((entry) => finalizeManualRefactorCandidate(entry))
    .sort((left, right) => {
      if (left.averageScore !== right.averageScore) {
        return left.averageScore - right.averageScore;
      }
      if (left.averageNameQuality !== right.averageNameQuality) {
        return left.averageNameQuality - right.averageNameQuality;
      }
      if (left.averageConfidence !== right.averageConfidence) {
        return left.averageConfidence - right.averageConfidence;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, 120);

  await ensureDirectory(outputDirectory);
  const reportPath = path.join(outputDirectory, "manual-refactor-candidates.json");
  await writeJsonFile(reportPath, {
    generatedAtIso: new Date().toISOString(),
    suiteRunId: execution.suiteRunId,
    candidateCount: candidates.length,
    candidates,
  });
  return reportPath;
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  await ensureDirectory(cli.outputRoot);
  await ensureDirectory(path.dirname(cli.baselinePath));

  const suite = await loadRegressionSuite(cli.suiteConfigPath);
  validateFixedRegressionProfiles(suite);
  const baseWeights = await loadToolWeights(cli.weightsConfigPath);
  const snapshotDigest = await hashFileSha256(cli.snapshotAsarPath);
  const snapshotKey = snapshotDigest.sha256.slice(0, 12);
  const namingMemoryProfile = await resolveNamingMemoryProfilePath(projectRoot, snapshotKey);

  const cycleSummaries: CycleExecutionSummary[] = [];
  let previousSummary: CycleExecutionSummary | undefined;
  let previousExecution: RegressionSuiteExecution | undefined;
  let lastExecution: RegressionSuiteExecution | undefined;
  let stopReason = "max_cycles_reached";
  const baseRunToken = buildRunId(cli.suiteRunPrefix);

  for (let cycleIndex = 1; cycleIndex <= cli.maxCycles; cycleIndex += 1) {
    const cycleRunId = `${baseRunToken}-c${String(cycleIndex).padStart(2, "0")}`;
    const adaptiveWeights = await createAdaptiveProfileWeights(
      cli.outputRoot,
      cycleRunId,
      suite,
      baseWeights,
      previousExecution,
    );

    const execution = await executeRegressionSuite({
      projectRoot,
      snapshotAsarPath: cli.snapshotAsarPath,
      suite,
      weightsConfigPath: cli.weightsConfigPath,
      profileWeightsConfigPathByProfileId: adaptiveWeights.weightsByProfileId,
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

    const previousStrike = previousSummary ? previousSummary.stagnationStrike : 0;
    const summary = summarizeCycle(
      cycleIndex,
      cycleRunId,
      execution,
      promotion,
      adaptiveWeights,
      previousSummary,
      cli.minQualityDelta,
      previousStrike,
    );
    cycleSummaries.push(summary);
    previousSummary = summary;
    previousExecution = execution;
    lastExecution = execution;

    await writeJsonFile(cli.baselinePath, execution);
    await cleanupKeepLastN(cli.outputRoot, cli.keepLastN);

    if (!summary.kpiPassed) {
      stopReason = `kpi_failed:c${String(cycleIndex).padStart(2, "0")}`;
      break;
    }
    if (summary.stagnationStrike >= cli.stagnationLimit) {
      stopReason = `stagnation_limit_reached:${cli.stagnationLimit}`;
      break;
    }
  }

  if (!lastExecution) {
    throw new Error("No regression cycle was executed");
  }

  const manualRefactorCandidatesPath = await writeManualRefactorCandidates(
    lastExecution,
    path.dirname(cli.baselinePath),
  );

  const report: CycleReport = {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    maxCycles: cli.maxCycles,
    stagnationLimit: cli.stagnationLimit,
    minQualityDelta: cli.minQualityDelta,
    promotionBudgetPerCycle: cli.promotionBudgetPerCycle,
    kpiTargets: {
      classCoverage: KPI_TARGET_CLASS_COVERAGE,
      functionCoverage: KPI_TARGET_FUNCTION_COVERAGE,
      functionClassCoverage: KPI_TARGET_FUNCTION_CLASS_COVERAGE,
      variableCoverage: KPI_TARGET_VARIABLE_COVERAGE,
      monotonicNameQuality: true,
      buildHealthAllGreen: true,
      devHealthAllGreen: true,
      fileQualityNoRegression: true,
      hotChunkMin: KPI_TARGET_HOT_CHUNK_MIN,
      hotChunkMax: KPI_TARGET_HOT_CHUNK_MAX,
      rerenderedModuleAverageMin: KPI_TARGET_RERENDERED_MODULE_AVERAGE_MIN,
    },
    completedCycles: cycleSummaries.length,
    stopReason,
    cycles: cycleSummaries,
    finalBaselinePath: cli.baselinePath,
    namingMemoryProfilePath: namingMemoryProfile.profilePath,
    manualRefactorCandidatesPath,
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
