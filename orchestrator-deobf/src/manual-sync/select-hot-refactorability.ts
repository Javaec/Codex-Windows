import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";

interface ManualHotFunctionCandidate {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

interface ManualHotFileMetrics {
  lineCount: number;
  namespaceImportCount: number;
  runtimeVendorImportCount: number;
  importCount: number;
  longFunctionCandidates: ManualHotFunctionCandidate[];
  boundaryTokenCounts: Record<string, number>;
}

interface ManualHotRescueTargetModel {
  rank: number;
  sourceFilePath: string;
  manualFilePath: string;
  mappedBy: "exact" | "normalized" | "fallback";
  averageScore: number;
  moduleIds: string[];
  exists: boolean;
  metrics?: ManualHotFileMetrics;
  recommendedActions: string[];
  violations: string[];
}

interface ManualHotRescueReportModel {
  generatedAtIso: string;
  manualProjectPath: string;
  targets: ManualHotRescueTargetModel[];
}

interface RefactorReportFile {
  filePath: string;
}

interface ManualTopHotRefactorReportModel {
  generatedAtIso: string;
  reportPath: string;
  topUnique: number;
  targetCount: number;
  changedCount: number;
  unchangedCount: number;
  files: RefactorReportFile[];
}

interface RefactorabilityPolicyModel {
  version: number;
  topUnique: number;
  noOpThreshold: number;
  minRefactorability: number;
  qualityWeight: number;
  refactorabilityWeight: number;
  excludePathPatterns: string[];
  priorityFiles: string[];
}

interface RefactorabilityStateModel {
  version: number;
  generatedAtIso: string;
  lastAppliedRefactorReportGeneratedAtIso: string;
  consecutiveNoOpByFile: Record<string, number>;
}

interface SelectionCandidateBreakdown {
  filePath: string;
  averageScore: number;
  qualityScore: number;
  refactorabilityScore: number;
  compositeScore: number;
  noOpCount: number;
  noOpExcluded: boolean;
  priorityBoostApplied: boolean;
  reason: string[];
}

interface SelectionReportTarget {
  rank: number;
  manualFilePath: string;
  sourceFilePath: string;
  exists: boolean;
  mappedBy: "exact" | "normalized" | "fallback";
  averageScore: number;
  moduleIds: string[];
  recommendedActions: string[];
  violations: string[];
}

interface RefactorabilitySelectionReportModel {
  generatedAtIso: string;
  strategy: "refactorability-first";
  sourceHotRescueReportPath: string;
  sourceRefactorReportPath: string;
  statePath: string;
  policyPath: string;
  topUnique: number;
  selectedCount: number;
  excludedNoOpCount: number;
  targets: SelectionReportTarget[];
  candidates: SelectionCandidateBreakdown[];
}

interface CliOptions {
  hotRescueReportPath: string;
  refactorReportPath: string;
  statePath: string;
  policyPath: string;
  outputPath: string;
}

const DEFAULT_POLICY: RefactorabilityPolicyModel = {
  version: 1,
  topUnique: 5,
  noOpThreshold: 2,
  minRefactorability: 0.4,
  qualityWeight: 0.55,
  refactorabilityWeight: 0.45,
  excludePathPatterns: [
    "src/renderer/features/store/store-path-quality-",
    "src/main/lib/transport/transport-bridge-quality-",
    "src/main/lib/transport/transport-bridge.ts",
  ],
  priorityFiles: [
    "src/services/store/store-state-quality-01.ts",
    "src/services/store/store-state-g002-quality-01.ts",
    "src/services/store/store-state-quality-02.ts",
  ],
};

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let hotRescueReportPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-hot-rescue-before.json");
  let refactorReportPath = path.resolve(projectRoot, "shared", "manual-sync", "manual-top-hot-refactor-last-report.json");
  let statePath = path.resolve(projectRoot, "shared", "manual-sync", "refactorability-state.json");
  let policyPath = path.resolve(projectRoot, "config", "manual-refactorability-policy.json");
  let outputPath = path.resolve(projectRoot, "shared", "manual-sync", "refactorability-top5-report.json");
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--hot-rescue-report": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--hot-rescue-report requires a value");
        }
        hotRescueReportPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--refactor-report": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--refactor-report requires a value");
        }
        refactorReportPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--state": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--state requires a value");
        }
        statePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--policy": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--policy requires a value");
        }
        policyPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--output requires a value");
        }
        outputPath = path.resolve(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }
  return {
    hotRescueReportPath,
    refactorReportPath,
    statePath,
    policyPath,
    outputPath,
  };
}

function toDefaultState(): RefactorabilityStateModel {
  return {
    version: 1,
    generatedAtIso: "",
    lastAppliedRefactorReportGeneratedAtIso: "",
    consecutiveNoOpByFile: {},
  };
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch {
    return null;
  }
}

async function resolvePolicy(policyPath: string): Promise<RefactorabilityPolicyModel> {
  const maybePolicy = await readOptionalJson<Partial<RefactorabilityPolicyModel>>(policyPath);
  if (!maybePolicy) {
    return DEFAULT_POLICY;
  }
  const policy: RefactorabilityPolicyModel = {
    version: typeof maybePolicy.version === "number" ? maybePolicy.version : DEFAULT_POLICY.version,
    topUnique:
      typeof maybePolicy.topUnique === "number" && maybePolicy.topUnique > 0
        ? Math.trunc(maybePolicy.topUnique)
        : DEFAULT_POLICY.topUnique,
    noOpThreshold:
      typeof maybePolicy.noOpThreshold === "number" && maybePolicy.noOpThreshold > 0
        ? Math.trunc(maybePolicy.noOpThreshold)
        : DEFAULT_POLICY.noOpThreshold,
    minRefactorability:
      typeof maybePolicy.minRefactorability === "number"
        ? clamp01(maybePolicy.minRefactorability)
        : DEFAULT_POLICY.minRefactorability,
    qualityWeight:
      typeof maybePolicy.qualityWeight === "number" ? clamp01(maybePolicy.qualityWeight) : DEFAULT_POLICY.qualityWeight,
    refactorabilityWeight:
      typeof maybePolicy.refactorabilityWeight === "number"
        ? clamp01(maybePolicy.refactorabilityWeight)
        : DEFAULT_POLICY.refactorabilityWeight,
    excludePathPatterns: Array.isArray(maybePolicy.excludePathPatterns)
      ? maybePolicy.excludePathPatterns.map((value) => normalizeRelativePath(String(value)))
      : DEFAULT_POLICY.excludePathPatterns,
    priorityFiles: Array.isArray(maybePolicy.priorityFiles)
      ? maybePolicy.priorityFiles.map((value) => normalizeRelativePath(String(value)))
      : DEFAULT_POLICY.priorityFiles,
  };
  const weightSum = policy.qualityWeight + policy.refactorabilityWeight;
  if (weightSum <= 0) {
    throw new Error("Invalid policy weights: both qualityWeight and refactorabilityWeight are zero");
  }
  policy.qualityWeight = policy.qualityWeight / weightSum;
  policy.refactorabilityWeight = policy.refactorabilityWeight / weightSum;
  return policy;
}

async function resolveState(
  statePath: string,
  refactorReportPath: string,
): Promise<RefactorabilityStateModel> {
  const maybeState = await readOptionalJson<RefactorabilityStateModel>(statePath);
  const state = maybeState ?? toDefaultState();
  const maybeRefactorReport = await readOptionalJson<ManualTopHotRefactorReportModel>(refactorReportPath);
  if (!maybeRefactorReport) {
    return state;
  }
  if (maybeRefactorReport.generatedAtIso === state.lastAppliedRefactorReportGeneratedAtIso) {
    return state;
  }
  const reportTargetsModel = await readJsonFile<ManualHotRescueReportModel>(path.resolve(maybeRefactorReport.reportPath));
  const selectedTargets = Array.isArray(reportTargetsModel.targets)
    ? reportTargetsModel.targets
        .filter((target) => target.exists === true)
        .sort((left, right) => left.rank - right.rank)
        .slice(0, Math.max(1, maybeRefactorReport.topUnique))
    : [];
  const changedFiles = new Set(
    (Array.isArray(maybeRefactorReport.files) ? maybeRefactorReport.files : [])
      .map((entry) => normalizeRelativePath(entry.filePath)),
  );
  const nextNoOpMap: Record<string, number> = { ...state.consecutiveNoOpByFile };
  for (const target of selectedTargets) {
    const normalized = normalizeRelativePath(target.manualFilePath);
    if (changedFiles.has(normalized)) {
      nextNoOpMap[normalized] = 0;
      continue;
    }
    const previousNoOp = nextNoOpMap[normalized] ?? 0;
    nextNoOpMap[normalized] = previousNoOp + 1;
  }
  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    lastAppliedRefactorReportGeneratedAtIso: maybeRefactorReport.generatedAtIso,
    consecutiveNoOpByFile: nextNoOpMap,
  };
}

function scoreRefactorability(target: ManualHotRescueTargetModel): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const metrics = target.metrics;
  if (!metrics) {
    return {
      score: 0,
      reasons: ["missing-metrics"],
    };
  }
  let score = 0;
  const longFunctionCount = Array.isArray(metrics.longFunctionCandidates) ? metrics.longFunctionCandidates.length : 0;
  if (longFunctionCount > 0) {
    score += 0.28;
    reasons.push("long-functions");
  }
  const stateEventTokens = (metrics.boundaryTokenCounts.state ?? 0) + (metrics.boundaryTokenCounts.event ?? 0);
  if (stateEventTokens > 0) {
    score += Math.min(0.24, stateEventTokens / 80);
    reasons.push("state-event-boundary");
  }
  if (metrics.lineCount >= 900) {
    score += 0.22;
    reasons.push("large-module");
  } else {
    score += Math.min(0.22, metrics.lineCount / 9000);
  }
  const actionsText = target.recommendedActions.join(" | ").toLowerCase();
  if (actionsText.includes("behavior split")) {
    score += 0.2;
    reasons.push("behavior-split-action");
  }
  if (actionsText.includes("dependency-closure")) {
    score += 0.16;
    reasons.push("dependency-closure-action");
  }
  if (actionsText.includes("runtime/vendor quarantine") || metrics.runtimeVendorImportCount > 0) {
    score += 0.1;
    reasons.push("runtime-vendor-quarantine");
  }
  return {
    score: clamp01(score),
    reasons,
  };
}

function selectTargets(
  report: ManualHotRescueReportModel,
  state: RefactorabilityStateModel,
  policy: RefactorabilityPolicyModel,
): { selected: SelectionReportTarget[]; candidates: SelectionCandidateBreakdown[]; excludedNoOpCount: number } {
  const prioritySet = new Set(policy.priorityFiles.map((value) => normalizeRelativePath(value)));
  const sourceTargets = Array.isArray(report.targets) ? report.targets : [];
  const uniqueTargets = new Map<string, ManualHotRescueTargetModel>();
  for (const target of sourceTargets) {
    if (!target.exists) {
      continue;
    }
    const normalized = normalizeRelativePath(target.manualFilePath);
    if (uniqueTargets.has(normalized)) {
      continue;
    }
    uniqueTargets.set(normalized, {
      ...target,
      manualFilePath: normalized,
      sourceFilePath: normalizeRelativePath(target.sourceFilePath),
    });
  }
  const breakdown: SelectionCandidateBreakdown[] = [];
  let excludedNoOpCount = 0;
  for (const target of uniqueTargets.values()) {
    const normalized = target.manualFilePath;
    const noOpCount = state.consecutiveNoOpByFile[normalized] ?? 0;
    const noOpExcluded = noOpCount >= policy.noOpThreshold;
    const isPriority = prioritySet.has(normalized);
    const qualityScore = clamp01(1 - target.averageScore);
    const refactorability = scoreRefactorability(target);
    const explicitExcludedByPattern = policy.excludePathPatterns.some((pattern) => normalized.includes(pattern));
    const excluded = (noOpExcluded && !isPriority) || (explicitExcludedByPattern && !isPriority);
    if (noOpExcluded && !isPriority) {
      excludedNoOpCount += 1;
    }
    const priorityBoost = isPriority ? 0.12 : 0;
    const compositeScore =
      qualityScore * policy.qualityWeight +
      refactorability.score * policy.refactorabilityWeight +
      priorityBoost;
    const reasons = [...refactorability.reasons];
    if (isPriority) {
      reasons.push("priority-file");
    }
    if (noOpExcluded && !isPriority) {
      reasons.push("excluded:no-op-threshold");
    }
    if (explicitExcludedByPattern && !isPriority) {
      reasons.push("excluded:path-pattern");
    }
    if (refactorability.score < policy.minRefactorability && !isPriority) {
      reasons.push("below-min-refactorability");
    }
    breakdown.push({
      filePath: normalized,
      averageScore: target.averageScore,
      qualityScore,
      refactorabilityScore: refactorability.score,
      compositeScore,
      noOpCount,
      noOpExcluded: excluded,
      priorityBoostApplied: isPriority,
      reason: reasons,
    });
  }
  const candidateByPath = new Map(breakdown.map((entry) => [entry.filePath, entry]));
  const sortedByComposite = [...uniqueTargets.values()]
    .filter((target) => {
      const model = candidateByPath.get(target.manualFilePath);
      if (!model) {
        return false;
      }
      if (model.noOpExcluded) {
        return false;
      }
      const isPriority = model.priorityBoostApplied;
      if (isPriority) {
        return true;
      }
      return model.refactorabilityScore >= policy.minRefactorability;
    })
    .sort((left, right) => {
      const leftScore = candidateByPath.get(left.manualFilePath)?.compositeScore ?? 0;
      const rightScore = candidateByPath.get(right.manualFilePath)?.compositeScore ?? 0;
      return rightScore - leftScore;
    });
  const selectedRaw: ManualHotRescueTargetModel[] = [];
  const selectedSet = new Set<string>();
  for (const priorityFile of prioritySet) {
    const priorityTarget = uniqueTargets.get(priorityFile);
    if (!priorityTarget) {
      continue;
    }
    selectedRaw.push(priorityTarget);
    selectedSet.add(priorityFile);
    if (selectedRaw.length >= policy.topUnique) {
      break;
    }
  }
  for (const target of sortedByComposite) {
    if (selectedRaw.length >= policy.topUnique) {
      break;
    }
    if (selectedSet.has(target.manualFilePath)) {
      continue;
    }
    selectedRaw.push(target);
    selectedSet.add(target.manualFilePath);
  }
  if (selectedRaw.length < policy.topUnique) {
    const fallbackTargets = [...uniqueTargets.values()]
      .filter((target) => {
        const model = candidateByPath.get(target.manualFilePath);
        if (!model) {
          return false;
        }
        return !model.noOpExcluded;
      })
      .sort((left, right) => {
        const leftQuality = candidateByPath.get(left.manualFilePath)?.qualityScore ?? 0;
        const rightQuality = candidateByPath.get(right.manualFilePath)?.qualityScore ?? 0;
        return rightQuality - leftQuality;
      });
    for (const target of fallbackTargets) {
      if (selectedRaw.length >= policy.topUnique) {
        break;
      }
      if (selectedSet.has(target.manualFilePath)) {
        continue;
      }
      selectedRaw.push(target);
      selectedSet.add(target.manualFilePath);
    }
  }
  if (selectedRaw.length < policy.topUnique) {
    throw new Error(`Not enough refactorability candidates: selected=${selectedRaw.length}, required=${policy.topUnique}`);
  }
  const selected = selectedRaw.slice(0, policy.topUnique).map((target, index) => ({
    rank: index + 1,
    manualFilePath: target.manualFilePath,
    sourceFilePath: target.sourceFilePath,
    exists: true,
    mappedBy: target.mappedBy,
    averageScore: target.averageScore,
    moduleIds: target.moduleIds,
    recommendedActions: target.recommendedActions,
    violations: target.violations,
  }));
  const sortedBreakdown = [...breakdown].sort((left, right) => right.compositeScore - left.compositeScore);
  return {
    selected,
    candidates: sortedBreakdown,
    excludedNoOpCount,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const report = await readJsonFile<ManualHotRescueReportModel>(cli.hotRescueReportPath);
  const policy = await resolvePolicy(cli.policyPath);
  const state = await resolveState(cli.statePath, cli.refactorReportPath);
  const selected = selectTargets(report, state, policy);
  const output: RefactorabilitySelectionReportModel = {
    generatedAtIso: new Date().toISOString(),
    strategy: "refactorability-first",
    sourceHotRescueReportPath: cli.hotRescueReportPath,
    sourceRefactorReportPath: cli.refactorReportPath,
    statePath: cli.statePath,
    policyPath: cli.policyPath,
    topUnique: policy.topUnique,
    selectedCount: selected.selected.length,
    excludedNoOpCount: selected.excludedNoOpCount,
    targets: selected.selected,
    candidates: selected.candidates,
  };
  await ensureDirectory(path.dirname(cli.statePath));
  await ensureDirectory(path.dirname(cli.outputPath));
  await writeJsonFile(cli.statePath, state);
  await writeJsonFile(cli.outputPath, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
