import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { EvidenceSourceFile } from "../contracts";

export type EvidenceKind = "file_hint" | "symbol_hint" | "call_edge" | "state_key" | "source_map";

export interface EvidenceProvenance {
  tool: string;
  stageId: string;
  sourceFilePath: string;
  lineageId: string;
}

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  owner: string;
  anchor: string;
  value: string;
  confidence: number;
  provenance: EvidenceProvenance;
}

export interface EvidenceStats {
  totalRecords: number;
  fileHintCount: number;
  symbolHintCount: number;
  callEdgeCount: number;
  stateKeyCount: number;
  sourceMapCount: number;
}

export interface EvidenceStoreModel {
  version: number;
  generatedAtIso: string;
  records: EvidenceRecord[];
  stats: EvidenceStats;
}

interface MonolithCensusSeedEntry {
  anchor: string;
  censusName: string;
}

interface MonolithCensusVariableEntry {
  variableKey: string;
  censusName: string;
}

interface MonolithCensusMappingModel {
  seedEntries?: MonolithCensusSeedEntry[];
  variableCoverage?: MonolithCensusVariableEntry[];
}

const COVERAGE_OWNER_SUFFIX = "-census";
const COVERAGE_VARIABLE_LIMIT = 3200;
const COVERAGE_RECORD_BUDGET_FACTOR = 0.5;

const RESERVED_WORDS = new Set<string>([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "throw",
  "new",
  "typeof",
  "await",
  "function",
  "class",
  "var",
  "let",
  "const",
  "else",
  "do",
  "try",
]);

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function clampConfidence(value: number): number {
  if (value < 0.01) {
    return 0.01;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function buildEvidenceId(
  kind: EvidenceKind,
  owner: string,
  anchor: string,
  value: string,
  provenance: EvidenceProvenance,
): string {
  const hash = createHash("sha1")
    .update(kind)
    .update("|")
    .update(owner)
    .update("|")
    .update(anchor)
    .update("|")
    .update(value)
    .update("|")
    .update(provenance.tool)
    .update("|")
    .update(provenance.sourceFilePath)
    .digest("hex");
  return hash;
}

function createRecord(
  kind: EvidenceKind,
  owner: string,
  anchor: string,
  value: string,
  confidence: number,
  provenance: EvidenceProvenance,
): EvidenceRecord {
  const normalizedValue = normalizeValue(value);
  const normalizedAnchor = normalizeValue(anchor);
  const id = buildEvidenceId(kind, owner, normalizedAnchor, normalizedValue, provenance);
  return {
    id,
    kind,
    owner,
    anchor: normalizedAnchor,
    value: normalizedValue,
    confidence: clampConfidence(confidence),
    provenance,
  };
}

function pushImportHints(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let ordinal = 0;
  const importRegex = /(?:import\s+(?:[^"'`]+?\s+from\s+)?|export\s+[^"'`]+?\s+from\s+|import\s*\()\s*["'`]([^"'`]+)["'`]/g;
  for (const match of source.matchAll(importRegex)) {
    const importPath = match[1];
    if (!importPath) {
      continue;
    }
    sink.push(
      createRecord(
        "file_hint",
        owner,
        `file_hint:${ordinal}`,
        importPath,
        baseConfidence * 0.83,
        provenance,
      ),
    );
    ordinal += 1;
  }
  const requireRegex = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  for (const match of source.matchAll(requireRegex)) {
    const importPath = match[1];
    if (!importPath) {
      continue;
    }
    sink.push(
      createRecord(
        "file_hint",
        owner,
        `file_hint:${ordinal}`,
        importPath,
        baseConfidence * 0.78,
        provenance,
      ),
    );
    ordinal += 1;
  }
}

function pushSymbolHints(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let ordinal = 0;
  const classRegex = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
  for (const match of source.matchAll(classRegex)) {
    const symbol = match[1];
    if (!symbol) {
      continue;
    }
    sink.push(
      createRecord(
        "symbol_hint",
        owner,
        `symbol:${ordinal}`,
        symbol,
        baseConfidence * 0.93,
        provenance,
      ),
    );
    ordinal += 1;
  }

  const functionRegex = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
  for (const match of source.matchAll(functionRegex)) {
    const symbol = match[1];
    if (!symbol) {
      continue;
    }
    sink.push(
      createRecord(
        "symbol_hint",
        owner,
        `symbol:${ordinal}`,
        symbol,
        baseConfidence * 0.88,
        provenance,
      ),
    );
    ordinal += 1;
  }

  const assignedFunctionRegex =
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/g;
  for (const match of source.matchAll(assignedFunctionRegex)) {
    const symbol = match[1];
    if (!symbol) {
      continue;
    }
    sink.push(
      createRecord(
        "symbol_hint",
        owner,
        `symbol:${ordinal}`,
        symbol,
        baseConfidence * 0.79,
        provenance,
      ),
    );
    ordinal += 1;
  }
}

function findBlockEnd(source: string, openingBraceIndex: number): number {
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function pushCallEdges(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let ordinal = 0;
  const declarationRegex = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\([^)]*\)\s*\{/g;
  const dedupe = new Set<string>();
  for (const match of source.matchAll(declarationRegex)) {
    const caller = match[1];
    const fullMatch = match[0];
    if (!caller || !fullMatch) {
      continue;
    }
    const openingBraceOffset = fullMatch.lastIndexOf("{");
    if (openingBraceOffset < 0) {
      continue;
    }
    const start = (match.index ?? 0) + openingBraceOffset;
    const end = findBlockEnd(source, start);
    if (end <= start) {
      continue;
    }
    const body = source.slice(start + 1, end);
    const callRegex = /\b([A-Za-z_$][A-Za-z0-9_$]{1,})\s*\(/g;
    for (const bodyMatch of body.matchAll(callRegex)) {
      const callee = bodyMatch[1];
      if (!callee || RESERVED_WORDS.has(callee)) {
        continue;
      }
      const edge = `${caller}->${callee}`;
      if (dedupe.has(edge)) {
        continue;
      }
      dedupe.add(edge);
      sink.push(
        createRecord(
          "call_edge",
          owner,
          `call:${ordinal}`,
          edge,
          baseConfidence * 0.67,
          provenance,
        ),
      );
      ordinal += 1;
    }
  }
}

function pushStateKeys(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let ordinal = 0;
  const dedupe = new Set<string>();
  const stringLiteralRegex = /["'`]([A-Za-z][A-Za-z0-9_.:-]{2,})["'`]/g;
  for (const match of source.matchAll(stringLiteralRegex)) {
    const value = match[1];
    if (!value) {
      continue;
    }
    if (value.startsWith("http")) {
      continue;
    }
    if (!(value.includes(".") || value.includes(":") || value.includes("_") || value.includes("-") || value.length > 8)) {
      continue;
    }
    if (dedupe.has(value)) {
      continue;
    }
    dedupe.add(value);
    sink.push(
      createRecord(
        "state_key",
        owner,
        `state_key:${ordinal}`,
        value,
        baseConfidence * 0.61,
        provenance,
      ),
    );
    ordinal += 1;
  }
}

function pushSourcemapEvidence(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let parsed: { sources?: string[] } = {};
  try {
    parsed = JSON.parse(source) as { sources?: string[] };
  } catch {
    return;
  }
  const mapSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  let ordinal = 0;
  for (const mapSource of mapSources) {
    if (typeof mapSource !== "string" || mapSource.length === 0) {
      continue;
    }
    sink.push(
      createRecord(
        "source_map",
        owner,
        `source_map:${ordinal}`,
        mapSource,
        baseConfidence * 0.9,
        provenance,
      ),
    );
    ordinal += 1;
  }
}

async function readSourceText(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return content;
}

function isCoverageSource(sourceFile: EvidenceSourceFile): boolean {
  return sourceFile.lineageId.endsWith(COVERAGE_OWNER_SUFFIX) || sourceFile.stageId === "monolith-census";
}

function pushMonolithCensusMappingHints(
  source: string,
  owner: string,
  baseConfidence: number,
  provenance: EvidenceProvenance,
  sink: EvidenceRecord[],
): void {
  let parsed: MonolithCensusMappingModel = {};
  try {
    parsed = JSON.parse(source) as MonolithCensusMappingModel;
  } catch {
    return;
  }

  const seedEntries = Array.isArray(parsed.seedEntries) ? parsed.seedEntries : [];
  const variableCoverage = Array.isArray(parsed.variableCoverage) ? parsed.variableCoverage : [];

  const sortedSeeds = [...seedEntries].sort((left, right) => left.anchor.localeCompare(right.anchor));
  for (const seed of sortedSeeds) {
    if (typeof seed.anchor !== "string" || seed.anchor.length === 0) {
      continue;
    }
    if (typeof seed.censusName !== "string" || seed.censusName.length === 0) {
      continue;
    }
    sink.push(
      createRecord(
        "symbol_hint",
        owner,
        seed.anchor,
        seed.censusName,
        baseConfidence * 0.98,
        provenance,
      ),
    );
  }

  const sortedVariables = [...variableCoverage]
    .filter((entry) => typeof entry.variableKey === "string" && entry.variableKey.length > 0)
    .filter((entry) => typeof entry.censusName === "string" && entry.censusName.length > 0)
    .sort((left, right) => left.variableKey.localeCompare(right.variableKey))
    .slice(0, COVERAGE_VARIABLE_LIMIT);

  for (const variable of sortedVariables) {
    sink.push(
      createRecord(
        "symbol_hint",
        owner,
        `coverage:${variable.variableKey}`,
        variable.censusName,
        baseConfidence * 0.74,
        provenance,
      ),
    );
  }
}

async function extractSourceEvidence(sourceFile: EvidenceSourceFile): Promise<EvidenceRecord[]> {
  const source = await readSourceText(sourceFile.filePath);
  const provenance: EvidenceProvenance = {
    tool: sourceFile.tool,
    stageId: sourceFile.stageId,
    sourceFilePath: sourceFile.filePath,
    lineageId: sourceFile.lineageId,
  };
  const owner = sourceFile.lineageId;
  const sink: EvidenceRecord[] = [];

  const isMonolithCensusMapping =
    sourceFile.stageId === "monolith-census" &&
    sourceFile.sourceKind === "text" &&
    sourceFile.filePath.toLowerCase().endsWith("census-mapping.json");
  if (isMonolithCensusMapping) {
    pushMonolithCensusMappingHints(source, owner, sourceFile.baseConfidence, provenance, sink);
    return sink;
  }

  pushImportHints(source, owner, sourceFile.baseConfidence, provenance, sink);
  pushSymbolHints(source, owner, sourceFile.baseConfidence, provenance, sink);
  pushCallEdges(source, owner, sourceFile.baseConfidence, provenance, sink);
  pushStateKeys(source, owner, sourceFile.baseConfidence, provenance, sink);
  if (sourceFile.sourceKind === "sourcemap") {
    pushSourcemapEvidence(source, owner, sourceFile.baseConfidence, provenance, sink);
  }
  return sink;
}

async function ingestEvidenceSources(
  sourceFiles: EvidenceSourceFile[],
  recordsById: Map<string, EvidenceRecord>,
  limit: number,
): Promise<void> {
  let added = 0;
  const orderedSourceFiles = [...sourceFiles].sort((left, right) => left.filePath.localeCompare(right.filePath));

  for (const sourceFile of orderedSourceFiles) {
    const extractedRecords = await extractSourceEvidence(sourceFile);
    for (const record of extractedRecords) {
      if (added >= limit) {
        return;
      }
      if (recordsById.has(record.id)) {
        continue;
      }
      recordsById.set(record.id, record);
      added += 1;
    }
  }
}

function buildStats(records: EvidenceRecord[]): EvidenceStats {
  let fileHintCount = 0;
  let symbolHintCount = 0;
  let callEdgeCount = 0;
  let stateKeyCount = 0;
  let sourceMapCount = 0;
  for (const record of records) {
    if (record.kind === "file_hint") {
      fileHintCount += 1;
      continue;
    }
    if (record.kind === "symbol_hint") {
      symbolHintCount += 1;
      continue;
    }
    if (record.kind === "call_edge") {
      callEdgeCount += 1;
      continue;
    }
    if (record.kind === "state_key") {
      stateKeyCount += 1;
      continue;
    }
    if (record.kind === "source_map") {
      sourceMapCount += 1;
    }
  }

  return {
    totalRecords: records.length,
    fileHintCount,
    symbolHintCount,
    callEdgeCount,
    stateKeyCount,
    sourceMapCount,
  };
}

export async function buildEvidenceStore(sourceFiles: EvidenceSourceFile[], maxRecords: number): Promise<EvidenceStoreModel> {
  const primarySources = sourceFiles.filter((sourceFile) => !isCoverageSource(sourceFile));
  const coverageSources = sourceFiles.filter((sourceFile) => isCoverageSource(sourceFile));

  const primaryRecordsById = new Map<string, EvidenceRecord>();
  await ingestEvidenceSources(primarySources, primaryRecordsById, maxRecords);

  const coverageRecordsById = new Map<string, EvidenceRecord>();
  const coverageBudget = Math.max(1200, Math.floor(maxRecords * COVERAGE_RECORD_BUDGET_FACTOR));
  await ingestEvidenceSources(coverageSources, coverageRecordsById, coverageBudget);

  const recordsById = new Map<string, EvidenceRecord>(primaryRecordsById);
  for (const [recordId, record] of coverageRecordsById.entries()) {
    if (recordsById.has(recordId)) {
      continue;
    }
    recordsById.set(recordId, record);
  }

  const records = [...recordsById.values()].sort((left, right) => left.id.localeCompare(right.id));
  const stats = buildStats(records);
  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    records,
    stats,
  };
}
