import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { StageId } from "../contracts";
import { ensureDirectory, writeJsonFile, readJsonFile } from "../utils/fs-json";
import { copyTreeDeterministic } from "../utils/copy-tree";

export interface StageExecutionRequest {
  inputPath: string;
  outputPath: string;
  stageDirectory: string;
  runDirectory: string;
}

export interface StageCacheArtifact {
  kind: "file" | "directory";
  path: string;
}

export interface StageCachePlan<TInput> {
  version: number;
  key(input: TInput): Promise<string> | string;
  artifacts(input: TInput): StageCacheArtifact[];
  rehydrateOutput?(input: TInput): Promise<unknown> | unknown;
}

export interface PipelineStage {
  id: StageId;
  execute(request: StageExecutionRequest): Promise<void>;
  cachePlan?: StageCachePlan<unknown>;
}

export interface RunStageOptions {
  cacheEnabled: boolean;
}

function hashCacheKey(stageId: StageId, version: number, key: string): string {
  return createHash("sha1").update(stageId).update("|").update(String(version)).update("|").update(key).digest("hex");
}

function stageCacheRoot(runDirectory: string): string {
  const projectRoot = path.resolve(runDirectory, "..", "..");
  return path.join(projectRoot, ".cache", "stage-cache");
}

async function pathExists(targetPath: string): Promise<boolean> {
  return await fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function restoreArtifact(artifact: StageCacheArtifact, sourcePath: string): Promise<void> {
  if (artifact.kind === "directory") {
    await copyTreeDeterministic(sourcePath, artifact.path);
    return;
  }
  await ensureDirectory(path.dirname(artifact.path));
  await fs.copyFile(sourcePath, artifact.path);
}

async function saveArtifact(artifact: StageCacheArtifact, destinationPath: string): Promise<void> {
  if (artifact.kind === "directory") {
    await copyTreeDeterministic(artifact.path, destinationPath);
    return;
  }
  await ensureDirectory(path.dirname(destinationPath));
  await fs.copyFile(artifact.path, destinationPath);
}

async function tryRestoreFromCache<TInput>(
  stage: PipelineStage,
  stageInput: TInput,
  runDirectory: string,
  outputPath: string,
): Promise<boolean> {
  const cachePlan = stage.cachePlan as StageCachePlan<TInput> | undefined;
  if (!cachePlan) {
    return false;
  }

  const key = await cachePlan.key(stageInput);
  const cacheHash = hashCacheKey(stage.id, cachePlan.version, key);
  const cacheDirectory = path.join(stageCacheRoot(runDirectory), stage.id, cacheHash);
  const cachedOutputPath = path.join(cacheDirectory, "output.json");
  if (!(await pathExists(cachedOutputPath))) {
    return false;
  }

  const artifacts = cachePlan.artifacts(stageInput);
  for (let index = 0; index < artifacts.length; index += 1) {
    const sourcePath = path.join(cacheDirectory, "artifacts", String(index));
    if (!(await pathExists(sourcePath))) {
      return false;
    }
  }

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!artifact) {
      continue;
    }
    const sourcePath = path.join(cacheDirectory, "artifacts", String(index));
    await restoreArtifact(artifact, sourcePath);
  }

  if (cachePlan.rehydrateOutput) {
    const hydratedOutput = await cachePlan.rehydrateOutput(stageInput);
    await writeJsonFile(outputPath, hydratedOutput);
    return true;
  }

  await ensureDirectory(path.dirname(outputPath));
  await fs.copyFile(cachedOutputPath, outputPath);

  return true;
}

async function saveToCache<TInput>(
  stage: PipelineStage,
  stageInput: TInput,
  runDirectory: string,
  outputPath: string,
): Promise<void> {
  const cachePlan = stage.cachePlan as StageCachePlan<TInput> | undefined;
  if (!cachePlan) {
    return;
  }

  const key = await cachePlan.key(stageInput);
  const cacheHash = hashCacheKey(stage.id, cachePlan.version, key);
  const cacheDirectory = path.join(stageCacheRoot(runDirectory), stage.id, cacheHash);
  const tempDirectory = `${cacheDirectory}.tmp-${Date.now()}-${process.pid}`;

  await fs.rm(tempDirectory, { recursive: true, force: true });
  await ensureDirectory(path.join(tempDirectory, "artifacts"));
  await fs.copyFile(outputPath, path.join(tempDirectory, "output.json"));

  const artifacts = cachePlan.artifacts(stageInput);
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!artifact) {
      continue;
    }
    const exists = await pathExists(artifact.path);
    if (!exists) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
      return;
    }
    await saveArtifact(artifact, path.join(tempDirectory, "artifacts", String(index)));
  }

  await fs.rm(cacheDirectory, { recursive: true, force: true });
  await ensureDirectory(path.dirname(cacheDirectory));
  await fs.rename(tempDirectory, cacheDirectory);
}

export async function runStage<TInput, TOutput>(
  stage: PipelineStage,
  stageInput: TInput,
  runDirectory: string,
  options: RunStageOptions = { cacheEnabled: true },
): Promise<TOutput> {
  const stageDirectory = path.join(runDirectory, "stages", stage.id);
  await ensureDirectory(stageDirectory);

  const inputPath = path.join(stageDirectory, "input.json");
  const outputPath = path.join(stageDirectory, "output.json");
  await fs.rm(outputPath, { force: true });
  await writeJsonFile(inputPath, stageInput);

  if (options.cacheEnabled) {
    const restored = await tryRestoreFromCache(stage, stageInput, runDirectory, outputPath);
    if (restored) {
      return await readJsonFile<TOutput>(outputPath);
    }
  }

  await stage.execute({
    inputPath,
    outputPath,
    stageDirectory,
    runDirectory,
  });

  if (options.cacheEnabled) {
    await saveToCache(stage, stageInput, runDirectory, outputPath);
  }

  return await readJsonFile<TOutput>(outputPath);
}
