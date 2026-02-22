import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  FIXED_REGRESSION_RUNS,
  MATCH_V2_CALIBRATION_PROFILE,
  MATCH_V2_CALIBRATION_TARGETS,
  MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID,
  MATCH_V2_RUNTIME_VARIANTS,
  REVERSE_REGRESSION_BASELINES_FILE,
} from "./reverse/regression-config";
import {
  DEFAULT_REVERSE_REGRESSION_LATEST_DIR,
  DEFAULT_REVERSE_REGRESSION_RUNS_ROOT,
  normalizePathForComparison,
  prepareStableRunPaths,
  publishStableRun,
} from "./reverse/output-discipline";
import { removePath } from "./lib/exec";

interface RegressionOptions {
  appDir: string;
  outRoot: string;
  runsRoot: string;
  keepLastRuns: number;
  runId: string;
  noLatestSync: boolean;
  noAutocalibrate: boolean;
  matchVariant: string;
}

interface RegressionRunResult {
  id: string;
  label: string;
  variantId: string;
  outDir: string;
  exitCode: number;
  success: boolean;
  mappedFiles: number;
  mappedSymbols: number;
  qualityPassed: boolean;
  qualityFailures: string[];
}

interface RegressionVariantResult {
  variantId: string;
  variantDescription: string;
  outRoot: string;
  score: number;
  mappedFilesAverage: number;
  mappedSymbolsAverage: number;
  hitsMappedFileTarget: number;
  hitsMappedSymbolTarget: number;
  failedRuns: number;
  qualityFailures: number;
  results: RegressionRunResult[];
}

interface AppSnapshotInfo {
  appName: string;
  appVersion: string;
  packageJsonPath: string;
  snapshotKey: string;
}

interface RegressionBaselineRunMetrics {
  mappedFiles: number;
  mappedSymbols: number;
}

interface RegressionBaselineProfile {
  appName: string;
  appVersion: string;
  calibrationProfile: string;
  updatedAtUtc: string;
  runs: Record<string, RegressionBaselineRunMetrics>;
}

interface RegressionBaselineStore {
  version: number;
  profiles: Record<string, RegressionBaselineProfile>;
}

interface BaselineValidationResult {
  status: "created" | "validated";
  snapshot: AppSnapshotInfo;
  failures: string[];
  profile: RegressionBaselineProfile;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REGRESSION_BASELINE_SCHEMA_VERSION = 1;

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function parseArgs(argv: string[]): RegressionOptions {
  const options: RegressionOptions = {
    appDir: path.resolve(REPO_ROOT, "work", "app"),
    outRoot: DEFAULT_REVERSE_REGRESSION_LATEST_DIR,
    runsRoot: DEFAULT_REVERSE_REGRESSION_RUNS_ROOT,
    keepLastRuns: 8,
    runId: "",
    noLatestSync: false,
    noAutocalibrate: false,
    matchVariant: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]?.toLowerCase();
    const readValue = (): string => {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${argv[i]}`);
      }
      i += 1;
      return next;
    };
    if (token === "-appdir") {
      options.appDir = path.resolve(readValue());
      continue;
    }
    if (token === "-outroot") {
      options.outRoot = path.resolve(readValue());
      continue;
    }
    if (token === "-runsroot") {
      options.runsRoot = path.resolve(readValue());
      continue;
    }
    if (token === "-keeplastruns") {
      const value = Number(readValue());
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("-KeepLastRuns must be a number >= 1");
      }
      options.keepLastRuns = Math.floor(value);
      continue;
    }
    if (token === "-runid") {
      options.runId = readValue().trim();
      continue;
    }
    if (token === "-nolatestsync") {
      options.noLatestSync = true;
      continue;
    }
    if (token === "-noautocalibrate") {
      options.noAutocalibrate = true;
      continue;
    }
    if (token === "-matchvariant") {
      options.matchVariant = readValue().trim();
      continue;
    }
    throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readAppSnapshotInfo(appDir: string): AppSnapshotInfo {
  const candidatePackagePaths = [
    path.join(appDir, "package.json"),
    path.join(appDir, "resources", "app", "package.json"),
  ];

  for (const packagePath of candidatePackagePaths) {
    if (!fs.existsSync(packagePath)) continue;
    const parsed = readJson<{ name?: unknown; version?: unknown }>(packagePath);
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
      throw new Error(`Invalid app snapshot package name in ${toPosixPath(packagePath)}`);
    }
    if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
      throw new Error(`Invalid app snapshot version in ${toPosixPath(packagePath)}`);
    }
    const appName = parsed.name.trim();
    const appVersion = parsed.version.trim();
    return {
      appName,
      appVersion,
      packageJsonPath: toPosixPath(packagePath),
      snapshotKey: `${appName}@${appVersion}`,
    };
  }

  throw new Error(
    `App snapshot package.json is missing in ${candidatePackagePaths.map((candidate) => toPosixPath(candidate)).join(", ")}`,
  );
}

function resolveBaselinesPath(): string {
  return path.resolve(REPO_ROOT, REVERSE_REGRESSION_BASELINES_FILE);
}

function loadBaselineStore(baselinesPath: string): RegressionBaselineStore {
  if (!fs.existsSync(baselinesPath)) {
    return { version: REGRESSION_BASELINE_SCHEMA_VERSION, profiles: {} };
  }
  const parsed = readJson<RegressionBaselineStore>(baselinesPath);
  if (parsed.version !== REGRESSION_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported regression baseline schema in ${toPosixPath(baselinesPath)}: ${parsed.version}`,
    );
  }
  if (typeof parsed.profiles !== "object" || parsed.profiles === null || Array.isArray(parsed.profiles)) {
    throw new Error(`Invalid regression baseline profiles in ${toPosixPath(baselinesPath)}`);
  }
  return parsed;
}

function toBaselineRunMetrics(results: RegressionRunResult[]): Record<string, RegressionBaselineRunMetrics> {
  const runs: Record<string, RegressionBaselineRunMetrics> = {};
  for (const result of results) {
    runs[result.id] = {
      mappedFiles: result.mappedFiles,
      mappedSymbols: result.mappedSymbols,
    };
  }
  return runs;
}

function validateOrCreateBaselineProfile(input: {
  store: RegressionBaselineStore;
  snapshot: AppSnapshotInfo;
  results: RegressionRunResult[];
}): BaselineValidationResult {
  const existingProfile = input.store.profiles[input.snapshot.snapshotKey];
  if (!existingProfile) {
    const profile: RegressionBaselineProfile = {
      appName: input.snapshot.appName,
      appVersion: input.snapshot.appVersion,
      calibrationProfile: MATCH_V2_CALIBRATION_PROFILE.id,
      updatedAtUtc: new Date().toISOString(),
      runs: toBaselineRunMetrics(input.results),
    };
    input.store.profiles[input.snapshot.snapshotKey] = profile;
    return {
      status: "created",
      snapshot: input.snapshot,
      failures: [],
      profile,
    };
  }

  const failures: string[] = [];
  if (existingProfile.calibrationProfile !== MATCH_V2_CALIBRATION_PROFILE.id) {
    failures.push(
      `baseline calibration mismatch: ${existingProfile.calibrationProfile} != ${MATCH_V2_CALIBRATION_PROFILE.id}`,
    );
  }

  for (const fixedRun of FIXED_REGRESSION_RUNS) {
    const baselineRun = existingProfile.runs[fixedRun.id];
    if (!baselineRun) {
      failures.push(`baseline is missing fixed run ${fixedRun.id}`);
      continue;
    }
    const result = input.results.find((row) => row.id === fixedRun.id);
    if (!result) {
      failures.push(`result set is missing fixed run ${fixedRun.id}`);
      continue;
    }
    if (result.mappedFiles < baselineRun.mappedFiles) {
      failures.push(
        `${fixedRun.id} mappedFiles regression: ${result.mappedFiles} < baseline ${baselineRun.mappedFiles}`,
      );
    }
    if (result.mappedSymbols < baselineRun.mappedSymbols) {
      failures.push(
        `${fixedRun.id} mappedSymbols regression: ${result.mappedSymbols} < baseline ${baselineRun.mappedSymbols}`,
      );
    }
  }

  return {
    status: "validated",
    snapshot: input.snapshot,
    failures,
    profile: existingProfile,
  };
}

function collectOutputPreview(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 40);
}

function toDistanceFromRange(value: number, minValue: number, maxValue: number): number {
  if (value < minValue) return minValue - value;
  if (value > maxValue) return value - maxValue;
  return 0;
}

function runRegressionCase(input: {
  appDir: string;
  outRoot: string;
  runId: string;
  label: string;
  args: string[];
  variantId: string;
}): RegressionRunResult {
  const outDir = path.join(input.outRoot, input.runId);
  const commandArgs = [
    path.join(REPO_ROOT, "scripts", "node", "reverse.js"),
    "-AppDir",
    input.appDir,
    "-OutDir",
    outDir,
    ...input.args,
  ];
  const env = {
    ...process.env,
    REVERSE_MATCH_V2_VARIANT: input.variantId,
  };
  const run = spawnSync(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  const success = run.status === 0;

  const summaryPath = path.join(outDir, "report", "summary.json");
  const qualityPath = path.join(outDir, "report", "quality-gates.json");
  const summary = fs.existsSync(summaryPath) ? readJson<{ deobfuscation?: { mappedFiles?: number; mappedSymbols?: number } }>(summaryPath) : {};
  const quality = fs.existsSync(qualityPath)
    ? readJson<{ passed?: boolean; failures?: string[] }>(qualityPath)
    : {};

  const mappedFiles = summary.deobfuscation?.mappedFiles ?? 0;
  const mappedSymbols = summary.deobfuscation?.mappedSymbols ?? 0;
  const qualityPassed = quality.passed === true;
  const qualityFailures = Array.isArray(quality.failures) ? quality.failures : [];

  if (!success) {
    const previewPath = path.join(outDir, "report", "regression-run-output-preview.json");
    writeJson(previewPath, {
      runId: input.runId,
      variantId: input.variantId,
      exitCode: run.status ?? -1,
      outputPreview: collectOutputPreview(run.stdout || "", run.stderr || ""),
    });
  }

  return {
    id: input.runId,
    label: input.label,
    variantId: input.variantId,
    outDir: toPosixPath(outDir),
    exitCode: run.status ?? -1,
    success,
    mappedFiles,
    mappedSymbols,
    qualityPassed,
    qualityFailures,
  };
}

function scoreVariantResult(results: RegressionRunResult[]): Omit<RegressionVariantResult, "variantId" | "variantDescription" | "outRoot"> {
  const mappedFilesAverage =
    results.length > 0
      ? Number((results.reduce((sum, row) => sum + row.mappedFiles, 0) / results.length).toFixed(2))
      : 0;
  const mappedSymbolsAverage =
    results.length > 0
      ? Number((results.reduce((sum, row) => sum + row.mappedSymbols, 0) / results.length).toFixed(2))
      : 0;

  let score = 0;
  let hitsMappedFileTarget = 0;
  let hitsMappedSymbolTarget = 0;
  let failedRuns = 0;
  let qualityFailures = 0;

  for (const row of results) {
    if (!row.success) {
      score -= 1200;
      failedRuns += 1;
    } else {
      score += 320;
    }
    if (!row.qualityPassed) {
      score -= 900;
      qualityFailures += 1;
    } else {
      score += 260;
    }

    const mappedFilesDistance = toDistanceFromRange(
      row.mappedFiles,
      MATCH_V2_CALIBRATION_TARGETS.mappedFilesMin,
      MATCH_V2_CALIBRATION_TARGETS.mappedFilesMax,
    );
    const mappedSymbolsDistance = toDistanceFromRange(
      row.mappedSymbols,
      MATCH_V2_CALIBRATION_TARGETS.mappedSymbolsMin,
      MATCH_V2_CALIBRATION_TARGETS.mappedSymbolsMax,
    );

    if (mappedFilesDistance === 0) hitsMappedFileTarget += 1;
    if (mappedSymbolsDistance === 0) hitsMappedSymbolTarget += 1;

    score += row.mappedFiles * 85;
    score += row.mappedSymbols * 32;
    score -= mappedFilesDistance * 180;
    score -= mappedSymbolsDistance * 70;
  }

  return {
    score,
    mappedFilesAverage,
    mappedSymbolsAverage,
    hitsMappedFileTarget,
    hitsMappedSymbolTarget,
    failedRuns,
    qualityFailures,
    results,
  };
}

function resolveVariantList(options: RegressionOptions): Array<{ id: string; description: string }> {
  if (options.matchVariant.length > 0) {
    const selected = MATCH_V2_RUNTIME_VARIANTS.find((variant) => variant.id === options.matchVariant);
    if (!selected) {
      throw new Error(`Unknown match-v2 variant: ${options.matchVariant}`);
    }
    return [{ id: selected.id, description: selected.description }];
  }
  if (options.noAutocalibrate) {
    const baseline =
      MATCH_V2_RUNTIME_VARIANTS.find((variant) => variant.id === MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID) ??
      MATCH_V2_RUNTIME_VARIANTS[0];
    if (!baseline) {
      throw new Error("MATCH_V2_RUNTIME_VARIANTS must define at least one variant.");
    }
    return [{ id: baseline.id, description: baseline.description }];
  }
  if (MATCH_V2_RUNTIME_VARIANTS.length === 0) {
    throw new Error("MATCH_V2_RUNTIME_VARIANTS must define at least one variant.");
  }
  return MATCH_V2_RUNTIME_VARIANTS.map((variant) => ({ id: variant.id, description: variant.description }));
}

function pickBestVariant(candidates: RegressionVariantResult[]): RegressionVariantResult {
  if (candidates.length === 0) {
    throw new Error("Regression calibration candidates are empty.");
  }
  const sorted = [...candidates].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.hitsMappedSymbolTarget !== b.hitsMappedSymbolTarget) return b.hitsMappedSymbolTarget - a.hitsMappedSymbolTarget;
    if (a.hitsMappedFileTarget !== b.hitsMappedFileTarget) return b.hitsMappedFileTarget - a.hitsMappedFileTarget;
    if (a.failedRuns !== b.failedRuns) return a.failedRuns - b.failedRuns;
    if (a.qualityFailures !== b.qualityFailures) return a.qualityFailures - b.qualityFailures;
    if (a.variantId === MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID) return -1;
    if (b.variantId === MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID) return 1;
    return a.variantId.localeCompare(b.variantId);
  });
  return sorted[0] as RegressionVariantResult;
}

function formatReportMarkdown(
  selected: RegressionVariantResult,
  variants: RegressionVariantResult[],
  baseline: BaselineValidationResult,
  baselinesPath: string,
): string {
  const rows: string[] = [];
  rows.push("# Reverse Regression Report");
  rows.push("");
  rows.push(`- calibration profile: ${MATCH_V2_CALIBRATION_PROFILE.id}`);
  rows.push(`- fixed runs: ${MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns.join(", ")}`);
  rows.push(
    `- calibration targets: mappedFiles=${MATCH_V2_CALIBRATION_TARGETS.mappedFilesMin}-${MATCH_V2_CALIBRATION_TARGETS.mappedFilesMax}, mappedSymbols=${MATCH_V2_CALIBRATION_TARGETS.mappedSymbolsMin}-${MATCH_V2_CALIBRATION_TARGETS.mappedSymbolsMax}`,
  );
  rows.push(`- selected variant: ${selected.variantId}`);
  rows.push(`- selected variant score: ${selected.score}`);
  rows.push(`- app snapshot: ${baseline.snapshot.snapshotKey}`);
  rows.push(`- app package.json: \`${baseline.snapshot.packageJsonPath}\``);
  rows.push(`- baseline profile: ${baseline.status}`);
  rows.push(`- baselines file: \`${toPosixPath(baselinesPath)}\``);
  if (baseline.failures.length > 0) {
    rows.push(`- baseline validation failures: ${baseline.failures.join("; ")}`);
  }
  rows.push("");
  rows.push("## Calibration Variants");
  rows.push("| Variant | Score | avg mappedFiles | avg mappedSymbols | fileTargetHits | symbolTargetHits | failedRuns | qualityFailures | outRoot |");
  rows.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const variant of variants) {
    rows.push(
      `| ${variant.variantId} | ${variant.score} | ${variant.mappedFilesAverage} | ${variant.mappedSymbolsAverage} | ${variant.hitsMappedFileTarget} | ${variant.hitsMappedSymbolTarget} | ${variant.failedRuns} | ${variant.qualityFailures} | \`${variant.outRoot}\` |`,
    );
  }
  rows.push("");
  rows.push(`## Selected Variant Runs (${selected.variantId})`);
  rows.push("| Run | Exit | mappedFiles | mappedSymbols | qualityGate | outDir |");
  rows.push("| --- | ---: | ---: | ---: | --- | --- |");
  for (const result of selected.results) {
    rows.push(
      `| ${result.id} | ${result.exitCode} | ${result.mappedFiles} | ${result.mappedSymbols} | ${result.qualityPassed ? "pass" : "fail"} | \`${result.outDir}\` |`,
    );
    if (result.qualityFailures.length > 0) {
      rows.push(`| ${result.id}:failures |  |  |  | ${result.qualityFailures.join("; ")} |  |`);
    }
  }
  rows.push("");
  return `${rows.join("\n")}\n`;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = readAppSnapshotInfo(options.appDir);

  const latestMode =
    !options.noLatestSync &&
    normalizePathForComparison(options.outRoot) === normalizePathForComparison(DEFAULT_REVERSE_REGRESSION_LATEST_DIR);
  const stableRun = latestMode
    ? prepareStableRunPaths({
        latestDir: options.outRoot,
        runsRoot: options.runsRoot,
        keepLastRuns: options.keepLastRuns,
        runId: options.runId,
      })
    : undefined;
  const activeOutRoot = stableRun ? stableRun.runDir : path.resolve(options.outRoot);

  removePath(activeOutRoot);
  fs.mkdirSync(activeOutRoot, { recursive: true });

  const variantList = resolveVariantList(options);
  const calibrationBaseDir = path.resolve(REPO_ROOT, "work", "reverse");
  fs.mkdirSync(calibrationBaseDir, { recursive: true });
  const calibrationRoot = variantList.length > 1
    ? fs.mkdtempSync(path.join(calibrationBaseDir, "regression-calibration-"))
    : "";
  const variantResults: RegressionVariantResult[] = [];

  for (const variant of variantList) {
    const variantOutRoot =
      variantList.length > 1
        ? path.join(calibrationRoot, variant.id)
        : activeOutRoot;
    fs.mkdirSync(variantOutRoot, { recursive: true });

    const results: RegressionRunResult[] = [];
    for (const run of FIXED_REGRESSION_RUNS) {
      const result = runRegressionCase({
        appDir: options.appDir,
        outRoot: variantOutRoot,
        runId: run.id,
        label: run.label,
        args: run.args,
        variantId: variant.id,
      });
      results.push(result);
      process.stdout.write(
        `[regression][${variant.id}] ${run.id}: exit=${result.exitCode}, mappedFiles=${result.mappedFiles}, mappedSymbols=${result.mappedSymbols}, quality=${result.qualityPassed}\n`,
      );
    }

    const scored = scoreVariantResult(results);
    variantResults.push({
      variantId: variant.id,
      variantDescription: variant.description,
      outRoot: toPosixPath(variantOutRoot),
      ...scored,
    });
  }

  const selectedVariant = pickBestVariant(variantResults);
  const selectedVariantOutRoot = path.resolve(selectedVariant.outRoot);
  if (selectedVariantOutRoot !== path.resolve(activeOutRoot)) {
    removePath(activeOutRoot);
    fs.cpSync(selectedVariantOutRoot, activeOutRoot, { recursive: true });
  }
  const normalizedSelectedOutRoot = toPosixPath(activeOutRoot);
  selectedVariant.outRoot = normalizedSelectedOutRoot;
  selectedVariant.results = selectedVariant.results.map((row) => ({
    ...row,
    outDir: toPosixPath(path.join(activeOutRoot, row.id)),
  }));
  for (const variant of variantResults) {
    if (variant.variantId === selectedVariant.variantId) {
      variant.outRoot = normalizedSelectedOutRoot;
      variant.results = selectedVariant.results;
      continue;
    }
    if (calibrationRoot.length > 0) {
      variant.outRoot = "<ephemeral-calibration>";
      variant.results = variant.results.map((row) => ({
        ...row,
        outDir: `<ephemeral-calibration>/${variant.variantId}/${row.id}`,
      }));
    }
  }
  if (calibrationRoot.length > 0) {
    removePath(calibrationRoot);
  }

  const baselinesPath = resolveBaselinesPath();
  const baselineStore = loadBaselineStore(baselinesPath);
  const baselineValidation = validateOrCreateBaselineProfile({
    store: baselineStore,
    snapshot,
    results: selectedVariant.results,
  });
  if (baselineValidation.status === "created") {
    writeJson(baselinesPath, baselineStore);
    process.stdout.write(
      `[regression] created baseline profile for snapshot ${snapshot.snapshotKey} in ${toPosixPath(baselinesPath)}\n`,
    );
  }

  const reportPath = path.join(activeOutRoot, "regression-report.json");
  const markdownPath = path.join(activeOutRoot, "regression-report.md");
  const report = {
    generatedAtUtc: new Date().toISOString(),
    calibrationProfile: MATCH_V2_CALIBRATION_PROFILE,
    calibrationTargets: MATCH_V2_CALIBRATION_TARGETS,
    appSnapshot: snapshot,
    baseline: {
      status: baselineValidation.status,
      failures: baselineValidation.failures,
      baselinesFile: toPosixPath(baselinesPath),
      profile: baselineValidation.profile,
    },
    appDir: toPosixPath(options.appDir),
    outRoot: toPosixPath(activeOutRoot),
    selectedVariant: {
      variantId: selectedVariant.variantId,
      score: selectedVariant.score,
      mappedFilesAverage: selectedVariant.mappedFilesAverage,
      mappedSymbolsAverage: selectedVariant.mappedSymbolsAverage,
      hitsMappedFileTarget: selectedVariant.hitsMappedFileTarget,
      hitsMappedSymbolTarget: selectedVariant.hitsMappedSymbolTarget,
      failedRuns: selectedVariant.failedRuns,
      qualityFailures: selectedVariant.qualityFailures,
    },
    variants: variantResults.map((variant) => ({
      variantId: variant.variantId,
      variantDescription: variant.variantDescription,
      outRoot: variant.outRoot,
      score: variant.score,
      mappedFilesAverage: variant.mappedFilesAverage,
      mappedSymbolsAverage: variant.mappedSymbolsAverage,
      hitsMappedFileTarget: variant.hitsMappedFileTarget,
      hitsMappedSymbolTarget: variant.hitsMappedSymbolTarget,
      failedRuns: variant.failedRuns,
      qualityFailures: variant.qualityFailures,
      runs: variant.results,
    })),
    runs: selectedVariant.results,
  };
  writeJson(reportPath, report);
  fs.writeFileSync(markdownPath, formatReportMarkdown(selectedVariant, variantResults, baselineValidation, baselinesPath), "utf8");

  if (stableRun) {
    const publishResult = publishStableRun(stableRun);
    process.stdout.write(
      `[regression] synced latest=${toPosixPath(stableRun.latestDir)} run=${stableRun.runId} removed=${publishResult.removedRuns.length}\n`,
    );
  }

  const failed =
    selectedVariant.results.some((row) => !row.success || !row.qualityPassed) ||
    baselineValidation.failures.length > 0;
  if (failed) {
    process.stderr.write(
      `[regression] failed, inspect ${toPosixPath(path.join(activeOutRoot, "regression-report.json"))} and ${toPosixPath(path.join(activeOutRoot, "regression-report.md"))}\n`,
    );
    return 1;
  }
  process.stdout.write(`[regression] success, report: ${toPosixPath(path.join(activeOutRoot, "regression-report.md"))}\n`);
  return 0;
}

process.exit(main());
