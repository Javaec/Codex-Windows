import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MonolithCensusStageInput, MonolithCensusStageOutput } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

type CensusSymbolKind = "class" | "function" | "callable-variable";
type TypeHintKind = "boolean" | "array" | "object" | "function" | "unknown";
type SemanticBucket =
  | "sum"
  | "orchestrate"
  | "parse"
  | "state"
  | "event"
  | "request"
  | "config"
  | "view"
  | "flow"
  | "domain";

interface RenameOccurrence {
  start: number;
  end: number;
  originalName: string;
  kind: CensusSymbolKind;
}

interface NamedOccurrence extends RenameOccurrence {
  pass1Name: string;
  replacementName: string;
  signalTags: string[];
  signalScore: number;
  semanticBucket: SemanticBucket;
  promoteToQuality: boolean;
}

interface CensusSeedEntry {
  symbolKey: string;
  owner: string;
  anchor: string;
  kind: CensusSymbolKind;
  originalName: string;
  censusName: string;
  pass1Name: string;
  signalTags: string[];
  signalScore: number;
  semanticBucket: SemanticBucket;
  promoteToQuality: boolean;
}

interface VariableCoverageEntry {
  variableKey: string;
  originalName: string;
  censusName: string;
  inferredType: TypeHintKind;
}

interface MonolithCensusMapping {
  version: number;
  generatedAtIso: string;
  sourceJsPath: string;
  unifiedMonolithPath: string;
  lineageId: string;
  seedEntries: CensusSeedEntry[];
  variableCoverage: VariableCoverageEntry[];
}

interface SymbolTableEntry {
  symbolKey: string;
  anchor: string;
  kind: CensusSymbolKind;
  originalName: string;
  pass1Name: string;
  finalName: string;
  start: number;
  end: number;
  signalTags: string[];
  signalScore: number;
  semanticBucket: SemanticBucket;
  promoteToQuality: boolean;
}

interface SymbolTableModel {
  version: number;
  generatedAtIso: string;
  sourceJsPath: string;
  unifiedMonolithPath: string;
  lineageId: string;
  entries: SymbolTableEntry[];
}

interface FunctionTypingHint {
  symbolKey: string;
  name: string;
  kind: CensusSymbolKind;
  parameterNames: string[];
  parameterCount: number;
  signature: string;
  returnHint: TypeHintKind;
}

interface VariableTypingHint {
  variableKey: string;
  variableName: string;
  inferredType: TypeHintKind;
}

interface TypingHintsModel {
  version: number;
  generatedAtIso: string;
  sourceJsPath: string;
  unifiedMonolithPath: string;
  lineageId: string;
  functionHints: FunctionTypingHint[];
  variableHints: VariableTypingHint[];
}

interface SignalPattern {
  tag: string;
  regex: RegExp;
  weight: number;
}

const CLASS_REGEX = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
const FUNCTION_REGEX = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
const CALLABLE_VARIABLE_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{2,})\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/g;
const VARIABLE_DECLARATION_WITH_INIT_REGEX =
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*([^;\n]+))?/g;

const SIGNAL_PATTERNS: SignalPattern[] = [
  { tag: "ipc", regex: /\b(ipc|invoke|channel|electron)\b/i, weight: 0.2 },
  { tag: "rpc", regex: /\b(rpc|request|response|transport)\b/i, weight: 0.18 },
  { tag: "route", regex: /\b(route|router|navigate|path|screen|page)\b/i, weight: 0.17 },
  { tag: "event", regex: /\b(event|emit|listener|subscribe|dispatch)\b/i, weight: 0.17 },
  { tag: "state", regex: /\b(state|store|cache|reducer|atom)\b/i, weight: 0.17 },
  { tag: "async", regex: /\b(async|await|promise|then)\b/i, weight: 0.14 },
  { tag: "parse", regex: /\b(parse|json|decode|encode|lexer|token|ast)\b/i, weight: 0.16 },
  { tag: "math", regex: /\b(Math|sum|total|average|calc|compute)\b/i, weight: 0.15 },
  { tag: "network", regex: /\b(fetch|http|socket|ws|request|client)\b/i, weight: 0.14 },
  { tag: "config", regex: /\b(config|settings|profile|option|flag)\b/i, weight: 0.13 },
  { tag: "ui", regex: /\b(jsx|render|component|dialog|panel|view)\b/i, weight: 0.12 },
];

const TAG_PRIORITY = ["ipc", "rpc", "route", "event", "state", "parse", "network", "config", "ui", "async", "math"];

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function padOrdinal(value: number, size: number): string {
  return String(value).padStart(size, "0");
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part, index) => {
      if (part.length === 0) {
        return "";
      }
      if (index === 0) {
        return part.charAt(0).toLowerCase() + part.slice(1);
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
  if (cleaned.length === 0) {
    return fallback;
  }
  if (!/^[A-Za-z_$]/.test(cleaned)) {
    return `${fallback}${cleaned}`;
  }
  return cleaned;
}

function toPascalCase(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join("");
  return normalized.length > 0 ? normalized : "Domain";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectRenames(source: string): RenameOccurrence[] {
  const classes = [...source.matchAll(CLASS_REGEX)].map((match) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid class match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: class name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      kind: "class" as const,
    };
  });

  const functions = [...source.matchAll(FUNCTION_REGEX)].map((match) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid function match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: function name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      kind: "function" as const,
    };
  });

  const callableVariables = [...source.matchAll(CALLABLE_VARIABLE_REGEX)].map((match) => {
    const originalName = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("collectRenames: invalid callable variable match");
    }
    const localIndex = fullMatch.indexOf(originalName);
    if (localIndex < 0) {
      throw new Error("collectRenames: callable variable name offset missing");
    }
    const start = matchIndex + localIndex;
    return {
      start,
      end: start + originalName.length,
      originalName,
      kind: "callable-variable" as const,
    };
  });

  return [...classes, ...functions, ...callableVariables].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.end - right.end;
  });
}

function assertNoOverlaps(renames: RenameOccurrence[]): void {
  for (let index = 1; index < renames.length; index += 1) {
    const previous = renames[index - 1];
    const current = renames[index];
    if (!previous || !current) {
      continue;
    }
    if (current.start < previous.end) {
      throw new Error(`collectRenames: overlap detected between ${previous.kind} and ${current.kind}`);
    }
  }
}

function snippetAt(source: string, start: number): string {
  const left = Math.max(0, start - 280);
  const right = Math.min(source.length, start + 420);
  return source.slice(left, right);
}

function estimateCallCount(snippet: string): number {
  const matches = snippet.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g);
  return matches ? matches.length : 0;
}

function collectSignalTags(snippet: string): { tags: string[]; score: number } {
  const tags: string[] = [];
  let score = 0.34;
  for (const signal of SIGNAL_PATTERNS) {
    if (!signal.regex.test(snippet)) {
      continue;
    }
    tags.push(signal.tag);
    score += signal.weight;
  }
  const orderedTags = TAG_PRIORITY.filter((tag) => tags.includes(tag));
  return {
    tags: orderedTags,
    score: clamp(score),
  };
}

function bucketFromTags(snippet: string, tags: string[]): SemanticBucket {
  if (/\b(sum|total|average|compute|calc|Math\.)\b/.test(snippet)) {
    return "sum";
  }
  if (/\b(parse|json|decode|encode|lexer|token|ast)\b/i.test(snippet)) {
    return "parse";
  }
  if (/\b(state|store|cache|reducer|atom|getState|setState)\b/i.test(snippet)) {
    return "state";
  }
  if (/\b(event|emit|dispatch|listener|subscribe)\b/i.test(snippet)) {
    return "event";
  }
  if (/\b(fetch|http|request|response|socket|ws)\b/i.test(snippet)) {
    return "request";
  }
  if (/\b(config|setting|profile|option|flag)\b/i.test(snippet)) {
    return "config";
  }
  if (/\b(view|render|component|dialog|panel|screen)\b/i.test(snippet)) {
    return "view";
  }
  const callCount = estimateCallCount(snippet);
  if (callCount >= 5) {
    return "orchestrate";
  }
  const dominantTag = tags[0] ?? "";
  if (dominantTag === "ipc" || dominantTag === "rpc" || dominantTag === "route") {
    return "orchestrate";
  }
  return "flow";
}

function composePass1Name(kind: CensusSymbolKind, classOrdinal: number, functionOrdinal: number): string {
  if (kind === "class") {
    return `Class${padOrdinal(classOrdinal, 4)}`;
  }
  return `Func${padOrdinal(functionOrdinal, 4)}`;
}

function composePass2Name(
  kind: CensusSymbolKind,
  bucket: SemanticBucket,
  classOrdinal: number,
  functionOrdinal: number,
  usedNames: Set<string>,
): string {
  let base = "";
  if (kind === "class") {
    base = `${toPascalCase(bucket)}Class${padOrdinal(classOrdinal, 4)}`;
  } else {
    base = sanitizeIdentifier(`${bucket}Func${padOrdinal(functionOrdinal, 4)}`, `flowFunc${padOrdinal(functionOrdinal, 4)}`);
  }
  let candidate = base;
  let collision = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${collision}`;
    collision += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function shouldPromoteToQuality(signalScore: number, semanticBucket: SemanticBucket): boolean {
  if (semanticBucket === "flow") {
    return signalScore >= 0.62;
  }
  return signalScore >= 0.5;
}

function assignNames(source: string, renames: RenameOccurrence[]): NamedOccurrence[] {
  let classOrdinal = 0;
  let functionOrdinal = 0;
  const usedPass2Names = new Set<string>();
  const output: NamedOccurrence[] = [];

  for (const entry of renames) {
    const snippet = snippetAt(source, entry.start);
    const signal = collectSignalTags(snippet);
    const bucket = bucketFromTags(snippet, signal.tags);
    if (entry.kind === "class") {
      classOrdinal += 1;
    } else {
      functionOrdinal += 1;
    }
    const pass1Name = composePass1Name(entry.kind, classOrdinal, functionOrdinal);
    const replacementName = composePass2Name(entry.kind, bucket, classOrdinal, functionOrdinal, usedPass2Names);

    output.push({
      ...entry,
      pass1Name,
      replacementName,
      signalTags: signal.tags,
      signalScore: signal.score,
      semanticBucket: bucket,
      promoteToQuality: shouldPromoteToQuality(signal.score, bucket),
    });
  }

  return output;
}

function applyDeclarationRenames(source: string, renames: RenameOccurrence[], getName: (entry: RenameOccurrence) => string): string {
  const sorted = [...renames].sort((left, right) => right.start - left.start);
  let output = source;
  for (const rename of sorted) {
    output = `${output.slice(0, rename.start)}${getName(rename)}${output.slice(rename.end)}`;
  }
  return output;
}

function parseParameterNames(rawParameters: string): string[] {
  return rawParameters
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/=[\s\S]*$/, "").trim())
    .map((entry) => entry.replace(/^[.\s]*\.\.\./, "").trim())
    .map((entry) => entry.replace(/[:?].*$/, "").trim())
    .filter((entry) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry));
}

function inferReturnHintFromSnippet(snippet: string): TypeHintKind {
  if (/\breturn\s+(?:true|false)\b/.test(snippet)) {
    return "boolean";
  }
  if (/\breturn\s+\[/.test(snippet)) {
    return "array";
  }
  if (/\breturn\s+\{/.test(snippet)) {
    return "object";
  }
  if (/\breturn\s+(?:async\s*)?function\b/.test(snippet) || /\breturn\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=>/.test(snippet)) {
    return "function";
  }
  return "unknown";
}

function extractFunctionParameters(source: string, entry: NamedOccurrence): string[] {
  const tail = source.slice(entry.start, Math.min(source.length, entry.start + 520));
  if (entry.kind === "function") {
    const direct = new RegExp(`^${escapeRegex(entry.originalName)}\\s*\\(([^)]*)\\)`).exec(tail);
    if (direct && direct[1]) {
      return parseParameterNames(direct[1]);
    }
    return [];
  }
  if (entry.kind === "callable-variable") {
    const callableMatch =
      new RegExp(
        `^${escapeRegex(entry.originalName)}\\s*=\\s*(?:async\\s*)?(?:function\\s*(?:[A-Za-z_$][A-Za-z0-9_$]*)?\\s*\\(([^)]*)\\)|\\(([^)]*)\\)\\s*=>|([A-Za-z_$][A-Za-z0-9_$]*)\\s*=>)`,
      ).exec(tail);
    if (!callableMatch) {
      return [];
    }
    if (callableMatch[1]) {
      return parseParameterNames(callableMatch[1]);
    }
    if (callableMatch[2]) {
      return parseParameterNames(callableMatch[2]);
    }
    if (callableMatch[3]) {
      return [callableMatch[3]];
    }
    return [];
  }
  const classTail = source.slice(entry.start, Math.min(source.length, entry.start + 1200));
  const constructorMatch = /\bconstructor\s*\(([^)]*)\)/.exec(classTail);
  if (!constructorMatch || !constructorMatch[1]) {
    return [];
  }
  return parseParameterNames(constructorMatch[1]);
}

function inferValueType(expression: string): TypeHintKind {
  const normalized = expression.trim();
  if (normalized.length === 0) {
    return "unknown";
  }
  if (/^(?:true|false)\b/.test(normalized)) {
    return "boolean";
  }
  if (/^(?:!|Boolean\()/.test(normalized) || /(?:===|!==|<=|>=|<|>)/.test(normalized)) {
    return "boolean";
  }
  if (/^\[/.test(normalized) || /^new\s+Array\b/.test(normalized)) {
    return "array";
  }
  if (/^\{/.test(normalized) || /^new\s+(?:Map|Set|WeakMap|WeakSet|Object)\b/.test(normalized)) {
    return "object";
  }
  if (/^(?:async\s*)?function\b/.test(normalized) || /=>/.test(normalized)) {
    return "function";
  }
  return "unknown";
}

function buildSeedEntries(lineageId: string, namedRenames: NamedOccurrence[]): CensusSeedEntry[] {
  return namedRenames.map((entry, index) => {
    const anchor = `symbol:${index}`;
    return {
      symbolKey: `${lineageId}:${anchor}`,
      owner: lineageId,
      anchor,
      kind: entry.kind,
      originalName: entry.originalName,
      censusName: entry.replacementName,
      pass1Name: entry.pass1Name,
      signalTags: entry.signalTags,
      signalScore: entry.signalScore,
      semanticBucket: entry.semanticBucket,
      promoteToQuality: entry.promoteToQuality,
    };
  });
}

function buildVariableCoverage(source: string): VariableCoverageEntry[] {
  return [...source.matchAll(VARIABLE_DECLARATION_WITH_INIT_REGEX)].map((match, index) => {
    const originalName = match[1];
    const expression = match[2] ?? "";
    if (!originalName) {
      throw new Error("buildVariableCoverage: invalid variable match");
    }
    return {
      variableKey: `var:${index}`,
      originalName,
      censusName: `Var${padOrdinal(index + 1, 6)}`,
      inferredType: inferValueType(expression),
    };
  });
}

function buildSymbolTable(
  sourceJsPath: string,
  unifiedMonolithPath: string,
  lineageId: string,
  namedRenames: NamedOccurrence[],
): SymbolTableModel {
  const entries: SymbolTableEntry[] = namedRenames.map((entry, index) => ({
    symbolKey: `${lineageId}:symbol:${index}`,
    anchor: `symbol:${index}`,
    kind: entry.kind,
    originalName: entry.originalName,
    pass1Name: entry.pass1Name,
    finalName: entry.replacementName,
    start: entry.start,
    end: entry.end,
    signalTags: entry.signalTags,
    signalScore: entry.signalScore,
    semanticBucket: entry.semanticBucket,
    promoteToQuality: entry.promoteToQuality,
  }));
  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath,
    unifiedMonolithPath,
    lineageId,
    entries,
  };
}

function buildTypingHints(
  source: string,
  sourceJsPath: string,
  unifiedMonolithPath: string,
  lineageId: string,
  namedRenames: NamedOccurrence[],
  variableCoverage: VariableCoverageEntry[],
): TypingHintsModel {
  const functionHints: FunctionTypingHint[] = namedRenames.map((entry, index) => {
    const parameterNames = extractFunctionParameters(source, entry);
    const signatureBase = entry.kind === "class" ? `new ${entry.replacementName}` : entry.replacementName;
    const signature = `${signatureBase}(${parameterNames.join(", ")})`;
    const returnHint = inferReturnHintFromSnippet(snippetAt(source, entry.start));
    return {
      symbolKey: `${lineageId}:symbol:${index}`,
      name: entry.replacementName,
      kind: entry.kind,
      parameterNames,
      parameterCount: parameterNames.length,
      signature,
      returnHint,
    };
  });

  const variableHints: VariableTypingHint[] = variableCoverage.map((entry) => ({
    variableKey: entry.variableKey,
    variableName: entry.censusName,
    inferredType: entry.inferredType,
  }));

  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath,
    unifiedMonolithPath,
    lineageId,
    functionHints,
    variableHints,
  };
}

async function executeMonolithCensus(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<MonolithCensusStageInput>(request.inputPath);
  const source = await fs.readFile(input.sourceJsPath, "utf8");

  const renames = collectRenames(source);
  assertNoOverlaps(renames);
  const namedRenames = assignNames(source, renames);

  const pass1Source = applyDeclarationRenames(source, namedRenames, (entry) => {
    const named = namedRenames.find((candidate) => candidate.start === entry.start && candidate.end === entry.end);
    if (!named) {
      throw new Error(`Missing named entry for declaration at ${entry.start}`);
    }
    return named.pass1Name;
  });
  const pass2Source = applyDeclarationRenames(source, namedRenames, (entry) => {
    const named = namedRenames.find((candidate) => candidate.start === entry.start && candidate.end === entry.end);
    if (!named) {
      throw new Error(`Missing named entry for declaration at ${entry.start}`);
    }
    return named.replacementName;
  });

  const seedEntries = buildSeedEntries(input.lineageId, namedRenames);
  const variableCoverage = buildVariableCoverage(source);
  const qualityPromotionCandidateCount = seedEntries.filter((entry) => entry.promoteToQuality).length;

  const unifiedMonolithPath = path.join(input.outputDirectory, "unified-monolith.js");
  const pass1MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass1.js");
  const pass2MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass2.js");
  const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
  const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
  const symbolTablePath = path.join(input.outputDirectory, "symbol-table.json");
  const typingHintsPath = path.join(input.outputDirectory, "typing-hints.json");

  const symbolTable = buildSymbolTable(input.sourceJsPath, unifiedMonolithPath, input.lineageId, namedRenames);
  const typingHints = buildTypingHints(source, input.sourceJsPath, unifiedMonolithPath, input.lineageId, namedRenames, variableCoverage);

  const mapping: MonolithCensusMapping = {
    version: 3,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath: input.sourceJsPath,
    unifiedMonolithPath,
    lineageId: input.lineageId,
    seedEntries,
    variableCoverage,
  };

  await ensureDirectory(input.outputDirectory);
  await fs.writeFile(unifiedMonolithPath, source, "utf8");
  await fs.writeFile(pass1MonolithPath, pass1Source, "utf8");
  await fs.writeFile(pass2MonolithPath, pass2Source, "utf8");
  await fs.writeFile(censusJsPath, pass2Source, "utf8");
  await writeJsonFile(mappingPath, mapping);
  await writeJsonFile(symbolTablePath, symbolTable);
  await writeJsonFile(typingHintsPath, typingHints);

  const output: MonolithCensusStageOutput = {
    outputDirectory: input.outputDirectory,
    censusJsPath,
    mappingPath,
    sourceJsPath: input.sourceJsPath,
    lineageId: input.lineageId,
    classCount: namedRenames.filter((entry) => entry.kind === "class").length,
    functionCount: namedRenames.filter((entry) => entry.kind === "function").length,
    callableVariableCount: namedRenames.filter((entry) => entry.kind === "callable-variable").length,
    variableCoverageCount: variableCoverage.length,
    renamedDeclarationCount: namedRenames.length,
    qualityPromotionCandidateCount,
    unifiedMonolithPath,
    pass1MonolithPath,
    pass2MonolithPath,
    symbolTablePath,
    typingHintsPath,
  };
  await writeJsonFile(request.outputPath, output);
}

export const monolithCensusStage: PipelineStage = {
  id: "monolith-census",
  execute: executeMonolithCensus,
  cachePlan: {
    version: 4,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as MonolithCensusStageInput;
      const digest = await hashFileSha256(input.sourceJsPath);
      return JSON.stringify({
        sourceSha256: digest.sha256,
        sourceBytes: digest.bytes,
        lineageId: input.lineageId,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as MonolithCensusStageInput;
      return [{ kind: "directory", path: input.outputDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<MonolithCensusStageOutput> => {
      const input = inputUnknown as MonolithCensusStageInput;
      const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
      const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
      const unifiedMonolithPath = path.join(input.outputDirectory, "unified-monolith.js");
      const pass1MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass1.js");
      const pass2MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass2.js");
      const symbolTablePath = path.join(input.outputDirectory, "symbol-table.json");
      const typingHintsPath = path.join(input.outputDirectory, "typing-hints.json");
      const mapping = await readJsonFile<MonolithCensusMapping>(mappingPath);
      const classCount = mapping.seedEntries.filter((entry) => entry.kind === "class").length;
      const functionCount = mapping.seedEntries.filter((entry) => entry.kind === "function").length;
      const callableVariableCount = mapping.seedEntries.filter((entry) => entry.kind === "callable-variable").length;
      const qualityPromotionCandidateCount = mapping.seedEntries.filter((entry) => entry.promoteToQuality).length;
      return {
        outputDirectory: input.outputDirectory,
        censusJsPath,
        mappingPath,
        sourceJsPath: input.sourceJsPath,
        lineageId: input.lineageId,
        classCount,
        functionCount,
        callableVariableCount,
        variableCoverageCount: mapping.variableCoverage.length,
        renamedDeclarationCount: mapping.seedEntries.length,
        qualityPromotionCandidateCount,
        unifiedMonolithPath,
        pass1MonolithPath,
        pass2MonolithPath,
        symbolTablePath,
        typingHintsPath,
      };
    },
  } as StageCachePlan<unknown>,
};
