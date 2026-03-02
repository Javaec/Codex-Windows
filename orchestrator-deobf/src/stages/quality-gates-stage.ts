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

interface StructureContractRule {
  root: string;
  regex: string;
  description: string;
}

interface StructureContractHotFileLimit {
  maxLines: number;
  maxNamespaceImports: number;
  minLiftedCoverage: number;
}

interface StructureContractHotFileLimitOverride {
  pattern: string;
  maxLines?: number;
  maxNamespaceImports?: number;
  minLiftedCoverage?: number;
}

interface CodexMonitorStructureContract {
  version: number;
  genericPathSegments: string[];
  genericPathAllowlist: string[];
  domainSourceRoots: string[];
  allowedSourceFiles: string[];
  forbiddenTechnicalPrefixes: string[];
  forbiddenPathSegments: string[];
  archetypePathRules: StructureContractRule[];
  hotFileLimits: {
    targetMin: number;
    targetMax: number;
    defaults: StructureContractHotFileLimit;
    overrides: StructureContractHotFileLimitOverride[];
  };
}

interface FileQualityEntrySnapshot {
  filePath: string;
  liftedCoverage: number;
  hotFocus?: boolean;
}

interface FileQualityReportSnapshot {
  files: FileQualityEntrySnapshot[];
}

const INLINE_LITERAL_PAYLOAD_THRESHOLD = 4096;
const INLINE_JSON_PAYLOAD_THRESHOLD = 1800;

function validateOutputProfile(profile: OutputProfile): boolean {
  return profile === "latest" || profile === "regression-latest";
}

function validateGateMode(mode: GateMode): boolean {
  return mode === "full" || mode === "light";
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function toLowerSet(values: readonly string[]): Set<string> {
  return new Set(values.map((entry) => normalizeRelativePath(entry).toLowerCase()));
}

function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid structure contract value for ${name}: ${String(value)}`);
  }
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPathPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath).toLowerCase();
  const normalizedPattern = pattern.trim();
  if (normalizedPattern.length < 1) {
    return false;
  }
  if (normalizedPattern.startsWith("regex:")) {
    const source = normalizedPattern.slice("regex:".length);
    const regex = new RegExp(source, "i");
    return regex.test(normalizedPath);
  }
  return globPatternToRegExp(normalizedPattern.toLowerCase()).test(normalizedPath);
}

function validateStructureContractModel(contract: CodexMonitorStructureContract): void {
  if (contract.version !== 1) {
    throw new Error(`unsupported structure contract version: ${String(contract.version)}`);
  }
  if (!Array.isArray(contract.domainSourceRoots) || contract.domainSourceRoots.length < 1) {
    throw new Error("structure contract: domainSourceRoots must be non-empty");
  }
  if (!Array.isArray(contract.archetypePathRules) || contract.archetypePathRules.length < 1) {
    throw new Error("structure contract: archetypePathRules must be non-empty");
  }
  assertPositiveNumber("hotFileLimits.targetMin", contract.hotFileLimits.targetMin);
  assertPositiveNumber("hotFileLimits.targetMax", contract.hotFileLimits.targetMax);
  if (contract.hotFileLimits.targetMin > contract.hotFileLimits.targetMax) {
    throw new Error("structure contract: hotFileLimits.targetMin must be <= targetMax");
  }
  assertPositiveNumber("hotFileLimits.defaults.maxLines", contract.hotFileLimits.defaults.maxLines);
  assertPositiveNumber("hotFileLimits.defaults.maxNamespaceImports", contract.hotFileLimits.defaults.maxNamespaceImports);
  if (
    !Number.isFinite(contract.hotFileLimits.defaults.minLiftedCoverage) ||
    contract.hotFileLimits.defaults.minLiftedCoverage < 0 ||
    contract.hotFileLimits.defaults.minLiftedCoverage > 1
  ) {
    throw new Error("structure contract: hotFileLimits.defaults.minLiftedCoverage must be within [0..1]");
  }
  for (const rule of contract.archetypePathRules) {
    if (!rule.root || !rule.regex || !rule.description) {
      throw new Error("structure contract: archetypePathRules entries must define root/regex/description");
    }
    new RegExp(rule.regex, "i");
  }
  for (const override of contract.hotFileLimits.overrides) {
    if (!override.pattern || override.pattern.trim().length < 1) {
      throw new Error("structure contract: hotFileLimits.overrides.pattern is required");
    }
    matchesPathPattern("src/services/store/sample.ts", override.pattern);
    if (typeof override.maxLines === "number") {
      assertPositiveNumber("hotFileLimits.overrides.maxLines", override.maxLines);
    }
    if (typeof override.maxNamespaceImports === "number") {
      assertPositiveNumber("hotFileLimits.overrides.maxNamespaceImports", override.maxNamespaceImports);
    }
    if (typeof override.minLiftedCoverage === "number") {
      if (override.minLiftedCoverage < 0 || override.minLiftedCoverage > 1) {
        throw new Error("structure contract: hotFileLimits.overrides.minLiftedCoverage must be within [0..1]");
      }
    }
  }
}

async function loadStructureContract(contractPath: string): Promise<CodexMonitorStructureContract> {
  const exists = await fs
    .stat(contractPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`missing structure contract: ${contractPath}`);
  }
  const contract = await readJsonFile<CodexMonitorStructureContract>(contractPath);
  validateStructureContractModel(contract);
  return contract;
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

function validateGenericPathNoise(files: string[], contract: CodexMonitorStructureContract): string[] {
  const violations: string[] = [];
  const genericSegments = new Set(contract.genericPathSegments.map((entry) => entry.toLowerCase()));
  const allowlist = toLowerSet(contract.genericPathAllowlist);
  for (const relativePath of files) {
    const normalizedPath = normalizeRelativePath(relativePath).toLowerCase();
    if (allowlist.has(normalizedPath)) {
      continue;
    }
    const segments = normalizeRelativePath(relativePath).split("/");
    for (const segment of segments) {
      const lower = segment.replace(/\.[^.]+$/, "").toLowerCase();
      if (genericSegments.has(lower)) {
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

function validateNoTechnicalLayerInSource(files: string[], contract: CodexMonitorStructureContract): string[] {
  const violations: string[] = [];
  const forbiddenPrefixes = contract.forbiddenTechnicalPrefixes.map((entry) => normalizeRelativePath(entry).toLowerCase());
  for (const relativePath of files) {
    const normalized = normalizeRelativePath(relativePath).toLowerCase();
    for (const forbiddenPrefix of forbiddenPrefixes) {
      if (normalized.startsWith(forbiddenPrefix)) {
        violations.push(`technical layer is not allowed in source tree: ${relativePath}`);
        break;
      }
    }
  }
  return violations;
}

function validateStrictDomainSourceStructure(files: string[], contract: CodexMonitorStructureContract): string[] {
  const violations: string[] = [];
  const allowlist = toLowerSet(contract.allowedSourceFiles);
  const domainRoots = contract.domainSourceRoots.map((entry) => normalizeRelativePath(entry).toLowerCase());
  for (const relativePath of files) {
    const normalized = normalizeRelativePath(relativePath);
    const lower = normalized.toLowerCase();
    if (allowlist.has(lower)) {
      continue;
    }
    const isInDomainRoot = domainRoots.some((root) => lower.startsWith(root));
    if (isInDomainRoot) {
      continue;
    }
    if (!lower.startsWith("src/") && !lower.startsWith("src-tauri-adapter/")) {
      continue;
    }
    violations.push(`strict structural gate blocked non-domain source path: ${relativePath}`);
  }
  return violations;
}

function validateTechnicalSegmentsInDomainPaths(files: string[], contract: CodexMonitorStructureContract): string[] {
  const violations: string[] = [];
  const forbiddenSegments = new Set(contract.forbiddenPathSegments.map((entry) => entry.toLowerCase()));
  for (const relativePath of files) {
    if (!isQualitySourceModule(relativePath)) {
      continue;
    }
    const segments = normalizeRelativePath(relativePath)
      .toLowerCase()
      .split("/")
      .map((segment) => segment.replace(/\.[^.]+$/, ""));
    for (const segment of segments) {
      if (!forbiddenSegments.has(segment)) {
        continue;
      }
      violations.push(`strict structural gate blocked technical segment in domain path: ${relativePath}`);
      break;
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

function validateArchetypePathDiscipline(
  files: string[],
  contract: CodexMonitorStructureContract,
): string[] {
  const violations: string[] = [];
  const compiledRules = contract.archetypePathRules.map((rule) => ({
    root: normalizeRelativePath(rule.root).toLowerCase(),
    regex: new RegExp(rule.regex, "i"),
    description: rule.description,
  }));
  for (const relativePath of files) {
    if (!isQualitySourceModule(relativePath)) {
      continue;
    }
    const normalized = normalizeRelativePath(relativePath);
    const lower = normalized.toLowerCase();
    const matchedRule = compiledRules.find((rule) => lower.startsWith(rule.root));
    if (!matchedRule) {
      continue;
    }
    if (!matchedRule.regex.test(normalized)) {
      violations.push(`${matchedRule.description}: ${relativePath}`);
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

function resolveHotFileLimitRule(
  relativePath: string,
  contract: CodexMonitorStructureContract,
): StructureContractHotFileLimit {
  const defaults = contract.hotFileLimits.defaults;
  for (const override of contract.hotFileLimits.overrides) {
    if (!matchesPathPattern(relativePath, override.pattern)) {
      continue;
    }
    return {
      maxLines: typeof override.maxLines === "number" ? Math.trunc(override.maxLines) : defaults.maxLines,
      maxNamespaceImports: typeof override.maxNamespaceImports === "number"
        ? Math.trunc(override.maxNamespaceImports)
        : defaults.maxNamespaceImports,
      minLiftedCoverage: typeof override.minLiftedCoverage === "number"
        ? Number(override.minLiftedCoverage.toFixed(4))
        : defaults.minLiftedCoverage,
    };
  }
  return {
    maxLines: Math.trunc(defaults.maxLines),
    maxNamespaceImports: Math.trunc(defaults.maxNamespaceImports),
    minLiftedCoverage: Number(defaults.minLiftedCoverage.toFixed(4)),
  };
}

async function validateHotFileLimits(
  outputProjectDirectory: string,
  fileQualityReport: FileQualityReportSnapshot,
  contract: CodexMonitorStructureContract,
): Promise<string[]> {
  const violations: string[] = [];
  const hotFiles = fileQualityReport.files.filter((entry) => entry.hotFocus === true);
  const hotCount = hotFiles.length;
  if (hotCount < contract.hotFileLimits.targetMin) {
    violations.push(
      `hot file target underflow: ${hotCount} < ${contract.hotFileLimits.targetMin}`,
    );
  }
  if (hotCount > contract.hotFileLimits.targetMax) {
    violations.push(
      `hot file target overflow: ${hotCount} > ${contract.hotFileLimits.targetMax}`,
    );
  }
  for (const hotFile of hotFiles) {
    const relativePath = normalizeRelativePath(hotFile.filePath);
    const limit = resolveHotFileLimitRule(relativePath, contract);
    const absolutePath = path.join(outputProjectDirectory, relativePath);
    const exists = await fs
      .stat(absolutePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      violations.push(`hot file missing in output project: ${relativePath}`);
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > limit.maxLines) {
      violations.push(`hot-file max-lines exceeded: ${relativePath} (${lineCount} > ${limit.maxLines})`);
    }
    const namespaceImportCount = (content.match(/^import\s+\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*\s+from\s+/gm) || []).length;
    if (namespaceImportCount > limit.maxNamespaceImports) {
      violations.push(
        `hot-file namespace-import budget exceeded: ${relativePath} (${namespaceImportCount} > ${limit.maxNamespaceImports})`,
      );
    }
    if (hotFile.liftedCoverage < limit.minLiftedCoverage) {
      violations.push(
        `hot-file min lifted coverage violated: ${relativePath} (${hotFile.liftedCoverage} < ${limit.minLiftedCoverage})`,
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
  const structureContract = await loadStructureContract(input.structureContractPath);
  const fileQualityReport = await readJsonFile<FileQualityReportSnapshot>(input.fileQualityReportPath);

  const violations: string[] = [];
  if (!validateOutputProfile(input.stableOutputProfile)) {
    violations.push(`unsupported output profile: ${input.stableOutputProfile}`);
  }
  if (!validateGateMode(input.validationMode)) {
    violations.push(`unsupported quality-gate mode: ${input.validationMode}`);
  }

  violations.push(...validateFileOrdering(emittedFilesIndex.files));
  violations.push(...validateGenericPathNoise(emittedFilesIndex.files, structureContract));
  violations.push(...validateNoRuntimeJsInSourceTree(emittedFilesIndex.files));
  violations.push(...validateNoSpeculativeTsModules(emittedFilesIndex.files));
  violations.push(...validateNoTechnicalLayerInSource(emittedFilesIndex.files, structureContract));
  violations.push(...validateStrictDomainSourceStructure(emittedFilesIndex.files, structureContract));
  violations.push(...validateTechnicalSegmentsInDomainPaths(emittedFilesIndex.files, structureContract));
  violations.push(...validateArchetypePathDiscipline(emittedFilesIndex.files, structureContract));
  violations.push(...(await validateHotFileLimits(input.outputProjectDirectory, fileQualityReport, structureContract)));
  if (input.validationMode === "full") {
    violations.push(...(await validateNoProxyInQuality(input.outputProjectDirectory, emittedFilesIndex.files)));
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
