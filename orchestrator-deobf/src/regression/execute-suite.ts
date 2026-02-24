import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { RunMetrics, ToolWeights } from "../contracts";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { MetricScore, scoreRunMetrics } from "./score";
import { RegressionProfile, RegressionSuite } from "./suite-model";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RegressionProfileExecution {
  profileId: string;
  runId: string;
  runDirectory: string;
  metricsPath: string;
  summaryPath: string;
  logPath: string;
  durationMs: number;
  metrics: RunMetrics;
  score: MetricScore;
}

export interface RegressionSuiteExecution {
  suiteRunId: string;
  generatedAtIso: string;
  snapshotAsarPath: string;
  weightsConfigPath: string;
  suiteVersion: number;
  profiles: RegressionProfileExecution[];
  aggregate: {
    averageScore: number;
    minScore: number;
    mappedFilesAverage: number;
    mappedSymbolsAverage: number;
    nameQualityAverage: number;
    buildHealthAllGreen: boolean;
    devHealthAllGreen: boolean;
  };
}

export interface ExecuteRegressionSuiteOptions {
  projectRoot: string;
  snapshotAsarPath: string;
  suite: RegressionSuite;
  weightsConfigPath: string;
  suiteRunId: string;
  outputProfile: "regression-latest";
  outputDirectory: string;
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

function buildProfileArgs(profile: RegressionProfile, options: ExecuteRegressionSuiteOptions, runId: string): string[] {
  const args: string[] = [];
  args.push(path.join(options.projectRoot, "dist", "index.js"));
  args.push("--snapshot", options.snapshotAsarPath);
  args.push("--run-id", runId);
  args.push("--profile", options.outputProfile);
  args.push("--weights-config", options.weightsConfigPath);
  args.push("--wakaru-concurrency", String(profile.flags.wakaruConcurrency));
  args.push("--statement-budget", String(profile.flags.statementBudget));
  args.push("--unwebpack-sourcemap-max-maps", String(profile.flags.unwebpackSourcemapMaxMaps));

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

async function executeProfile(
  options: ExecuteRegressionSuiteOptions,
  profile: RegressionProfile,
  index: number,
  logsDirectory: string,
): Promise<RegressionProfileExecution> {
  const runId = `reg-${sanitizeRunToken(options.suiteRunId)}-${String(index + 1).padStart(2, "0")}-${sanitizeRunToken(profile.id)}`;
  const args = buildProfileArgs(profile, options, runId);
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
  const metrics = await readJsonFile<RunMetrics>(metricsPath);
  const score = scoreRunMetrics(metrics);

  return {
    profileId: profile.id,
    runId,
    runDirectory,
    metricsPath,
    summaryPath,
    logPath,
    durationMs: result.durationMs,
    metrics,
    score,
  };
}

function aggregateExecutions(executions: RegressionProfileExecution[]): RegressionSuiteExecution["aggregate"] {
  return {
    averageScore: average(executions.map((entry) => entry.score.total)),
    minScore: executions.length === 0 ? 0 : Math.min(...executions.map((entry) => entry.score.total)),
    mappedFilesAverage: average(executions.map((entry) => entry.metrics.mappedFiles)),
    mappedSymbolsAverage: average(executions.map((entry) => entry.metrics.mappedSymbols)),
    nameQualityAverage: average(executions.map((entry) => entry.metrics.nameQuality)),
    buildHealthAllGreen: executions.every((entry) => entry.metrics.buildHealth),
    devHealthAllGreen: executions.every((entry) => entry.metrics.devHealth),
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

  const report: RegressionSuiteExecution = {
    suiteRunId: options.suiteRunId,
    generatedAtIso: new Date().toISOString(),
    snapshotAsarPath: options.snapshotAsarPath,
    weightsConfigPath: options.weightsConfigPath,
    suiteVersion: options.suite.version,
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
