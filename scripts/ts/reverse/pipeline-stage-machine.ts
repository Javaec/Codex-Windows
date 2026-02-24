import * as fs from "node:fs";

import { writeInfo, writeWarn } from "../lib/exec";
import { parseArgs, printUsage, runReverseStrictPath, type ReverseOptions } from "../reverse-engine";
import {
  DEFAULT_REVERSE_LATEST_DIR,
  normalizePathForComparison,
  prepareStableRunPaths,
  publishStableRun,
} from "./output-discipline";

export type ReverseStageName = "extract" | "parse-lift" | "match" | "semantic-ir" | "emit" | "quality-pass";

export interface StageExecutionEnvelope {
  options: ReverseOptions;
  mode: "strict" | "recovery";
}

export interface ExtractStageDto {
  stage: "extract";
  envelope: StageExecutionEnvelope;
  appDir: string;
  outDir: string;
}

export interface ParseLiftStageDto {
  stage: "parse-lift";
  envelope: StageExecutionEnvelope;
  appDir: string;
  outDir: string;
  noPretty: boolean;
}

export interface MatchStageDto {
  stage: "match";
  envelope: StageExecutionEnvelope;
  appDir: string;
  outDir: string;
  referenceMapPath: string;
}

export interface SemanticIrStageDto {
  stage: "semantic-ir";
  envelope: StageExecutionEnvelope;
  appDir: string;
  outDir: string;
  semanticIrSource: "deobfuscation-table";
}

export interface EmitStageDto {
  stage: "emit";
  envelope: StageExecutionEnvelope;
  options: ReverseOptions;
  exitCode: number;
}

export interface QualityPassStageDto {
  stage: "quality-pass";
  envelope: StageExecutionEnvelope;
  exitCode: number;
  passed: boolean;
}

class StageFailureError extends Error {
  stage: ReverseStageName;

  cause: unknown;

  constructor(stage: ReverseStageName, cause: unknown) {
    const message =
      cause instanceof Error ? cause.message : `Stage '${stage}' failed with non-error cause: ${String(cause)}`;
    super(`Stage '${stage}' failed: ${message}`);
    this.stage = stage;
    this.cause = cause;
  }
}

async function runStage<T>(name: ReverseStageName, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new StageFailureError(name, error);
  }
}

function ensureAppDirExists(appDir: string): void {
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    throw new Error(`App directory not found: ${appDir}`);
  }
}

async function runExtractStage(envelope: StageExecutionEnvelope): Promise<ExtractStageDto> {
  ensureAppDirExists(envelope.options.appDir);
  return {
    stage: "extract",
    envelope,
    appDir: envelope.options.appDir,
    outDir: envelope.options.outDir,
  };
}

async function runParseLiftStage(extractStage: ExtractStageDto): Promise<ParseLiftStageDto> {
  return {
    stage: "parse-lift",
    envelope: extractStage.envelope,
    appDir: extractStage.appDir,
    outDir: extractStage.outDir,
    noPretty: extractStage.envelope.options.noPretty,
  };
}

async function runMatchStage(parseLiftStage: ParseLiftStageDto): Promise<MatchStageDto> {
  return {
    stage: "match",
    envelope: parseLiftStage.envelope,
    appDir: parseLiftStage.appDir,
    outDir: parseLiftStage.outDir,
    referenceMapPath: parseLiftStage.envelope.options.referenceMapPath,
  };
}

async function runSemanticIrStage(matchStage: MatchStageDto): Promise<SemanticIrStageDto> {
  return {
    stage: "semantic-ir",
    envelope: matchStage.envelope,
    appDir: matchStage.appDir,
    outDir: matchStage.outDir,
    semanticIrSource: "deobfuscation-table",
  };
}

async function runEmitStage(semanticIrStage: SemanticIrStageDto): Promise<EmitStageDto> {
  const exitCode = await runReverseStrictPath(semanticIrStage.envelope.options);
  return {
    stage: "emit",
    envelope: semanticIrStage.envelope,
    options: semanticIrStage.envelope.options,
    exitCode,
  };
}

async function runQualityPassStage(emitStage: EmitStageDto): Promise<QualityPassStageDto> {
  const passed = emitStage.exitCode === 0;
  if (!passed) {
    throw new Error(`Emit stage produced non-zero exit code: ${emitStage.exitCode}`);
  }
  return {
    stage: "quality-pass",
    envelope: emitStage.envelope,
    exitCode: emitStage.exitCode,
    passed,
  };
}

async function runPipelineStrict(envelope: StageExecutionEnvelope): Promise<number> {
  const extractStage = await runStage("extract", () => runExtractStage(envelope));
  const parseLiftStage = await runStage("parse-lift", () => runParseLiftStage(extractStage));
  const matchStage = await runStage("match", () => runMatchStage(parseLiftStage));
  const semanticIrStage = await runStage("semantic-ir", () => runSemanticIrStage(matchStage));
  const emitStage = await runStage("emit", () => runEmitStage(semanticIrStage));
  await runStage("quality-pass", () => runQualityPassStage(emitStage));
  return emitStage.exitCode;
}

async function runPipelineWithRecovery(options: ReverseOptions): Promise<number> {
  const strictEnvelope: StageExecutionEnvelope = { options, mode: "strict" };
  try {
    return await runPipelineStrict(strictEnvelope);
  } catch (error) {
    if (
      options.noPretty ||
      !(error instanceof StageFailureError) ||
      (error.stage !== "parse-lift" && error.stage !== "emit")
    ) {
      throw error;
    }
    writeWarn(`[RECOVERY] strict pipeline failed at stage '${error.stage}'. Retrying once with -NoPretty.`);
    const recoveredOptions: ReverseOptions = {
      ...options,
      noPretty: true,
      noClean: false,
    };
    const recoveryEnvelope: StageExecutionEnvelope = {
      options: recoveredOptions,
      mode: "recovery",
    };
    return runPipelineStrict(recoveryEnvelope);
  }
}

export async function runReversePipelineCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }

  const options = parsed.options;
  const latestMode =
    !options.noLatestSync &&
    normalizePathForComparison(options.outDir) === normalizePathForComparison(DEFAULT_REVERSE_LATEST_DIR);
  if (!latestMode) {
    return runPipelineWithRecovery(options);
  }

  const stableRun = prepareStableRunPaths({
    latestDir: options.outDir,
    runsRoot: options.runsRoot,
    keepLastRuns: options.keepLastRuns,
    runId: options.runId,
  });
  const runOptions: ReverseOptions = {
    ...options,
    outDir: stableRun.runDir,
    noClean: false,
  };

  let resultCode = 0;
  let runError: unknown;
  try {
    resultCode = await runPipelineWithRecovery(runOptions);
  } catch (error) {
    runError = error;
  }

  const publishResult = publishStableRun(stableRun);
  writeInfo(`Stable latest synced: ${stableRun.latestDir.replace(/\\/g, "/")} (run=${stableRun.runId})`);
  if (publishResult.removedRuns.length > 0) {
    writeInfo(`Stable run cleanup: removed ${publishResult.removedRuns.length} archived runs`);
  }

  if (runError) throw runError;
  return resultCode;
}
