import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  FIXED_REGRESSION_RUNS,
  MATCH_V2_CALIBRATION_PROFILE,
  REVERSE_REGRESSION_BASELINES_FILE,
} from "./reverse/regression-config";

interface RegressionOptions {
  appDir: string;
  outRoot: string;
}

interface RegressionRunResult {
  id: string;
  label: string;
  outDir: string;
  exitCode: number;
  success: boolean;
  mappedFiles: number;
  mappedSymbols: number;
  qualityPassed: boolean;
  qualityFailures: string[];
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
    outRoot: path.resolve(REPO_ROOT, "work", "reverse-regression"),
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

function runRegressionCase(options: RegressionOptions, runId: string, label: string, args: string[]): RegressionRunResult {
  const outDir = path.join(options.outRoot, runId);
  const commandArgs = [
    path.join(REPO_ROOT, "scripts", "node", "reverse.js"),
    "-AppDir",
    options.appDir,
    "-OutDir",
    outDir,
    ...args,
  ];
  const run = spawnSync(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
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
      runId,
      exitCode: run.status ?? -1,
      outputPreview: collectOutputPreview(run.stdout || "", run.stderr || ""),
    });
  }

  return {
    id: runId,
    label,
    outDir: toPosixPath(outDir),
    exitCode: run.status ?? -1,
    success,
    mappedFiles,
    mappedSymbols,
    qualityPassed,
    qualityFailures,
  };
}

function formatReportMarkdown(
  results: RegressionRunResult[],
  baseline: BaselineValidationResult,
  baselinesPath: string,
): string {
  const rows: string[] = [];
  rows.push("# Reverse Regression Report");
  rows.push("");
  rows.push(`- calibration profile: ${MATCH_V2_CALIBRATION_PROFILE.id}`);
  rows.push(`- fixed runs: ${MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns.join(", ")}`);
  rows.push(`- app snapshot: ${baseline.snapshot.snapshotKey}`);
  rows.push(`- app package.json: \`${baseline.snapshot.packageJsonPath}\``);
  rows.push(`- baseline profile: ${baseline.status}`);
  rows.push(`- baselines file: \`${toPosixPath(baselinesPath)}\``);
  if (baseline.failures.length > 0) {
    rows.push(`- baseline validation failures: ${baseline.failures.join("; ")}`);
  }
  rows.push("");
  rows.push("| Run | Exit | mappedFiles | mappedSymbols | qualityGate | outDir |");
  rows.push("| --- | ---: | ---: | ---: | --- | --- |");
  for (const result of results) {
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
  fs.mkdirSync(options.outRoot, { recursive: true });
  const snapshot = readAppSnapshotInfo(options.appDir);

  const results: RegressionRunResult[] = [];
  for (const run of FIXED_REGRESSION_RUNS) {
    const result = runRegressionCase(options, run.id, run.label, run.args);
    results.push(result);
    process.stdout.write(
      `[regression] ${run.id}: exit=${result.exitCode}, mappedFiles=${result.mappedFiles}, mappedSymbols=${result.mappedSymbols}, quality=${result.qualityPassed}\n`,
    );
  }
  const baselinesPath = resolveBaselinesPath();
  const baselineStore = loadBaselineStore(baselinesPath);
  const baselineValidation = validateOrCreateBaselineProfile({
    store: baselineStore,
    snapshot,
    results,
  });
  if (baselineValidation.status === "created") {
    writeJson(baselinesPath, baselineStore);
    process.stdout.write(
      `[regression] created baseline profile for snapshot ${snapshot.snapshotKey} in ${toPosixPath(baselinesPath)}\n`,
    );
  }

  const reportPath = path.join(options.outRoot, "regression-report.json");
  const markdownPath = path.join(options.outRoot, "regression-report.md");
  const report = {
    generatedAtUtc: new Date().toISOString(),
    calibrationProfile: MATCH_V2_CALIBRATION_PROFILE,
    appSnapshot: snapshot,
    baseline: {
      status: baselineValidation.status,
      failures: baselineValidation.failures,
      baselinesFile: toPosixPath(baselinesPath),
      profile: baselineValidation.profile,
    },
    appDir: toPosixPath(options.appDir),
    outRoot: toPosixPath(options.outRoot),
    runs: results,
  };
  writeJson(reportPath, report);
  fs.writeFileSync(markdownPath, formatReportMarkdown(results, baselineValidation, baselinesPath), "utf8");

  const failed =
    results.some((row) => !row.success || !row.qualityPassed) ||
    baselineValidation.failures.length > 0;
  if (failed) {
    process.stderr.write(
      `[regression] failed, inspect ${toPosixPath(reportPath)} and ${toPosixPath(markdownPath)}\n`,
    );
    return 1;
  }
  process.stdout.write(`[regression] success, report: ${toPosixPath(markdownPath)}\n`);
  return 0;
}

process.exit(main());
