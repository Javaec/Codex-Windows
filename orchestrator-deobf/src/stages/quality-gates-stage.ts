import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ChunkArtifactModel } from "../ir/chunk-artifact-model";
import { copyTreeDeterministic } from "../utils/copy-tree";
import { readJsonFile, writeJsonFile, ensureDirectory } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";
import { GateMode, OutputProfile, QualityGatesStageInput, QualityGatesStageOutput } from "../contracts";

interface EmittedFilesIndex {
  files: string[];
}

const GENERIC_PATH_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);
const ARCHETYPE_SEGMENTS = new Set<string>(["hook", "service", "ui", "transport", "store"]);
const INLINE_LITERAL_PAYLOAD_THRESHOLD = 4096;
const INLINE_JSON_PAYLOAD_THRESHOLD = 1800;
const HOT_STORE_NAMESPACE_IMPORT_MAX = 14;
const HOT_SERVICE_RUN_NAMESPACE_IMPORT_MAX = 12;

function validateOutputProfile(profile: OutputProfile): boolean {
  return profile === "latest" || profile === "regression-latest";
}

function validateGateMode(mode: GateMode): boolean {
  return mode === "full" || mode === "light";
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

function validateNoSpeculativeTsModules(files: string[]): string[] {
  const violations: string[] = [];
  for (const relativePath of files) {
    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    if (!normalized.endsWith(".ts")) {
      continue;
    }
    if (normalized.startsWith("coverage/speculative/")) {
      violations.push(`speculative TS modules are not allowed in quality output: ${relativePath}`);
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

function validateArchetypePathDiscipline(files: string[]): string[] {
  const violations: string[] = [];
  for (const relativePath of files) {
    if (!isQualitySourceModule(relativePath)) {
      continue;
    }
    const normalized = relativePath.replace(/\\/g, "/");
    if (normalized.startsWith("src/")) {
      const segments = normalized.split("/");
      if (segments.length < 4) {
        violations.push(`quality module path is too short: ${relativePath}`);
        continue;
      }
      const layer = segments[1];
      const archetype = segments[2];
      if (!layer || !archetype) {
        violations.push(`quality module path is malformed: ${relativePath}`);
        continue;
      }
      if (layer !== "main" && layer !== "renderer" && layer !== "services") {
        violations.push(`unexpected quality layer in path: ${relativePath}`);
        continue;
      }
      if (!ARCHETYPE_SEGMENTS.has(archetype)) {
        violations.push(`quality module must be under archetype directory: ${relativePath}`);
      }
      continue;
    }
    if (normalized.startsWith("src-tauri-adapter/")) {
      const segments = normalized.split("/");
      if (segments.length < 3) {
        violations.push(`tauri quality module path is too short: ${relativePath}`);
        continue;
      }
      const archetype = segments[1];
      if (!archetype) {
        violations.push(`tauri quality module path is malformed: ${relativePath}`);
        continue;
      }
      if (!ARCHETYPE_SEGMENTS.has(archetype)) {
        violations.push(`tauri module must be under archetype directory: ${relativePath}`);
      }
    }
  }
  return violations;
}

async function validateStaticPayloadExtraction(outputProjectDirectory: string, files: string[]): Promise<string[]> {
  const violations: string[] = [];
  const oversizedLiteralPattern = new RegExp(`(["'\`])(?:\\\\.|(?!\\\\1)[\\\\s\\\\S]){${INLINE_LITERAL_PAYLOAD_THRESHOLD},}\\\\1`, "m");
  const oversizedJsonParsePattern = new RegExp(`JSON\\\\.parse\\\\(\\\\s*(["'\`])(?:\\\\.|(?!\\\\1)[\\\\s\\\\S]){${INLINE_JSON_PAYLOAD_THRESHOLD},}\\\\1\\\\s*\\\\)`, "m");
  for (const relativePath of files) {
    if (!isQualitySourceModule(relativePath)) {
      continue;
    }
    const absolutePath = path.join(outputProjectDirectory, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    if (oversizedLiteralPattern.test(content) || oversizedJsonParsePattern.test(content)) {
      violations.push(`quality module contains oversized inline payload (move to assets/payloads): ${relativePath}`);
    }
  }
  return violations;
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

function resolveNamespaceImportLimit(relativePath: string): number {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (/^src\/services\/store\/store-state-g\d+\.ts$/.test(normalized)) {
    return HOT_STORE_NAMESPACE_IMPORT_MAX;
  }
  if (normalized === "src/services/service/service-run.ts") {
    return HOT_SERVICE_RUN_NAMESPACE_IMPORT_MAX;
  }
  return 0;
}

async function validateHotModuleNamespaceImportBudget(outputProjectDirectory: string, files: string[]): Promise<string[]> {
  const violations: string[] = [];
  for (const relativePath of files) {
    const limit = resolveNamespaceImportLimit(relativePath);
    if (limit < 1) {
      continue;
    }
    const absolutePath = path.join(outputProjectDirectory, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const namespaceImportCount = (content.match(/^import\s+\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*\s+from\s+/gm) || []).length;
    if (namespaceImportCount > limit) {
      violations.push(
        `hot-module namespace-import budget exceeded: ${relativePath} (${namespaceImportCount} > ${limit})`,
      );
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
  if (!validateGateMode(input.validationMode)) {
    violations.push(`unsupported quality-gate mode: ${input.validationMode}`);
  }

  violations.push(...validateFileOrdering(emittedFilesIndex.files));
  violations.push(...validateGenericPathNoise(emittedFilesIndex.files));
  violations.push(...validateNoRuntimeJsInSourceTree(emittedFilesIndex.files));
  violations.push(...validateNoSpeculativeTsModules(emittedFilesIndex.files));
  violations.push(...validateArchetypePathDiscipline(emittedFilesIndex.files));
  if (input.validationMode === "full") {
    violations.push(...(await validateNoProxyInQuality(input.outputProjectDirectory, emittedFilesIndex.files)));
    violations.push(...(await validateHotModuleNamespaceImportBudget(input.outputProjectDirectory, emittedFilesIndex.files)));
    violations.push(...(await validateStaticPayloadExtraction(input.outputProjectDirectory, emittedFilesIndex.files)));
  }
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
    validationMode: input.validationMode,
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
    validationMode: input.validationMode,
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
