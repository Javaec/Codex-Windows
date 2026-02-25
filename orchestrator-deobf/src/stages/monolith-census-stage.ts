import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MonolithCensusStageInput, MonolithCensusStageOutput } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

type DeclarationSymbolKind = "class" | "function" | "callable-variable";
type CensusSymbolKind = DeclarationSymbolKind | "variable";
type TypeHintKind = "boolean" | "array" | "object" | "function" | "unknown";
type SemanticBucket = "sum" | "orchestrate" | "parse" | "state";

interface RenameOccurrence {
  start: number;
  end: number;
  originalName: string;
  kind: DeclarationSymbolKind;
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
  anchor: string;
  originalName: string;
  pass1Name: string;
  pass2Name: string;
  inferredType: TypeHintKind;
  semanticBucket: SemanticBucket;
  signalScore: number;
  promoteToQuality: boolean;
  start: number;
  end: number;
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
  kind: DeclarationSymbolKind;
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
  { tag: "parse", regex: /\b(parse|json|decode|encode|lexer|token|ast|schema)\b/i, weight: 0.22 },
  { tag: "math", regex: /\b(Math|sum|total|average|calc|compute|aggregate)\b/i, weight: 0.2 },
  { tag: "state", regex: /\b(state|store|cache|reducer|atom|getState|setState)\b/i, weight: 0.2 },
  { tag: "orchestrate", regex: /\b(ipc|invoke|channel|electron|rpc|route|navigate|event|emit|dispatch|fetch|http|socket|await|promise)\b/i, weight: 0.16 },
];

const TAG_PRIORITY = ["parse", "math", "state", "orchestrate"];

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
  if (/\b(parse|json|decode|encode|lexer|token|ast)\b/i.test(snippet)) {
    return "parse";
  }
  if (/\b(sum|total|average|compute|calc|Math\.|aggregate)\b/i.test(snippet)) {
    return "sum";
  }
  if (/\b(state|store|cache|reducer|atom|getState|setState)\b/i.test(snippet)) {
    return "state";
  }
  const callCount = estimateCallCount(snippet);
  if (callCount >= 4) {
    return "orchestrate";
  }
  const dominantTag = tags[0] ?? "";
  if (dominantTag === "orchestrate") {
    return "orchestrate";
  }
  return "orchestrate";
}

function composePass1Name(kind: DeclarationSymbolKind, classOrdinal: number, functionOrdinal: number): string {
  if (kind === "class") {
    return `Class${padOrdinal(classOrdinal, 4)}`;
  }
  return `Func${padOrdinal(functionOrdinal, 4)}`;
}

function composePass2Name(
  kind: DeclarationSymbolKind,
  bucket: SemanticBucket,
  classOrdinal: number,
  functionOrdinal: number,
  usedNames: Set<string>,
): string {
  let base = "";
  if (kind === "class") {
    base = `${toPascalCase(bucket)}Class${padOrdinal(classOrdinal, 4)}`;
  } else {
    base = sanitizeIdentifier(
      `${bucket}Func${padOrdinal(functionOrdinal, 4)}`,
      `orchestrateFunc${padOrdinal(functionOrdinal, 4)}`,
    );
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
  if (semanticBucket === "orchestrate") {
    return signalScore >= 0.58;
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

interface SourceReplacement {
  start: number;
  end: number;
  replacement: string;
}

function applySourceReplacements(source: string, replacements: SourceReplacement[]): string {
  const sorted = [...replacements].sort((left, right) => right.start - left.start);
  let output = source;
  for (const replacement of sorted) {
    output = `${output.slice(0, replacement.start)}${replacement.replacement}${output.slice(replacement.end)}`;
  }
  return output;
}

function buildPassReplacements(
  namedRenames: NamedOccurrence[],
  variableCoverage: VariableCoverageEntry[],
  mode: "pass1" | "pass2",
): SourceReplacement[] {
  const declarationReplacements = namedRenames.map((entry) => ({
    start: entry.start,
    end: entry.end,
    replacement: mode === "pass1" ? entry.pass1Name : entry.replacementName,
  }));
  const variableReplacements = variableCoverage.map((entry) => ({
    start: entry.start,
    end: entry.end,
    replacement: mode === "pass1" ? entry.pass1Name : entry.pass2Name,
  }));
  return [...declarationReplacements, ...variableReplacements];
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

function spansOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function inferVariableSemanticBucket(
  variableName: string,
  expression: string,
  inferredType: TypeHintKind,
): { bucket: SemanticBucket; signalScore: number } {
  const snippet = `${variableName} = ${expression}`;
  if (/\b(parse|json|decode|encode|lexer|token|ast|schema)\b/i.test(snippet)) {
    return {
      bucket: "parse",
      signalScore: 0.78,
    };
  }
  if (
    /\b(sum|total|average|calc|compute|aggregate|Math\.)\b/i.test(snippet) ||
    /[+\-*/%]\s*(?:\d|Number\b|Math\b)/.test(snippet)
  ) {
    return {
      bucket: "sum",
      signalScore: 0.74,
    };
  }
  if (
    /\b(state|store|cache|flag|enabled|list|map|set|dict|config|settings)\b/i.test(snippet) ||
    inferredType === "array" ||
    inferredType === "object" ||
    inferredType === "boolean"
  ) {
    return {
      bucket: "state",
      signalScore: 0.72,
    };
  }
  return {
    bucket: "orchestrate",
    signalScore: 0.58,
  };
}

function shouldPromoteVariableToQuality(signalScore: number, bucket: SemanticBucket): boolean {
  if (bucket === "orchestrate") {
    return false;
  }
  return signalScore >= 0.68;
}

function buildSeedEntries(
  lineageId: string,
  namedRenames: NamedOccurrence[],
  variableCoverage: VariableCoverageEntry[],
): CensusSeedEntry[] {
  const declarationEntries = namedRenames.map((entry, index) => {
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
  const variableEntries = variableCoverage.map((entry) => ({
    symbolKey: `${lineageId}:${entry.anchor}`,
    owner: lineageId,
    anchor: entry.anchor,
    kind: "variable" as const,
    originalName: entry.originalName,
    censusName: entry.pass2Name,
    pass1Name: entry.pass1Name,
    signalTags: [entry.semanticBucket],
    signalScore: entry.signalScore,
    semanticBucket: entry.semanticBucket,
    promoteToQuality: entry.promoteToQuality,
  }));
  return [...declarationEntries, ...variableEntries];
}

function buildVariableCoverage(source: string, namedRenames: NamedOccurrence[]): VariableCoverageEntry[] {
  const callableSpans = namedRenames
    .filter((entry) => entry.kind === "callable-variable")
    .map((entry) => ({ start: entry.start, end: entry.end }));
  const output: VariableCoverageEntry[] = [];
  let ordinal = 0;

  for (const match of source.matchAll(VARIABLE_DECLARATION_WITH_INIT_REGEX)) {
    const originalName = match[1];
    const expression = match[2] ?? "";
    const fullMatch = match[0];
    const matchIndex = match.index ?? -1;
    if (!originalName || !fullMatch || matchIndex < 0) {
      throw new Error("buildVariableCoverage: invalid variable match");
    }
    const declaratorMatch = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(fullMatch);
    if (!declaratorMatch || declaratorMatch[1] !== originalName) {
      throw new Error("buildVariableCoverage: variable name offset missing");
    }
    const localIndex = (declaratorMatch.index ?? 0) + declaratorMatch[0].length - originalName.length;
    const start = matchIndex + localIndex;
    const end = start + originalName.length;
    const overlapsCallable = callableSpans.some((span) => spansOverlap(start, end, span.start, span.end));
    if (overlapsCallable) {
      continue;
    }
    ordinal += 1;
    const variableKey = `var:${padOrdinal(ordinal, 6)}`;
    const inferredType = inferValueType(expression);
    const semantic = inferVariableSemanticBucket(originalName, expression, inferredType);
    output.push({
      variableKey,
      anchor: `coverage:${variableKey}`,
      originalName,
      pass1Name: `Var${padOrdinal(ordinal, 6)}`,
      pass2Name: sanitizeIdentifier(
        `${semantic.bucket}Var${padOrdinal(ordinal, 6)}`,
        `stateVar${padOrdinal(ordinal, 6)}`,
      ),
      inferredType,
      semanticBucket: semantic.bucket,
      signalScore: semantic.signalScore,
      promoteToQuality: shouldPromoteVariableToQuality(semantic.signalScore, semantic.bucket),
      start,
      end,
    });
  }

  return output;
}

function buildSymbolTable(
  sourceJsPath: string,
  unifiedMonolithPath: string,
  lineageId: string,
  namedRenames: NamedOccurrence[],
  variableCoverage: VariableCoverageEntry[],
): SymbolTableModel {
  const declarationEntries: SymbolTableEntry[] = namedRenames.map((entry, index) => ({
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
  const variableEntries: SymbolTableEntry[] = variableCoverage.map((entry) => ({
    symbolKey: `${lineageId}:${entry.anchor}`,
    anchor: entry.anchor,
    kind: "variable",
    originalName: entry.originalName,
    pass1Name: entry.pass1Name,
    finalName: entry.pass2Name,
    start: entry.start,
    end: entry.end,
    signalTags: [entry.semanticBucket],
    signalScore: entry.signalScore,
    semanticBucket: entry.semanticBucket,
    promoteToQuality: entry.promoteToQuality,
  }));
  const entries = [...declarationEntries, ...variableEntries].sort((left, right) => left.anchor.localeCompare(right.anchor));
  return {
    version: 2,
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
    variableName: entry.pass2Name,
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
  const variableCoverage = buildVariableCoverage(source, namedRenames);

  const pass1Source = applySourceReplacements(source, buildPassReplacements(namedRenames, variableCoverage, "pass1"));
  const pass2Source = applySourceReplacements(source, buildPassReplacements(namedRenames, variableCoverage, "pass2"));

  const seedEntries = buildSeedEntries(input.lineageId, namedRenames, variableCoverage);
  const qualityPromotionCandidateCount = seedEntries.filter((entry) => entry.promoteToQuality).length;

  const unifiedMonolithPath = path.join(input.outputDirectory, "unified-monolith.js");
  const pass1MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass1.js");
  const pass2MonolithPath = path.join(input.outputDirectory, "unified-monolith.pass2.js");
  const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
  const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
  const symbolTablePath = path.join(input.outputDirectory, "symbol-table.json");
  const typingHintsPath = path.join(input.outputDirectory, "typing-hints.json");

  const symbolTable = buildSymbolTable(input.sourceJsPath, unifiedMonolithPath, input.lineageId, namedRenames, variableCoverage);
  const typingHints = buildTypingHints(source, input.sourceJsPath, unifiedMonolithPath, input.lineageId, namedRenames, variableCoverage);

  const mapping: MonolithCensusMapping = {
    version: 4,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath: input.sourceJsPath,
    unifiedMonolithPath,
    lineageId: input.lineageId,
    seedEntries,
    variableCoverage,
  };

  await ensureDirectory(input.outputDirectory);
  await fs.writeFile(unifiedMonolithPath, pass2Source, "utf8");
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
    renamedDeclarationCount: seedEntries.length,
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
    version: 6,
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
