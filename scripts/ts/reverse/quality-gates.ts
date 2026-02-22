import * as fs from "node:fs";
import * as path from "node:path";

import type { DeobfuscationTableReport } from "./match-v2";
import type { WebStormTestProjectReport } from "./webstorm-project";
import { REVERSE_QUALITY_GATE_TARGETS } from "./regression-config";

interface ChunkArtifactRow {
  sourceFile: string;
  artifactPath: string;
}

interface ReconstructedMapRow {
  emittedPath: string;
  sourceFile: string;
  chunkArtifactPath: string;
}

interface MappedSymbolsHistoryRow {
  mappedSymbols: number;
  updatedAtUtc: string;
  outDir: string;
}

interface MappedSymbolsHistory {
  version: number;
  byApp: Record<string, MappedSymbolsHistoryRow>;
}

export interface QualityGateInput {
  repoRoot: string;
  appDir: string;
  outDir: string;
  projectRoot: string;
  deobfuscationTable: DeobfuscationTableReport;
  projectChecks: WebStormTestProjectReport["checks"];
}

export interface QualityGateReport {
  generatedAtUtc: string;
  profile: string;
  passed: boolean;
  metrics: {
    mappedFiles: number;
    mappedSymbols: number;
    previousMappedSymbols: number;
    genericNoisePaths: string[];
    installSuccess: boolean;
    tscErrors: number;
    eslintErrors: number;
    eslintWarnings: number;
    chunkArtifactRows: number;
    chunkArtifactUniqueSource: number;
    chunkArtifactUniqueArtifact: number;
    reconstructedRows: number;
  };
  targets: {
    mappedFilesMin: number;
    mappedFilesMax: number;
    allowedTargetPrefixes: string[];
  };
  failures: string[];
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readUtf8(filePath)) as T;
}

function resolveHistoryPath(repoRoot: string): string {
  return path.resolve(repoRoot, REVERSE_QUALITY_GATE_TARGETS.mappedSymbolsHistoryFile);
}

function loadMappedSymbolsHistory(historyPath: string): MappedSymbolsHistory {
  if (!fs.existsSync(historyPath)) {
    return { version: 1, byApp: {} };
  }
  const parsed = readJson<MappedSymbolsHistory>(historyPath);
  if (parsed.version !== 1 || typeof parsed.byApp !== "object" || Array.isArray(parsed.byApp)) {
    throw new Error(`Invalid mapped-symbols history format: ${toPosixPath(historyPath)}`);
  }
  return parsed;
}

function saveMappedSymbolsHistory(historyPath: string, history: MappedSymbolsHistory): void {
  writeJson(historyPath, history);
}

function normalizeAppHistoryKey(appDir: string): string {
  return toPosixPath(path.resolve(appDir)).toLowerCase();
}

function loadProjectMappingRows(projectRoot: string): {
  chunkArtifacts: ChunkArtifactRow[];
  reconstructed: ReconstructedMapRow[];
} {
  const chunkArtifactsPath = path.join(projectRoot, "mapping", "chunk-artifacts.json");
  const reconstructedMapPath = path.join(projectRoot, "mapping", "reconstructed-map.json");
  if (!fs.existsSync(chunkArtifactsPath)) {
    throw new Error(`Missing chunk artifact map: ${toPosixPath(chunkArtifactsPath)}`);
  }
  if (!fs.existsSync(reconstructedMapPath)) {
    throw new Error(`Missing reconstructed map: ${toPosixPath(reconstructedMapPath)}`);
  }
  return {
    chunkArtifacts: readJson<ChunkArtifactRow[]>(chunkArtifactsPath),
    reconstructed: readJson<ReconstructedMapRow[]>(reconstructedMapPath),
  };
}

function isGenericNoisePath(value: string): boolean {
  const normalized = toPosixPath(value).replace(/^\.?\//, "");
  const generic = new Set(REVERSE_QUALITY_GATE_TARGETS.genericPathNoiseSegments.map((item) => item.toLowerCase()));
  const ext = path.posix.extname(normalized).toLowerCase();
  const stem = path.posix.basename(normalized, ext).toLowerCase();
  if (generic.has(stem)) return true;
  const segments = normalized.split("/").map((segment) => segment.toLowerCase());
  for (const segment of segments) {
    if (generic.has(segment)) return true;
  }
  return false;
}

function hasAllowedTargetPrefix(value: string): boolean {
  const normalized = toPosixPath(value).replace(/^\.?\//, "");
  return REVERSE_QUALITY_GATE_TARGETS.allowedTargetPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function validateChunkArtifacts(
  projectRoot: string,
  chunkArtifacts: ChunkArtifactRow[],
  reconstructed: ReconstructedMapRow[],
): { failures: string[]; genericNoisePaths: string[]; uniqueSource: number; uniqueArtifact: number } {
  const failures: string[] = [];
  const genericNoisePaths: string[] = [];

  const sourceSet = new Set<string>();
  const artifactSet = new Set<string>();
  for (const row of chunkArtifacts) {
    sourceSet.add(row.sourceFile);
    artifactSet.add(row.artifactPath);
  }
  if (sourceSet.size !== chunkArtifacts.length) {
    failures.push("chunk-artifacts contains duplicate sourceFile rows");
  }
  if (artifactSet.size !== chunkArtifacts.length) {
    failures.push("chunk-artifacts contains duplicate artifactPath rows");
  }

  const artifactBySource = new Map<string, string>();
  for (const row of chunkArtifacts) artifactBySource.set(row.sourceFile, row.artifactPath);
  for (const row of reconstructed) {
    if (!hasAllowedTargetPrefix(row.emittedPath)) {
      failures.push(`reconstructed target outside TS-first layers: ${row.emittedPath}`);
    }
    if (isGenericNoisePath(row.emittedPath)) genericNoisePaths.push(row.emittedPath);
    const expectedArtifact = artifactBySource.get(row.sourceFile);
    if (!expectedArtifact) {
      failures.push(`reconstructed map references unknown source chunk: ${row.sourceFile}`);
      continue;
    }
    if (toPosixPath(expectedArtifact) !== toPosixPath(row.chunkArtifactPath)) {
      failures.push(`chunk artifact mismatch for ${row.sourceFile}`);
    }
    const emittedAbsPath = path.join(projectRoot, row.emittedPath);
    if (!fs.existsSync(emittedAbsPath) || !fs.statSync(emittedAbsPath).isFile()) {
      failures.push(`missing reconstructed module file: ${toPosixPath(emittedAbsPath)}`);
      continue;
    }
    const source = readUtf8(emittedAbsPath);
    if (!source.includes("import * as chunkModule from")) {
      failures.push(`reconstructed module is not a wrapper import: ${row.emittedPath}`);
    }
    if (!source.includes("export default chunk;")) {
      failures.push(`reconstructed module is missing wrapper default export: ${row.emittedPath}`);
    }
  }

  return {
    failures,
    genericNoisePaths: Array.from(new Set(genericNoisePaths)).sort((a, b) => a.localeCompare(b)),
    uniqueSource: sourceSet.size,
    uniqueArtifact: artifactSet.size,
  };
}

export function enforceQualityGates(input: QualityGateInput): QualityGateReport {
  const failures: string[] = [];
  const mappedFiles = input.deobfuscationTable.coverage.mappedFiles;
  const mappedSymbols = input.deobfuscationTable.coverage.mappedSymbols;
  if (mappedFiles < REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin || mappedFiles > REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax) {
    failures.push(
      `mappedFiles out of gate range: ${mappedFiles} (expected ${REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin}-${REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax})`,
    );
  }

  if (!input.projectChecks.install.success) {
    failures.push("generated project gate failed: npm install is not successful");
  }
  if (input.projectChecks.tsc.errors > 0) {
    failures.push(`generated project gate failed: tsc errors=${input.projectChecks.tsc.errors}`);
  }
  if (input.projectChecks.eslint.errors > 0 || input.projectChecks.eslint.warnings > 0) {
    failures.push(
      `generated project gate failed: eslint errors=${input.projectChecks.eslint.errors}, warnings=${input.projectChecks.eslint.warnings}`,
    );
  }

  const historyPath = resolveHistoryPath(input.repoRoot);
  const appKey = normalizeAppHistoryKey(input.appDir);
  const history = loadMappedSymbolsHistory(historyPath);
  const previousMappedSymbols = history.byApp[appKey]?.mappedSymbols ?? 0;
  if (previousMappedSymbols > 0 && mappedSymbols < previousMappedSymbols) {
    failures.push(`mappedSymbols regression: ${mappedSymbols} < previous ${previousMappedSymbols}`);
  }

  const mappingRows = loadProjectMappingRows(input.projectRoot);
  const artifactValidation = validateChunkArtifacts(
    input.projectRoot,
    mappingRows.chunkArtifacts,
    mappingRows.reconstructed,
  );
  failures.push(...artifactValidation.failures);
  if (artifactValidation.genericNoisePaths.length > 0) {
    failures.push(
      `generic-path noise detected in reconstructed outputs: ${artifactValidation.genericNoisePaths.join(", ")}`,
    );
  }

  const report: QualityGateReport = {
    generatedAtUtc: new Date().toISOString(),
    profile: "reverse-quality-gates-v1",
    passed: failures.length === 0,
    metrics: {
      mappedFiles,
      mappedSymbols,
      previousMappedSymbols,
      genericNoisePaths: artifactValidation.genericNoisePaths,
      installSuccess: input.projectChecks.install.success,
      tscErrors: input.projectChecks.tsc.errors,
      eslintErrors: input.projectChecks.eslint.errors,
      eslintWarnings: input.projectChecks.eslint.warnings,
      chunkArtifactRows: mappingRows.chunkArtifacts.length,
      chunkArtifactUniqueSource: artifactValidation.uniqueSource,
      chunkArtifactUniqueArtifact: artifactValidation.uniqueArtifact,
      reconstructedRows: mappingRows.reconstructed.length,
    },
    targets: {
      mappedFilesMin: REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin,
      mappedFilesMax: REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax,
      allowedTargetPrefixes: [...REVERSE_QUALITY_GATE_TARGETS.allowedTargetPrefixes],
    },
    failures,
  };

  if (!report.passed) {
    return report;
  }

  history.byApp[appKey] = {
    mappedSymbols,
    updatedAtUtc: report.generatedAtUtc,
    outDir: toPosixPath(path.resolve(input.outDir)),
  };
  saveMappedSymbolsHistory(historyPath, history);
  return report;
}
