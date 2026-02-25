import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ChunkArtifactModel } from "../ir/chunk-artifact-model";
import { copyTreeDeterministic } from "../utils/copy-tree";
import { readJsonFile, writeJsonFile, ensureDirectory } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";
import { OutputProfile, QualityGatesStageInput, QualityGatesStageOutput } from "../contracts";

interface EmittedFilesIndex {
  files: string[];
}

const GENERIC_PATH_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);

function validateOutputProfile(profile: OutputProfile): boolean {
  return profile === "latest" || profile === "regression-latest";
}

function validateFileOrdering(files: string[]): string[] {
  const violations: string[] = [];
  const sorted = [...files].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < files.length; index += 1) {
    if (files[index] !== sorted[index]) {
      violations.push("emitted-files index is not sorted deterministically");
      break;
    }
  }
  const unique = new Set(files);
  if (unique.size !== files.length) {
    violations.push("emitted-files index contains duplicates");
  }
  return violations;
}

function validateGenericPathNoise(files: string[]): string[] {
  const violations: string[] = [];
  for (const relativePath of files) {
    const segments = relativePath.split("/");
    for (const segment of segments) {
      const lower = segment.replace(/\.[^.]+$/, "").toLowerCase();
      if (GENERIC_PATH_SEGMENTS.has(lower)) {
        violations.push(`generic path segment blocked: ${relativePath}`);
      }
    }
  }
  return violations;
}

function validateNoRuntimeJsInSourceTree(files: string[]): string[] {
  const violations: string[] = [];
  for (const relativePath of files) {
    const lower = relativePath.toLowerCase();
    const isSourceTree = lower.startsWith("src/") || lower.startsWith("src-tauri-adapter/");
    if (!isSourceTree) {
      continue;
    }
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
      violations.push(`source tree must be TS-only before build: ${relativePath}`);
    }
  }
  return violations;
}

function isQualitySourceModule(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".ts")) {
    return false;
  }
  if (normalized.startsWith("src/main/")) {
    return true;
  }
  if (normalized.startsWith("src/renderer/")) {
    return true;
  }
  if (normalized.startsWith("src/services/")) {
    return true;
  }
  if (normalized.startsWith("src-tauri-adapter/")) {
    return true;
  }
  return false;
}

async function validateNoProxyInQuality(outputProjectDirectory: string, files: string[]): Promise<string[]> {
  const violations: string[] = [];
  const proxyPatterns = [
    "resolveSymbol(",
    "moduleContract =",
    "createHookModuleContract(",
    "createServiceModuleContract(",
    "createUiModuleContract(",
    "createTransportModuleContract(",
    "createStoreModuleContract(",
    "runtime/chunk-runtime.js",
    "runtime/module-contracts.js",
  ];

  for (const relativePath of files) {
    if (!isQualitySourceModule(relativePath)) {
      continue;
    }
    const absolutePath = path.join(outputProjectDirectory, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    for (const token of proxyPatterns) {
      if (!content.includes(token)) {
        continue;
      }
      violations.push(`no-proxy-in-quality gate blocked ${relativePath} (token: ${token})`);
      break;
    }
  }
  return violations;
}

function validateChunkArtifacts(chunkArtifacts: ChunkArtifactModel): string[] {
  const violations: string[] = [];
  const sourcePaths = new Set<string>();
  const chunkIds = new Set<string>();
  for (const chunk of chunkArtifacts.chunks) {
    if (sourcePaths.has(chunk.sourceFilePath)) {
      violations.push(`chunk-artifacts duplicates source file: ${chunk.sourceFilePath}`);
    }
    sourcePaths.add(chunk.sourceFilePath);
    if (chunkIds.has(chunk.chunkId)) {
      violations.push(`chunk-artifacts duplicates chunk id: ${chunk.chunkId}`);
    }
    chunkIds.add(chunk.chunkId);
  }
  for (const mapping of chunkArtifacts.symbolMappings) {
    if (!chunkIds.has(mapping.chunkId)) {
      violations.push(`symbol mapping references missing chunk: ${mapping.symbolKey} -> ${mapping.chunkId}`);
    }
  }
  return violations;
}

async function executeQualityGates(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<QualityGatesStageInput>(request.inputPath);
  const chunkArtifacts = await readJsonFile<ChunkArtifactModel>(input.chunkArtifactsPath);
  const emittedFilesIndex = await readJsonFile<EmittedFilesIndex>(input.emittedFilesIndexPath);

  const violations: string[] = [];
  if (!validateOutputProfile(input.stableOutputProfile)) {
    violations.push(`unsupported output profile: ${input.stableOutputProfile}`);
  }

  violations.push(...validateFileOrdering(emittedFilesIndex.files));
  violations.push(...validateGenericPathNoise(emittedFilesIndex.files));
  violations.push(...validateNoRuntimeJsInSourceTree(emittedFilesIndex.files));
  violations.push(...(await validateNoProxyInQuality(input.outputProjectDirectory, emittedFilesIndex.files)));
  violations.push(...validateChunkArtifacts(chunkArtifacts));

  const stableProfileDirectory = path.join(input.stableOutputRoot, input.stableOutputProfile);
  const stableProjectDirectory = path.join(stableProfileDirectory, "project");
  const stableChunkArtifactsPath = path.join(stableProfileDirectory, "chunk-artifacts.json");
  const stableEmittedFilesPath = path.join(stableProfileDirectory, "emitted-files.json");

  if (violations.length === 0) {
    await ensureDirectory(stableProfileDirectory);
    await copyTreeDeterministic(input.outputProjectDirectory, stableProjectDirectory);
    await writeJsonFile(stableChunkArtifactsPath, chunkArtifacts);
    await writeJsonFile(stableEmittedFilesPath, emittedFilesIndex);
  }

  const report = {
    generatedAtIso: new Date().toISOString(),
    passed: violations.length === 0,
    checkedFileCount: emittedFilesIndex.files.length,
    violations,
    stableProjectDirectory,
  };
  await writeJsonFile(input.qualityReportPath, report);

  if (violations.length > 0) {
    throw new Error(`Quality gates failed:\n${violations.join("\n")}`);
  }

  const output: QualityGatesStageOutput = {
    qualityReportPath: input.qualityReportPath,
    passed: true,
    checkedFileCount: emittedFilesIndex.files.length,
    violations: [],
    stableProjectDirectory,
  };
  await writeJsonFile(request.outputPath, output);
}

export const qualityGatesStage: PipelineStage = {
  id: "quality-gates",
  execute: executeQualityGates,
};
