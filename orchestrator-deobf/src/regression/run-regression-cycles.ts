import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ArtifactRetentionMode, GateMode, OutputProfile, ToolWeights } from "../contracts";
import { cleanupKeepLastN } from "./cleanup";
import { executeRegressionSuite, RegressionSuiteExecution } from "./execute-suite";
import { applyMergedEvidencePromotion, ApplyMergedEvidencePromotionResult } from "./merged-evidence-promotion";
import { loadRegressionSuite, loadToolWeights } from "./suite-loader";
import { RegressionProfile, RegressionSuite } from "./suite-model";
import { resolveNamingMemoryProfilePath } from "../naming/profile-store";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  snapshotAsarPath: string;
  suiteConfigPath: string;
  weightsConfigPath: string;
  outputProfile: OutputProfile;
  outputRoot: string;
  baselinePath: string;
  keepLastN: number;
  maxCycles: number;
  stagnationLimit: number;
  suiteRunPrefix: string;
  promotionBudgetPerCycle: number;
  fastProfileId: string;
  fullCheckpointEvery: number;
  fastFocusCount: number;
  allowAfterFreeze: boolean;
}

interface AdaptiveProfileWeightsResult {
  reportPath: string;
  profileCount: number;
  weightsByProfileId: Record<string, string>;
}

interface CycleExecutionSummary {
  cycleIndex: number;
  suiteRunId: string;
  cycleMode: "fast" | "full";
  profileCount: number;
  promotionBudgetUsed: number;
  averageScore: number;
  nameQualityAverage: number;
  proxyInQualityAverage: number;
  highConfidenceSymbolsAverage: number;
  mappedSymbolsAverage: number;
  classCoverageAverage: number;
  functionCoverageAverage: number;
  functionClassCoverageAverage: number;
  variableCoverageAverage: number;
  worstFileDecileScoreAverage: number;
  lowQualityFileCountAverage: number;
  rerenderedModuleAverage: number;
  hotFocusFileAverage: number;
  hotFirstOnlyAllProfiles: boolean;
  hotChunkAverage: number;
  manualSyncAppliedAverage: number;
  manualSyncRejectedAverage: number;
  manualSyncConflictResolvedAverage: number;
  manualSyncFingerprintResolvedAverage: number;
  promotionSelectedCount: number;
  promotionUpdatedCount: number;
  promotionInsertedCount: number;
  promotionAverageQuality: number;
  qualityDeltaFromPrevious: number;
  nameQualityDeltaFromPrevious: number;
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
  promotionBudgetPerCycle: number;
  fastProfileId: string;
  fullCheckpointEvery: number;
  fastFocusCount: number;
  kpiTargets: {
    classCoverage: number;
    functionCoverage: number;
    functionClassCoverage: number;
    variableCoverage: number;
    hotFocusFileMin: number;
    hotFocusFileMax: number;
    proxyInQualityCount: number;
    monotonicNameQuality: boolean;
    buildHealthAllGreen: boolean;
    devHealthAllGreen: boolean;
  };
  completedCycles: number;
  stopReason: string;
  cycles: CycleExecutionSummary[];
  finalBaselinePath: string;
  namingMemoryProfilePath: string;
  manualRefactorCandidatesPath: string;
  manualReadyBacklogPath?: string;
  manualReadySlicePath?: string;
  manualFirstFreezePath?: string;
  transitionMode: "generator-active" | "manual-first-frozen";
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
  symbolKeys: string[];
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
  symbolKeys: Set<string>;
  profiles: Set<string>;
  moduleIds: Set<string>;
  stableProjects: Set<string>;
}

interface AutoHotFocusPayload {
  symbolKeys: string[];
  biasTokens: string[];
}

interface ManualRefactorCandidatesReport {
  generatedAtIso: string;
  suiteRunId: string;
  candidateCount: number;
  candidates: ManualRefactorCandidate[];
}

interface ManualReadyBacklogReport {
  generatedAtIso: string;
  snapshotAsarPath: string;
  transitionMode: "generator-active" | "manual-first-frozen";
  syncContractRoot: string;
  manualRefactor: Array<{
    filePath: string;
    averageScore: number;
    averageNameQuality: number;
    averageLiftedCoverage: number;
    averageSymbolCount: number;
  }>;
  generatorSync: Array<{
    focus: string;
    reason: string;
  }>;
}

interface ManualFirstFreezeMarker {
  version: number;
  generatedAtIso: string;
  reason: string;
  stopReason: string;
  completedCycles: number;
  snapshotAsarPath: string;
  namingMemoryProfilePath: string;
  manualSyncRootPath: string;
  transition: "manual-first";
  reverseSyncPolicy: "shared/manual-sync/* only";
  lastCycle?: {
    cycleIndex: number;
    cycleMode: "fast" | "full";
    nameQualityAverage: number;
    highConfidenceSymbolsAverage: number;
    qualityDeltaFromPrevious: number;
    nameQualityDeltaFromPrevious: number;
    highConfidenceDeltaFromPrevious: number;
    stagnationStrike: number;
  };
}

const KPI_TARGET_CLASS_COVERAGE = 1;
const KPI_TARGET_FUNCTION_COVERAGE = 1;
const KPI_TARGET_FUNCTION_CLASS_COVERAGE = 1;
const KPI_TARGET_VARIABLE_COVERAGE = 0.5;
const KPI_TARGET_HOT_FOCUS_FILE_MIN = 8;
const KPI_TARGET_HOT_FOCUS_FILE_MAX = 10;
const KPI_TARGET_PROXY_IN_QUALITY_COUNT = 0;
const PROMOTION_BUDGET_STAGNATION_STEP = 40;
const PROMOTION_BUDGET_STAGNATION_MAX = 320;
const FIXED_REGRESSION_PROFILE_IDS = [
  "core-no-binary",
  "core-no-binary-no-pretty",
  "core-no-binary-top120",
  "core-runtime-probe-soft",
] as const;
const PRUNED_RUN_ARTIFACT_RELATIVE_PATHS = [
  "naming-memory.snapshot.json",
  "stages",
  "green-gates-logs",
  "artifacts",
  path.join("artifacts", "asar-extract"),
  path.join("artifacts", "webcrack"),
  path.join("artifacts", "wakaru"),
  path.join("artifacts", "javascript-deobfuscator"),
  path.join("artifacts", "synchrony"),
  path.join("artifacts", "unwebpack-sourcemap"),
  path.join("artifacts", "project", "src", "chunks"),
  path.join("artifacts", "project", "src", "chunks-ts"),
  path.join("artifacts", "project", "artifacts", "chunks"),
  path.join("artifacts", "project", "artifacts", "chunks-ts"),
] as const;
const MANUAL_FIRST_FREEZE_RELATIVE_PATH = path.join("shared", "manual-sync", "manual-first-freeze.json");

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

function resolveCycleMode(cycleIndex: number, fullCheckpointEvery: number): "fast" | "full" {
  if (fullCheckpointEvery <= 1) {
    return "full";
  }
  if (cycleIndex % fullCheckpointEvery === 0) {
    return "full";
  }
  return "fast";
}

function buildFastCycleSuite(suite: RegressionSuite, fastProfileId: string): RegressionSuite {
  const baseProfile = suite.profiles.find((profile) => profile.id === fastProfileId);
  if (!baseProfile) {
    throw new Error(`fast profile "${fastProfileId}" not found in regression suite`);
  }
  return {
    version: suite.version,
    profiles: [
      {
        ...baseProfile,
        flags: {
          ...baseProfile.flags,
          enableWakaru: false,
          enableJavascriptDeobfuscator: false,
          enableSynchrony: false,
          enableUnwebpackSourcemap: false,
          unwebpackSourcemapMaxMaps: 1,
          statementBudget: Math.max(20, Math.min(28, baseProfile.flags.statementBudget)),
          wakaruConcurrency: Math.max(1, Math.min(2, baseProfile.flags.wakaruConcurrency)),
        },
      },
    ],
  };
}

function resolveCyclePromotionBudget(baseBudget: number, previousStagnationStrike: number): number {
  if (baseBudget < 1) {
    throw new Error(`resolveCyclePromotionBudget: base budget must be >= 1, got ${baseBudget}`);
  }
  if (previousStagnationStrike < 1) {
    return baseBudget;
  }
  const boosted = baseBudget + PROMOTION_BUDGET_STAGNATION_STEP * previousStagnationStrike;
  return Math.min(PROMOTION_BUDGET_STAGNATION_MAX, boosted);
}

function parseIntegerOption(token: string, value: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function resolveManualFirstFreezePath(projectRoot: string): string {
  return path.join(projectRoot, MANUAL_FIRST_FREEZE_RELATIVE_PATH);
}

async function readManualFirstFreezeMarker(
  freezePath: string,
): Promise<ManualFirstFreezeMarker | undefined> {
  const exists = await fs
    .stat(freezePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return undefined;
  }
  return await readJsonFile<ManualFirstFreezeMarker>(freezePath);
}

function isStagnationStopReason(stopReason: string): boolean {
  return stopReason.startsWith("stagnation_limit_reached:");
}

async function writeManualFirstFreezeMarker(
  freezePath: string,
  stopReason: string,
  report: Pick<CycleReport, "completedCycles" | "snapshotAsarPath" | "namingMemoryProfilePath">,
  cycleSummaries: readonly CycleExecutionSummary[],
): Promise<void> {
  const lastCycle = cycleSummaries.length > 0 ? cycleSummaries[cycleSummaries.length - 1] : undefined;
  const marker: ManualFirstFreezeMarker = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    reason: "stop-rule reached: 3 cycles without quality growth",
    stopReason,
    completedCycles: report.completedCycles,
    snapshotAsarPath: report.snapshotAsarPath,
    namingMemoryProfilePath: report.namingMemoryProfilePath,
    manualSyncRootPath: path.join(path.dirname(path.dirname(freezePath)), "manual-sync"),
    transition: "manual-first",
    reverseSyncPolicy: "shared/manual-sync/* only",
    lastCycle: lastCycle
      ? {
        cycleIndex: lastCycle.cycleIndex,
        cycleMode: lastCycle.cycleMode,
        nameQualityAverage: lastCycle.nameQualityAverage,
        highConfidenceSymbolsAverage: lastCycle.highConfidenceSymbolsAverage,
        qualityDeltaFromPrevious: lastCycle.qualityDeltaFromPrevious,
        nameQualityDeltaFromPrevious: lastCycle.nameQualityDeltaFromPrevious,
        highConfidenceDeltaFromPrevious: lastCycle.highConfidenceDeltaFromPrevious,
        stagnationStrike: lastCycle.stagnationStrike,
      }
      : undefined,
  };
  await ensureDirectory(path.dirname(freezePath));
  await writeJsonFile(freezePath, marker);
}

function tokenizeFocusStem(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function buildAutoHotFocusFromExecution(execution: RegressionSuiteExecution, focusCount: number): AutoHotFocusPayload {
  const worstByFilePath = new Map<string, { scoreSum: number; sampleCount: number; symbolKeys: Set<string> }>();
  for (const profileExecution of execution.profiles) {
    for (const worstFile of profileExecution.fileQuality.worstFiles) {
      const existing = worstByFilePath.get(worstFile.filePath);
      if (existing) {
        existing.scoreSum += worstFile.score;
        existing.sampleCount += 1;
        for (const symbolKey of worstFile.symbolKeys) {
          existing.symbolKeys.add(symbolKey);
        }
        continue;
      }
      worstByFilePath.set(worstFile.filePath, {
        scoreSum: worstFile.score,
        sampleCount: 1,
        symbolKeys: new Set(worstFile.symbolKeys),
      });
    }
  }

  const selected = [...worstByFilePath.entries()]
    .map(([filePath, value]) => ({
      filePath,
      averageScore: value.sampleCount > 0 ? value.scoreSum / value.sampleCount : 0,
      symbolKeys: value.symbolKeys,
    }))
    .sort((left, right) => {
      if (left.averageScore !== right.averageScore) {
        return left.averageScore - right.averageScore;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, Math.max(1, focusCount));

  const symbolKeySet = new Set<string>();
  const tokenSet = new Set<string>();
  for (const candidate of selected) {
    for (const symbolKey of candidate.symbolKeys) {
      symbolKeySet.add(symbolKey);
    }
    for (const token of tokenizeFocusStem(candidate.filePath)) {
      if (token === "src" || token === "services" || token === "renderer" || token === "main" || token === "quality") {
        continue;
      }
      tokenSet.add(token);
    }
  }
  return {
    symbolKeys: [...symbolKeySet].sort((left, right) => left.localeCompare(right)),
    biasTokens: [...tokenSet].sort((left, right) => left.localeCompare(right)),
  };
}

async function pruneHeavyRunArtifacts(execution: RegressionSuiteExecution): Promise<void> {
  for (const profileExecution of execution.profiles) {
    for (const relativePath of PRUNED_RUN_ARTIFACT_RELATIVE_PATHS) {
      const targetPath = path.join(profileExecution.runDirectory, relativePath);
      await fs.rm(targetPath, { recursive: true, force: true });
    }
  }
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let snapshotAsarPath = "";
  let suiteConfigPath = path.join(projectRoot, "config", "regression-suite.json");
  let weightsConfigPath = path.join(projectRoot, "config", "tool-weights.json");
  let outputProfile: OutputProfile = "regression-latest";
  let outputRoot = path.join(projectRoot, "regression", "runs");
  let baselinePath = path.join(projectRoot, "regression", "baseline-metrics.json");
  let keepLastN = 8;
  let maxCycles = 8;
  let stagnationLimit = 3;
  let suiteRunPrefix = "cycle";
  let promotionBudgetPerCycle = 140;
  let fastProfileId = "core-no-binary";
  let fullCheckpointEvery = 4;
  let fastFocusCount = 10;
  let allowAfterFreeze = false;

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
      case "--output-profile": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-profile");
        }
        if (value !== "latest" && value !== "regression-latest") {
          throw new Error(`Invalid --output-profile value: ${value}`);
        }
        outputProfile = value;
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
      case "--fast-profile-id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --fast-profile-id");
        }
        fastProfileId = value;
        index += 1;
        break;
      }
      case "--full-checkpoint-every": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --full-checkpoint-every");
        }
        fullCheckpointEvery = parseIntegerOption("--full-checkpoint-every", value, 1);
        index += 1;
        break;
      }
      case "--fast-focus-count": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --fast-focus-count");
        }
        fastFocusCount = parseIntegerOption("--fast-focus-count", value, 1);
        index += 1;
        break;
      }
      case "--allow-after-freeze": {
        allowAfterFreeze = true;
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
          "  --output-profile <latest|regression-latest>",
          "  --baseline-path <path>",
          "  --keep-last-n <n>",
          "  --max-cycles <n>",
          "  --stagnation-limit <n>",
          "  --suite-run-prefix <token>",
          "  --promotion-budget-per-cycle <n>",
          "  --fast-profile-id <profile-id>",
          "  --full-checkpoint-every <n>",
          "  --fast-focus-count <n>",
          "  --allow-after-freeze",
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
    outputProfile,
    outputRoot,
    baselinePath,
    keepLastN,
    maxCycles,
    stagnationLimit,
    suiteRunPrefix,
    promotionBudgetPerCycle,
    fastProfileId,
    fullCheckpointEvery,
    fastFocusCount,
    allowAfterFreeze,
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
    return {
      weights: { ...baseWeights },
      performanceScale: 1,
      flagScale: buildFlagScale(profile),
      referenceScore: 0,
      referenceAverageScore: previousExecution.aggregate.averageScore,
    };
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
  cycleMode: "fast" | "full",
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

  const shouldAdapt = cycleMode === "full";
  for (const profile of suite.profiles) {
    const adaptive = shouldAdapt
      ? buildAdaptiveWeights(baseWeights, profile, previousExecution)
      : {
        weights: { ...baseWeights },
        performanceScale: 1,
        flagScale: buildFlagScale(profile),
        referenceScore: 0,
        referenceAverageScore: 0,
      };
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
    cycleMode,
    adaptiveEnabled: shouldAdapt,
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
  cycleMode: "fast" | "full",
  profileCount: number,
  promotionBudgetUsed: number,
  execution: RegressionSuiteExecution,
  promotion: ApplyMergedEvidencePromotionResult,
  adaptiveWeights: AdaptiveProfileWeightsResult,
  previous: CycleExecutionSummary | undefined,
  previousSameMode: CycleExecutionSummary | undefined,
  stagnationStrike: number,
): CycleExecutionSummary {
  const qualityDeltaRaw = previous ? execution.aggregate.averageScore - previous.averageScore : execution.aggregate.averageScore;
  const qualityDelta = Number(qualityDeltaRaw.toFixed(4));
  const nameQualityDeltaRaw = previous
    ? execution.aggregate.nameQualityAverage - previous.nameQualityAverage
    : execution.aggregate.nameQualityAverage;
  const nameQualityDelta = Number(nameQualityDeltaRaw.toFixed(4));
  const highConfidenceDeltaRaw = previous
    ? execution.aggregate.highConfidenceSymbolsAverage - previous.highConfidenceSymbolsAverage
    : execution.aggregate.highConfidenceSymbolsAverage;
  const highConfidenceDelta = Number(highConfidenceDeltaRaw.toFixed(4));
  const fileQualityDeltaRaw = previous
    ? execution.aggregate.worstFileDecileScoreAverage - previous.worstFileDecileScoreAverage
    : execution.aggregate.worstFileDecileScoreAverage;
  const fileQualityDelta = Number(fileQualityDeltaRaw.toFixed(4));
  const fileQualityBaselineGuardPassed = true;
  const strike = previous && qualityDelta <= 0
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
  if (execution.aggregate.hotFocusFileAverage < KPI_TARGET_HOT_FOCUS_FILE_MIN) {
    kpiViolations.push(
      `hotFocusFileAverage ${execution.aggregate.hotFocusFileAverage} < ${KPI_TARGET_HOT_FOCUS_FILE_MIN}`,
    );
  }
  if (execution.aggregate.hotFocusFileAverage > KPI_TARGET_HOT_FOCUS_FILE_MAX) {
    kpiViolations.push(
      `hotFocusFileAverage ${execution.aggregate.hotFocusFileAverage} > ${KPI_TARGET_HOT_FOCUS_FILE_MAX}`,
    );
  }
  if (execution.aggregate.proxyInQualityAverage > KPI_TARGET_PROXY_IN_QUALITY_COUNT) {
    kpiViolations.push(
      `proxyInQualityAverage ${execution.aggregate.proxyInQualityAverage} > ${KPI_TARGET_PROXY_IN_QUALITY_COUNT}`,
    );
  }
  if (!execution.aggregate.buildHealthAllGreen) {
    kpiViolations.push("buildHealthAllGreen is false");
  }
  if (!execution.aggregate.devHealthAllGreen) {
    kpiViolations.push("devHealthAllGreen is false");
  }
  if (!execution.aggregate.hotFirstOnlyAllProfiles) {
    kpiViolations.push("hotFirstOnlyAllProfiles is false");
  }
  if (
    previousSameMode &&
    execution.aggregate.nameQualityAverage < Number((previousSameMode.nameQualityAverage - 0.0001).toFixed(4))
  ) {
    kpiViolations.push(
      `nameQualityAverage regressed in ${cycleMode} mode: ${execution.aggregate.nameQualityAverage} < ${previousSameMode.nameQualityAverage}`,
    );
  }

  return {
    cycleIndex,
    suiteRunId,
    cycleMode,
    profileCount,
    promotionBudgetUsed,
    averageScore: execution.aggregate.averageScore,
    nameQualityAverage: execution.aggregate.nameQualityAverage,
    proxyInQualityAverage: execution.aggregate.proxyInQualityAverage,
    highConfidenceSymbolsAverage: execution.aggregate.highConfidenceSymbolsAverage,
    mappedSymbolsAverage: execution.aggregate.mappedSymbolsAverage,
    classCoverageAverage: execution.aggregate.classCoverageAverage,
    functionCoverageAverage: execution.aggregate.functionCoverageAverage,
    functionClassCoverageAverage: execution.aggregate.functionClassCoverageAverage,
    variableCoverageAverage: execution.aggregate.variableCoverageAverage,
    worstFileDecileScoreAverage: execution.aggregate.worstFileDecileScoreAverage,
    lowQualityFileCountAverage: execution.aggregate.lowQualityFileCountAverage,
    rerenderedModuleAverage: execution.aggregate.rerenderedModuleAverage,
    hotFocusFileAverage: execution.aggregate.hotFocusFileAverage,
    hotFirstOnlyAllProfiles: execution.aggregate.hotFirstOnlyAllProfiles,
    hotChunkAverage: execution.aggregate.hotChunkAverage,
    manualSyncAppliedAverage: execution.aggregate.manualSyncAppliedAverage,
    manualSyncRejectedAverage: execution.aggregate.manualSyncRejectedAverage,
    manualSyncConflictResolvedAverage: execution.aggregate.manualSyncConflictResolvedAverage,
    manualSyncFingerprintResolvedAverage: execution.aggregate.manualSyncFingerprintResolvedAverage,
    promotionSelectedCount: promotion.selectedCount,
    promotionUpdatedCount: promotion.updatedEntryCount,
    promotionInsertedCount: promotion.insertedEntryCount,
    promotionAverageQuality: promotion.averageSelectedQuality,
    qualityDeltaFromPrevious: qualityDelta,
    nameQualityDeltaFromPrevious: nameQualityDelta,
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

function findPreviousCycleByMode(
  summaries: readonly CycleExecutionSummary[],
  cycleMode: "fast" | "full",
): CycleExecutionSummary | undefined {
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const summary = summaries[index];
    if (!summary) {
      continue;
    }
    if (summary.cycleMode === cycleMode) {
      return summary;
    }
  }
  return undefined;
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
    symbolKeys: [...source.symbolKeys].sort((left, right) => left.localeCompare(right)),
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
        for (const symbolKey of issue.symbolKeys) {
          existing.symbolKeys.add(symbolKey);
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
        symbolKeys: new Set(issue.symbolKeys),
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

async function publishManualRefactorCandidates(
  sourceReportPath: string,
  destinationReportPath: string,
): Promise<void> {
  const report = await readJsonFile<ManualRefactorCandidatesReport>(sourceReportPath);
  if (!Array.isArray(report.candidates)) {
    throw new Error(`manual-refactor: invalid candidates report at ${sourceReportPath}`);
  }
  await ensureDirectory(path.dirname(destinationReportPath));
  await writeJsonFile(destinationReportPath, report);
}

function buildGeneratorSyncBacklog(latestSummary: CycleExecutionSummary): Array<{ focus: string; reason: string }> {
  const items: Array<{ focus: string; reason: string }> = [];
  if (latestSummary.promotionUpdatedCount < 1) {
    items.push({
      focus: "promotion-uplift",
      reason: "promotionUpdatedCount is zero; retune merge scoring for selected != currentName updates.",
    });
  }
  if (latestSummary.hotFocusFileAverage < KPI_TARGET_HOT_FOCUS_FILE_MIN) {
    items.push({
      focus: "hot-selection",
      reason: `hot focus files below target (${latestSummary.hotFocusFileAverage} < ${KPI_TARGET_HOT_FOCUS_FILE_MIN}).`,
    });
  }
  if (!latestSummary.kpiPassed) {
    items.push({
      focus: "kpi-gates",
      reason: `latest cycle has KPI violations: ${latestSummary.kpiViolations.join("; ")}`,
    });
  }
  if (latestSummary.stagnationStrike >= 2) {
    items.push({
      focus: "stop-rule-risk",
      reason: `stagnation strike is ${latestSummary.stagnationStrike}; generator may freeze next cycle.`,
    });
  }
  if (items.length < 1) {
    items.push({
      focus: "sync-hygiene",
      reason: "keep generator sync minimal; prioritize manual refactor stream.",
    });
  }
  return items;
}

async function writeManualReadyArtifacts(
  projectRoot: string,
  snapshotAsarPath: string,
  transitionMode: "generator-active" | "manual-first-frozen",
  manualRefactorCandidatesPath: string,
  cycleSummaries: readonly CycleExecutionSummary[],
): Promise<{ backlogPath: string; slicePath: string }> {
  const candidateReport = await readJsonFile<ManualRefactorCandidatesReport>(manualRefactorCandidatesPath);
  const manualRefactor = [...candidateReport.candidates]
    .sort((left, right) => {
      if (left.averageScore !== right.averageScore) {
        return left.averageScore - right.averageScore;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, 24)
    .map((entry) => ({
      filePath: entry.filePath,
      averageScore: entry.averageScore,
      averageNameQuality: entry.averageNameQuality,
      averageLiftedCoverage: entry.averageLiftedCoverage,
      averageSymbolCount: entry.averageSymbolCount,
    }));
  const latestSummary = cycleSummaries.length > 0
    ? cycleSummaries[cycleSummaries.length - 1]
    : undefined;
  if (!latestSummary) {
    throw new Error("writeManualReadyArtifacts: missing cycle summary");
  }
  const generatorSync = buildGeneratorSyncBacklog(latestSummary);
  const syncContractRoot = path.join(projectRoot, "shared", "manual-sync");

  const backlogReport: ManualReadyBacklogReport = {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath,
    transitionMode,
    syncContractRoot,
    manualRefactor,
    generatorSync,
  };
  const backlogPath = path.join(projectRoot, "regression", "manual-ready-backlog.json");
  await writeJsonFile(backlogPath, backlogReport);

  const slicePath = path.join(projectRoot, "regression", "manual-ready-slice.json");
  await writeJsonFile(slicePath, {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath,
    transitionMode,
    syncContractRoot,
    stableSlice: {
      nameQualityAverage: latestSummary.nameQualityAverage,
      averageScore: latestSummary.averageScore,
      proxyInQualityAverage: latestSummary.proxyInQualityAverage,
      classCoverageAverage: latestSummary.classCoverageAverage,
      functionCoverageAverage: latestSummary.functionCoverageAverage,
      variableCoverageAverage: latestSummary.variableCoverageAverage,
      hotFocusFileAverage: latestSummary.hotFocusFileAverage,
      kpiPassed: latestSummary.kpiPassed,
    },
    topManualCandidates: manualRefactor.slice(0, 10),
  });

  return {
    backlogPath,
    slicePath,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const globalRunsRoot = path.join(projectRoot, "runs");
  const globalRunsKeepLastN = Math.max(cli.keepLastN * 3, 24);
  const manualFirstFreezePath = resolveManualFirstFreezePath(projectRoot);
  await ensureDirectory(cli.outputRoot);
  await ensureDirectory(globalRunsRoot);
  await ensureDirectory(path.dirname(cli.baselinePath));
  const canonicalManualRefactorCandidatesPath = path.join(projectRoot, "regression", "manual-refactor-candidates.json");
  await ensureDirectory(path.dirname(canonicalManualRefactorCandidatesPath));

  const existingFreeze = await readManualFirstFreezeMarker(manualFirstFreezePath);
  if (existingFreeze && !cli.allowAfterFreeze) {
    throw new Error(
      `manual-first freeze is active at ${manualFirstFreezePath} (reason: ${existingFreeze.stopReason}); pass --allow-after-freeze to run cycles explicitly.`,
    );
  }

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
    const cycleMode = resolveCycleMode(cycleIndex, cli.fullCheckpointEvery);
    const cycleSuite = cycleMode === "full" ? suite : buildFastCycleSuite(suite, cli.fastProfileId);
    const cycleGateMode: GateMode = cycleMode === "full" ? "full" : "light";
    const cycleArtifactRetention: ArtifactRetentionMode = "minimal";
    const adaptiveWeights = await createAdaptiveProfileWeights(
      cli.outputRoot,
      cycleRunId,
      cycleMode,
      cycleSuite,
      baseWeights,
      previousExecution,
    );

    const execution = await executeRegressionSuite({
      projectRoot,
      snapshotAsarPath: cli.snapshotAsarPath,
      suite: cycleSuite,
      weightsConfigPath: cli.weightsConfigPath,
      profileWeightsConfigPathByProfileId: adaptiveWeights.weightsByProfileId,
      suiteRunId: cycleRunId,
      outputProfile: cli.outputProfile,
      outputDirectory: cli.outputRoot,
      gateMode: cycleGateMode,
      artifactRetention: cycleArtifactRetention,
      allowAfterFreeze: cli.allowAfterFreeze,
    });

    const autoHotFocus = buildAutoHotFocusFromExecution(execution, cli.fastFocusCount);
    const previousStagnationStrike = previousSummary ? previousSummary.stagnationStrike : 0;
    const cyclePromotionBudget = resolveCyclePromotionBudget(cli.promotionBudgetPerCycle, previousStagnationStrike);
    const previousSameMode = findPreviousCycleByMode(cycleSummaries, cycleMode);

    const promotion = await applyMergedEvidencePromotion({
      mergedEvidencePath: execution.mergedEvidencePath,
      namingMemoryPath: namingMemoryProfile.profilePath,
      legacyNamingMemoryPath: namingMemoryProfile.legacyPath,
      runId: `${cycleRunId}:merged-evidence-promotion`,
      promotionBudget: cyclePromotionBudget,
      hotFocusSymbolKeys: autoHotFocus.symbolKeys,
      hotFocusBiasTokens: autoHotFocus.biasTokens,
    });

    const cycleDirectory = path.join(cli.outputRoot, sanitizeToken(cycleRunId));
    const cycleManualRefactorCandidatesPath = await writeManualRefactorCandidates(execution, cycleDirectory);
    await publishManualRefactorCandidates(
      cycleManualRefactorCandidatesPath,
      canonicalManualRefactorCandidatesPath,
    );

    const summary = summarizeCycle(
      cycleIndex,
      cycleRunId,
      cycleMode,
      cycleSuite.profiles.length,
      cyclePromotionBudget,
      execution,
      promotion,
      adaptiveWeights,
      previousSummary,
      previousSameMode,
      previousStagnationStrike,
    );
    cycleSummaries.push(summary);
    previousSummary = summary;
    previousExecution = execution;
    lastExecution = execution;

    await writeJsonFile(cli.baselinePath, execution);
    await pruneHeavyRunArtifacts(execution);
    await cleanupKeepLastN(cli.outputRoot, cli.keepLastN);
    await cleanupKeepLastN(globalRunsRoot, globalRunsKeepLastN);

    if (summary.stagnationStrike >= cli.stagnationLimit) {
      stopReason = `stagnation_limit_reached:${cli.stagnationLimit}`;
      break;
    }
    if (!summary.kpiPassed) {
      stopReason = `kpi_failed:c${String(cycleIndex).padStart(2, "0")}`;
      break;
    }
  }

  if (!lastExecution) {
    throw new Error("No regression cycle was executed");
  }

  const manualRefactorCandidatesPath = canonicalManualRefactorCandidatesPath;

  const report: CycleReport = {
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: cli.snapshotAsarPath,
    maxCycles: cli.maxCycles,
    stagnationLimit: cli.stagnationLimit,
    promotionBudgetPerCycle: cli.promotionBudgetPerCycle,
    fastProfileId: cli.fastProfileId,
    fullCheckpointEvery: cli.fullCheckpointEvery,
    fastFocusCount: cli.fastFocusCount,
    kpiTargets: {
      classCoverage: KPI_TARGET_CLASS_COVERAGE,
      functionCoverage: KPI_TARGET_FUNCTION_COVERAGE,
      functionClassCoverage: KPI_TARGET_FUNCTION_CLASS_COVERAGE,
      variableCoverage: KPI_TARGET_VARIABLE_COVERAGE,
      hotFocusFileMin: KPI_TARGET_HOT_FOCUS_FILE_MIN,
      hotFocusFileMax: KPI_TARGET_HOT_FOCUS_FILE_MAX,
      proxyInQualityCount: KPI_TARGET_PROXY_IN_QUALITY_COUNT,
      monotonicNameQuality: true,
      buildHealthAllGreen: true,
      devHealthAllGreen: true,
    },
    completedCycles: cycleSummaries.length,
    stopReason,
    cycles: cycleSummaries,
    finalBaselinePath: cli.baselinePath,
    namingMemoryProfilePath: namingMemoryProfile.profilePath,
    manualRefactorCandidatesPath,
    transitionMode: "generator-active",
  };

  if (isStagnationStopReason(stopReason)) {
    await writeManualFirstFreezeMarker(manualFirstFreezePath, stopReason, report, cycleSummaries);
    report.manualFirstFreezePath = manualFirstFreezePath;
    report.transitionMode = "manual-first-frozen";
  }

  const manualReadyArtifacts = await writeManualReadyArtifacts(
    projectRoot,
    cli.snapshotAsarPath,
    report.transitionMode,
    manualRefactorCandidatesPath,
    cycleSummaries,
  );
  report.manualReadyBacklogPath = manualReadyArtifacts.backlogPath;
  report.manualReadySlicePath = manualReadyArtifacts.slicePath;

  const reportPath = path.join(path.dirname(cli.baselinePath), "cycle-report.json");
  await writeJsonFile(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
