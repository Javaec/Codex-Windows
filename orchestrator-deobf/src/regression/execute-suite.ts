import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ArtifactRetentionMode, GateMode, RunMetrics, ToolWeights } from "../contracts";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { scoreNameQuality } from "../ir/name-quality";
import { SemanticIrModel } from "../ir/semantic-ir";
import { MetricScore, scoreRunMetrics } from "./score";
import { RegressionProfile, RegressionSuite } from "./suite-model";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface RunSummarySnapshot {
  stageOutputs: {
    namingMemory: {
      namedSemanticIrPath: string;
      qualityNamedSemanticIrPath?: string;
      coverageNamedSemanticIrPath?: string;
    };
    templateEmitter: {
      fileQualityReportPath: string;
      hotChunkCount: number;
    };
    qualityGates: {
      stableProjectDirectory: string;
    };
  };
}

interface FileQualityEntrySnapshot {
  moduleId: string;
  filePath: string;
  score: number;
  symbolCount: number;
  symbolKeys?: string[];
  averageConfidence: number;
  averageNameQuality: number;
  liftedCoverage: number;
  rerendered: boolean;
  hotFocus?: boolean;
}

interface FileQualityReportSnapshot {
  generatedAtIso: string;
  rerenderedModuleCount: number;
  worstPercent: number;
  hotFirstOnly?: boolean;
  hotFirstTargetMin?: number;
  hotFirstTargetMax?: number;
  hotFocusFileCount?: number;
  files: FileQualityEntrySnapshot[];
}

export interface MergedSymbolEvidence {
  symbolKey: string;
  symbolName: string;
  confidence: number;
  quality: number;
  mergedScore: number;
  profileId: string;
  runId: string;
  provenance: string[];
  snapshotProfileId: string;
  snapshotProfileConfidence: number;
}

export interface MergedFileEvidence {
  pathHint: string;
  confidence: number;
  mergedScore: number;
  profileId: string;
  runId: string;
}

export interface MergedEvidenceReport {
  generatedAtIso: string;
  suiteRunId: string;
  dominantSnapshotProfileId: string;
  dominantSnapshotProfileWeight: number;
  symbolWinnerCount: number;
  fileWinnerCount: number;
  symbolWinners: MergedSymbolEvidence[];
  fileWinners: MergedFileEvidence[];
}

export interface RegressionProfileExecution {
  profileId: string;
  runId: string;
  runDirectory: string;
  weightsConfigPath: string;
  metricsPath: string;
  summaryPath: string;
  logPath: string;
  durationMs: number;
  metrics: RunMetrics;
  score: MetricScore;
  fileQuality: {
    fileQualityReportPath: string;
    stableProjectDirectory: string;
    fileCount: number;
    worstDecileAverageScore: number;
    lowQualityFileCount: number;
    rerenderedModuleCount: number;
    hotFocusFileCount: number;
    hotFirstOnly: boolean;
    hotChunkCount: number;
    worstFiles: Array<{
      moduleId: string;
      filePath: string;
      score: number;
      symbolCount: number;
      symbolKeys: string[];
      averageConfidence: number;
      averageNameQuality: number;
      liftedCoverage: number;
      rerendered: boolean;
      hotFocus: boolean;
    }>;
  };
}

export interface RegressionSuiteExecution {
  suiteRunId: string;
  generatedAtIso: string;
  snapshotAsarPath: string;
  weightsConfigPath: string;
  suiteVersion: number;
  mergedEvidencePath: string;
  profiles: RegressionProfileExecution[];
  aggregate: {
    averageScore: number;
    minScore: number;
    mappedFilesAverage: number;
    mappedSymbolsAverage: number;
    highConfidenceSymbolsAverage: number;
    nameQualityAverage: number;
    classCoverageAverage: number;
    functionCoverageAverage: number;
    functionClassCoverageAverage: number;
    variableCoverageAverage: number;
    proxyInQualityAverage: number;
    worstFileDecileScoreAverage: number;
    lowQualityFileCountAverage: number;
    rerenderedModuleAverage: number;
    hotFocusFileAverage: number;
    hotFirstOnlyAllProfiles: boolean;
    hotChunkAverage: number;
    buildHealthAllGreen: boolean;
    devHealthAllGreen: boolean;
  };
}

export interface ExecuteRegressionSuiteOptions {
  projectRoot: string;
  snapshotAsarPath: string;
  suite: RegressionSuite;
  weightsConfigPath: string;
  profileWeightsConfigPathByProfileId?: Record<string, string>;
  suiteRunId: string;
  outputProfile: "regression-latest";
  outputDirectory: string;
  gateMode: GateMode;
  artifactRetention: ArtifactRetentionMode;
}

function formatNowUtc(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function sanitizeRunToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

async function runNodeCommand(cwd: string, args: string[]): Promise<CommandResult> {
  const started = Date.now();
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
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

function appendFlag(args: string[], enabled: boolean, flag: string): void {
  if (enabled) {
    args.push(flag);
  }
}

function buildProfileArgs(
  profile: RegressionProfile,
  options: ExecuteRegressionSuiteOptions,
  runId: string,
  weightsConfigPath: string,
): string[] {
  const args: string[] = [];
  args.push(path.join(options.projectRoot, "dist", "index.js"));
  args.push("--snapshot", options.snapshotAsarPath);
  args.push("--run-id", runId);
  args.push("--profile", options.outputProfile);
  args.push("--weights-config", weightsConfigPath);
  args.push("--wakaru-concurrency", String(profile.flags.wakaruConcurrency));
  args.push("--statement-budget", String(profile.flags.statementBudget));
  args.push("--unwebpack-sourcemap-max-maps", String(profile.flags.unwebpackSourcemapMaxMaps));
  args.push("--gate-mode", options.gateMode);
  args.push("--artifact-retention", options.artifactRetention);

  appendFlag(args, profile.flags.enableWakaru, "--enable-wakaru");
  appendFlag(args, !profile.flags.enableWakaru, "--disable-wakaru");
  appendFlag(args, profile.flags.enableJavascriptDeobfuscator, "--enable-javascript-deobfuscator");
  appendFlag(args, profile.flags.enableSynchrony, "--enable-synchrony");
  appendFlag(args, profile.flags.enableUnwebpackSourcemap, "--enable-unwebpack-sourcemap");
  appendFlag(args, profile.flags.javascriptDeobfuscatorParseAsModule, "--javascript-deobfuscator-module");
  appendFlag(args, profile.flags.synchronyRename, "--synchrony-rename");
  appendFlag(args, profile.flags.synchronyLoose, "--synchrony-loose");
  return args;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(4));
}

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

const PROVENANCE_SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  asar: 0.76,
  webcrack: 1,
  wakaru: 0.96,
  "javascript-deobfuscator": 0.9,
  synchrony: 0.88,
  "unwebpack-sourcemap": 0.93,
};

function normalizeProvenanceTool(token: string): string {
  const lower = token.toLowerCase();
  if (lower.includes("webcrack")) {
    return "webcrack";
  }
  if (lower.includes("wakaru")) {
    return "wakaru";
  }
  if (lower.includes("javascript-deobfuscator")) {
    return "javascript-deobfuscator";
  }
  if (lower.includes("synchrony")) {
    return "synchrony";
  }
  if (lower.includes("unwebpack")) {
    return "unwebpack-sourcemap";
  }
  if (lower.includes("asar")) {
    return "asar";
  }
  return "asar";
}

function provenanceWeight(provenance: string[]): number {
  if (provenance.length === 0) {
    return 0.72;
  }
  const weights = provenance.map((entry) => {
    const normalized = normalizeProvenanceTool(entry);
    return PROVENANCE_SOURCE_WEIGHTS[normalized] ?? 0.76;
  });
  const averageWeight = weights.reduce((sum, value) => sum + value, 0) / Math.max(1, weights.length);
  return clamp(averageWeight);
}

const MERGED_SYMBOL_WINNER_MIN = 3600;
const MERGED_SYMBOL_WINNER_MAX = 8000;
const MERGED_FILE_WINNER_MIN = 640;
const MERGED_FILE_WINNER_MAX = 960;

function rerankedSymbolScore(candidate: MergedSymbolEvidence, dominantSnapshotProfileId: string): number {
  const sourceWeight = provenanceWeight(candidate.provenance);
  const isDominantSnapshotProfile = candidate.snapshotProfileId === dominantSnapshotProfileId;
  const snapshotWeight = isDominantSnapshotProfile
    ? candidate.snapshotProfileConfidence
    : (1 - candidate.snapshotProfileConfidence) * 0.42;
  return Number((
    candidate.mergedScore * 0.66 +
    candidate.quality * 0.14 +
    candidate.confidence * 0.06 +
    sourceWeight * 0.08 +
    snapshotWeight * 0.06
  ).toFixed(4));
}

function resolveMergedSymbolWinnerCap(totalSymbols: number): number {
  const scaled = Math.round(totalSymbols * 0.92);
  return Math.max(MERGED_SYMBOL_WINNER_MIN, Math.min(MERGED_SYMBOL_WINNER_MAX, scaled));
}

function resolveMergedFileWinnerCap(totalFiles: number): number {
  const scaled = Math.round(totalFiles * 0.9);
  return Math.max(MERGED_FILE_WINNER_MIN, Math.min(MERGED_FILE_WINNER_MAX, scaled));
}

function summarizeFileQuality(report: FileQualityReportSnapshot): RegressionProfileExecution["fileQuality"] {
  const ordered = [...report.files].sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return left.filePath.localeCompare(right.filePath);
  });
  const fileCount = ordered.length;
  const decileSize = Math.max(1, Math.ceil(fileCount * 0.1));
  const worstDecile = ordered.slice(0, decileSize);
  const worstDecileAverageScore =
    worstDecile.length < 1
      ? 0
      : clamp(
          worstDecile.reduce((sum, entry) => sum + clamp(entry.score), 0) /
            worstDecile.length,
        );
  const lowQualityFileCount = ordered.filter((entry) => clamp(entry.score) < 0.62).length;
  const worstFiles = ordered.slice(0, Math.max(16, decileSize)).map((entry) => ({
    moduleId: entry.moduleId,
    filePath: entry.filePath,
    score: clamp(entry.score),
    symbolCount: entry.symbolCount,
    symbolKeys: Array.isArray(entry.symbolKeys)
      ? [...new Set(entry.symbolKeys.filter((symbolKey) => typeof symbolKey === "string" && symbolKey.length > 0))].sort(
        (left, right) => left.localeCompare(right),
      )
      : [],
    averageConfidence: clamp(entry.averageConfidence),
    averageNameQuality: clamp(entry.averageNameQuality),
    liftedCoverage: clamp(entry.liftedCoverage),
    rerendered: entry.rerendered,
    hotFocus: entry.hotFocus === true,
  }));
  return {
    fileQualityReportPath: "",
    stableProjectDirectory: "",
    fileCount,
    worstDecileAverageScore,
    lowQualityFileCount,
    rerenderedModuleCount: report.rerenderedModuleCount,
    hotFocusFileCount: Math.max(0, Math.trunc(report.hotFocusFileCount ?? 0)),
    hotFirstOnly: report.hotFirstOnly === true,
    hotChunkCount: 0,
    worstFiles,
  };
}

async function executeProfile(
  options: ExecuteRegressionSuiteOptions,
  profile: RegressionProfile,
  index: number,
  logsDirectory: string,
): Promise<RegressionProfileExecution> {
  const runId = `reg-${sanitizeRunToken(options.suiteRunId)}-${String(index + 1).padStart(2, "0")}-${sanitizeRunToken(profile.id)}`;
  const profileWeightsConfigPath = options.profileWeightsConfigPathByProfileId?.[profile.id] ?? options.weightsConfigPath;
  const args = buildProfileArgs(profile, options, runId, profileWeightsConfigPath);
  const result = await runNodeCommand(options.projectRoot, args);
  const logPath = path.join(logsDirectory, `${String(index + 1).padStart(2, "0")}-${sanitizeRunToken(profile.id)}.log`);
  await fs.writeFile(
    logPath,
    [`# args`, `${process.execPath} ${args.join(" ")}`, "", "# stdout", result.stdout, "", "# stderr", result.stderr].join("\n"),
    "utf8",
  );
  if (result.exitCode !== 0) {
    throw new Error(`Regression profile failed: ${profile.id}. See log: ${logPath}`);
  }

  const runDirectory = path.join(options.projectRoot, "runs", runId);
  const metricsPath = path.join(runDirectory, "run-metrics.json");
  const summaryPath = path.join(runDirectory, "summary.json");
  const summary = await readJsonFile<RunSummarySnapshot>(summaryPath);
  const fileQualityReport = await readJsonFile<FileQualityReportSnapshot>(summary.stageOutputs.templateEmitter.fileQualityReportPath);
  const metrics = await readJsonFile<RunMetrics>(metricsPath);
  const score = scoreRunMetrics(metrics);
  const fileQualitySummary = summarizeFileQuality(fileQualityReport);

  return {
    profileId: profile.id,
    runId,
    runDirectory,
    weightsConfigPath: profileWeightsConfigPath,
    metricsPath,
    summaryPath,
    logPath,
    durationMs: result.durationMs,
    metrics,
    score,
    fileQuality: {
      ...fileQualitySummary,
      fileQualityReportPath: summary.stageOutputs.templateEmitter.fileQualityReportPath,
      stableProjectDirectory: summary.stageOutputs.qualityGates.stableProjectDirectory,
      hotChunkCount: summary.stageOutputs.templateEmitter.hotChunkCount,
    },
  };
}

function aggregateExecutions(executions: RegressionProfileExecution[]): RegressionSuiteExecution["aggregate"] {
  return {
    averageScore: average(executions.map((entry) => entry.score.total)),
    minScore: executions.length === 0 ? 0 : Math.min(...executions.map((entry) => entry.score.total)),
    mappedFilesAverage: average(executions.map((entry) => entry.metrics.mappedFiles)),
    mappedSymbolsAverage: average(executions.map((entry) => entry.metrics.mappedSymbols)),
    highConfidenceSymbolsAverage: average(executions.map((entry) => entry.metrics.highConfidenceSymbols)),
    nameQualityAverage: average(executions.map((entry) => entry.metrics.nameQuality)),
    classCoverageAverage: average(executions.map((entry) => entry.metrics.classCoverage)),
    functionCoverageAverage: average(executions.map((entry) => entry.metrics.functionCoverage)),
    functionClassCoverageAverage: average(executions.map((entry) => entry.metrics.functionClassCoverage)),
    variableCoverageAverage: average(executions.map((entry) => entry.metrics.variableCoverage)),
    proxyInQualityAverage: average(executions.map((entry) => entry.metrics.proxyInQualityCount)),
    worstFileDecileScoreAverage: average(executions.map((entry) => entry.fileQuality.worstDecileAverageScore)),
    lowQualityFileCountAverage: average(executions.map((entry) => entry.fileQuality.lowQualityFileCount)),
    rerenderedModuleAverage: average(executions.map((entry) => entry.fileQuality.rerenderedModuleCount)),
    hotFocusFileAverage: average(executions.map((entry) => entry.fileQuality.hotFocusFileCount)),
    hotFirstOnlyAllProfiles: executions.every((entry) => entry.fileQuality.hotFirstOnly),
    hotChunkAverage: average(executions.map((entry) => entry.fileQuality.hotChunkCount)),
    buildHealthAllGreen: executions.every((entry) => entry.metrics.buildHealth),
    devHealthAllGreen: executions.every((entry) => entry.metrics.devHealth),
  };
}

function mergeFileEvidence(
  existing: MergedFileEvidence | undefined,
  candidate: MergedFileEvidence,
): MergedFileEvidence {
  if (!existing) {
    return candidate;
  }
  if (candidate.mergedScore !== existing.mergedScore) {
    return candidate.mergedScore > existing.mergedScore ? candidate : existing;
  }
  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence ? candidate : existing;
  }
  return candidate.pathHint.localeCompare(existing.pathHint) < 0 ? candidate : existing;
}

async function buildMergedEvidenceReport(
  suiteRunId: string,
  executions: RegressionProfileExecution[],
): Promise<MergedEvidenceReport> {
  const symbolCandidatesByKey = new Map<string, MergedSymbolEvidence[]>();
  const fileByPath = new Map<string, MergedFileEvidence>();
  const snapshotProfileWeightById = new Map<string, number>();

  for (const execution of executions) {
    const summary = await readJsonFile<RunSummarySnapshot>(execution.summaryPath);
    const semanticIrPath =
      summary.stageOutputs.namingMemory.coverageNamedSemanticIrPath ??
      summary.stageOutputs.namingMemory.qualityNamedSemanticIrPath ??
      summary.stageOutputs.namingMemory.namedSemanticIrPath;
    const semanticIr = await readJsonFile<SemanticIrModel>(semanticIrPath);
    const profileScore = execution.score.total;
    const snapshotProfileId = semanticIr.obfuscationProfile.profileId;
    const snapshotProfileConfidence = clamp(semanticIr.obfuscationProfile.confidence);
    const snapshotProfileWeight = (snapshotProfileWeightById.get(snapshotProfileId) ?? 0) + snapshotProfileConfidence * profileScore;
    snapshotProfileWeightById.set(snapshotProfileId, Number(snapshotProfileWeight.toFixed(4)));

    for (const symbol of semanticIr.symbols) {
      const quality = scoreNameQuality(symbol.name);
      const sourceWeight = provenanceWeight(symbol.provenance);
      const mergedScore = Number((symbol.confidence * quality * Math.max(0.1, profileScore) * (0.9 + sourceWeight * 0.1)).toFixed(4));
      const candidate: MergedSymbolEvidence = {
        symbolKey: symbol.symbolKey,
        symbolName: symbol.name,
        confidence: Number(symbol.confidence.toFixed(4)),
        quality: Number(quality.toFixed(4)),
        mergedScore,
        profileId: execution.profileId,
        runId: execution.runId,
        provenance: [...symbol.provenance].sort((left, right) => left.localeCompare(right)),
        snapshotProfileId,
        snapshotProfileConfidence,
      };
      const existing = symbolCandidatesByKey.get(symbol.symbolKey);
      if (existing) {
        existing.push(candidate);
      } else {
        symbolCandidatesByKey.set(symbol.symbolKey, [candidate]);
      }
    }

    for (const fileHint of semanticIr.fileHints) {
      const mergedScore = Number((fileHint.confidence * Math.max(0.1, profileScore)).toFixed(4));
      const candidate: MergedFileEvidence = {
        pathHint: fileHint.pathHint,
        confidence: Number(fileHint.confidence.toFixed(4)),
        mergedScore,
        profileId: execution.profileId,
        runId: execution.runId,
      };
      fileByPath.set(fileHint.pathHint, mergeFileEvidence(fileByPath.get(fileHint.pathHint), candidate));
    }
  }

  const dominantSnapshotProfile = [...snapshotProfileWeightById.entries()].sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0]);
  })[0];
  const dominantSnapshotProfileId = dominantSnapshotProfile ? dominantSnapshotProfile[0] : "profile-v1";
  const dominantSnapshotProfileWeight = dominantSnapshotProfile ? Number(dominantSnapshotProfile[1].toFixed(4)) : 0;

  const symbolWinners = [...symbolCandidatesByKey.entries()]
    .map((entry) => {
      const candidates = entry[1];
      if (!candidates || candidates.length < 1) {
        throw new Error(`buildMergedEvidenceReport: missing symbol candidates for ${entry[0]}`);
      }
      const winner = [...candidates].sort((left, right) => {
        const leftScore = rerankedSymbolScore(left, dominantSnapshotProfileId);
        const rightScore = rerankedSymbolScore(right, dominantSnapshotProfileId);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        if (left.mergedScore !== right.mergedScore) {
          return right.mergedScore - left.mergedScore;
        }
        if (left.quality !== right.quality) {
          return right.quality - left.quality;
        }
        return left.symbolName.localeCompare(right.symbolName);
      })[0];
      if (!winner) {
        throw new Error(`buildMergedEvidenceReport: unable to select symbol winner for ${entry[0]}`);
      }
      return winner;
    })
    .sort((left, right) => {
      const leftScore = rerankedSymbolScore(left, dominantSnapshotProfileId);
      const rightScore = rerankedSymbolScore(right, dominantSnapshotProfileId);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      if (left.mergedScore !== right.mergedScore) {
        return right.mergedScore - left.mergedScore;
      }
      if (left.quality !== right.quality) {
        return right.quality - left.quality;
      }
      return left.symbolKey.localeCompare(right.symbolKey);
    })
    .slice(0, resolveMergedSymbolWinnerCap(symbolCandidatesByKey.size));

  const fileWinners = [...fileByPath.values()]
    .sort((left, right) => {
      if (left.mergedScore !== right.mergedScore) {
        return right.mergedScore - left.mergedScore;
      }
      return left.pathHint.localeCompare(right.pathHint);
    })
    .slice(0, resolveMergedFileWinnerCap(fileByPath.size));

  return {
    generatedAtIso: new Date().toISOString(),
    suiteRunId,
    dominantSnapshotProfileId,
    dominantSnapshotProfileWeight,
    symbolWinnerCount: symbolWinners.length,
    fileWinnerCount: fileWinners.length,
    symbolWinners,
    fileWinners,
  };
}

export async function executeRegressionSuite(options: ExecuteRegressionSuiteOptions): Promise<RegressionSuiteExecution> {
  const suiteDirectory = path.join(options.outputDirectory, sanitizeRunToken(options.suiteRunId));
  const logsDirectory = path.join(suiteDirectory, "logs");
  await ensureDirectory(logsDirectory);

  const profileExecutions: RegressionProfileExecution[] = [];
  for (let index = 0; index < options.suite.profiles.length; index += 1) {
    const profile = options.suite.profiles[index];
    if (!profile) {
      throw new Error("Regression profile missing");
    }
    const execution = await executeProfile(options, profile, index, logsDirectory);
    profileExecutions.push(execution);
  }

  const mergedEvidence = await buildMergedEvidenceReport(options.suiteRunId, profileExecutions);
  const mergedEvidencePath = path.join(suiteDirectory, "merged-evidence.json");
  await writeJsonFile(mergedEvidencePath, mergedEvidence);

  const report: RegressionSuiteExecution = {
    suiteRunId: options.suiteRunId,
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: options.snapshotAsarPath,
    weightsConfigPath: options.weightsConfigPath,
    suiteVersion: options.suite.version,
    mergedEvidencePath,
    profiles: profileExecutions,
    aggregate: aggregateExecutions(profileExecutions),
  };

  const reportPath = path.join(suiteDirectory, "report.json");
  await writeJsonFile(reportPath, report);
  await writeJsonFile(path.join(suiteDirectory, "suite-input.json"), {
    generatedAtIso: new Date().toISOString(),
    suiteVersion: options.suite.version,
    suiteRunId: options.suiteRunId,
    snapshotAsarPath: options.snapshotAsarPath,
    weightsConfigPath: options.weightsConfigPath,
    profileCount: options.suite.profiles.length,
    marker: formatNowUtc(),
  });

  return report;
}
