import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineOptions } from "../args";
import { removePath, writeHeader, writeSuccess } from "../exec";
import { PortableSmokeResult, runPortableSmoke } from "../runtime-pack/smoke";
import { REPO_ROOT } from "./context";
import { runPipelineDetailed } from "./pipeline";

type SmokeStageReport = {
  stage: "launchability" | "authenticated";
  success: boolean;
  failures: string[];
  laneCount: number;
  summaryPath: string;
  summaryJsonPath: string;
  runtimeLogsDir: string;
};

type SmokeRunReport = {
  version: number;
  generatedAtIso: string;
  outputDir: string;
  smokeSeconds: number;
  launchability: SmokeStageReport;
  authenticated: SmokeStageReport | null;
  success: boolean;
};

function moveRuntimeLogs(outputDir: string, stageLabel: string): string {
  const sourceDir = path.join(outputDir, "runtime-logs");
  const targetDir = path.join(outputDir, `runtime-logs-${stageLabel}`);
  removePath(targetDir);
  if (fs.existsSync(sourceDir)) {
    fs.renameSync(sourceDir, targetDir);
  }
  return targetDir;
}

function buildStageReport(
  stage: SmokeStageReport["stage"],
  smokeResult: PortableSmokeResult,
  runtimeLogsDir: string,
): SmokeStageReport {
  return {
    stage,
    success: smokeResult.success,
    failures: [...smokeResult.failures],
    laneCount: smokeResult.lanes.length,
    runtimeLogsDir,
    summaryPath: path.join(runtimeLogsDir, "lane-summary.txt"),
    summaryJsonPath: path.join(runtimeLogsDir, "lane-summary.json"),
  };
}

export async function runSmoke(options: PipelineOptions): Promise<number> {
  writeHeader("Smoke build");
  const smokeWorkDir = path.resolve(options.workDir || path.join(REPO_ROOT, "work", "runner-smoke"));
  const smokeDistDir = path.resolve(options.distDir || path.join(smokeWorkDir, "dist"));

  const pipelineResult = await runPipelineDetailed({
    ...options,
    workDir: smokeWorkDir,
    distDir: smokeDistDir,
    buildPortable: true,
    noLaunch: true,
    buildSingleExe: false,
  });
  if (pipelineResult.exitCode !== 0) {
    return pipelineResult.exitCode;
  }
  if (!pipelineResult.portableOutputDir) {
    throw new Error("Smoke mode requires a portable output directory");
  }

  writeSuccess(`Smoke portable output: ${pipelineResult.portableOutputDir}`);
  const launchabilityResult = await runPortableSmoke({
    outputDir: pipelineResult.portableOutputDir,
    smokeSeconds: options.smokeSeconds,
    rawLanes: options.smokeLanes,
  });

  let launchabilityLogsDir = path.join(pipelineResult.portableOutputDir, "runtime-logs");
  let authenticatedStage: SmokeStageReport | null = null;
  if (options.smokeAuthStage) {
    if (!options.smokeUserDataSeedPath || !options.smokeCodexHomeSeedPath) {
      throw new Error("Smoke auth stage requires both -SmokeUserDataSeed and -SmokeCodexHomeSeed");
    }
    launchabilityLogsDir = moveRuntimeLogs(pipelineResult.portableOutputDir, "launchability");
    const authResult = await runPortableSmoke({
      outputDir: pipelineResult.portableOutputDir,
      smokeSeconds: options.smokeSeconds,
      rawLanes: options.smokeAuthLanes || "with-mods",
      userDataSeedPath: options.smokeUserDataSeedPath,
      codexHomeSeedPath: options.smokeCodexHomeSeedPath,
    });
    const authenticatedLogsDir = moveRuntimeLogs(pipelineResult.portableOutputDir, "authenticated");
    authenticatedStage = buildStageReport("authenticated", authResult, authenticatedLogsDir);
  }

  const launchabilityStage = buildStageReport("launchability", launchabilityResult, launchabilityLogsDir);
  const report: SmokeRunReport = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    outputDir: pipelineResult.portableOutputDir,
    smokeSeconds: options.smokeSeconds,
    launchability: launchabilityStage,
    authenticated: authenticatedStage,
    success: launchabilityStage.success && (authenticatedStage ? authenticatedStage.success : true),
  };
  const reportPath = path.join(pipelineResult.portableOutputDir, "smoke-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeSuccess(`Smoke report: ${reportPath}`);

  return report.success ? 0 : 1;
}
