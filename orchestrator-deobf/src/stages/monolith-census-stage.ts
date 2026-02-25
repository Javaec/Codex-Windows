import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MonolithCensusStageInput, MonolithCensusStageOutput } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

type CensusSymbolKind = "class" | "function" | "callable-variable";

interface RenameOccurrence {
  start: number;
  end: number;
  originalName: string;
  kind: CensusSymbolKind;
}

interface NamedOccurrence extends RenameOccurrence {
  replacementName: string;
  signalTags: string[];
  signalScore: number;
  promoteToQuality: boolean;
}

interface CensusSeedEntry {
  symbolKey: string;
  owner: string;
  anchor: string;
  kind: CensusSymbolKind;
  originalName: string;
  censusName: string;
  signalTags: string[];
  signalScore: number;
  promoteToQuality: boolean;
}

interface VariableCoverageEntry {
  variableKey: string;
  originalName: string;
  censusName: string;
}

interface MonolithCensusMapping {
  version: number;
  generatedAtIso: string;
  sourceJsPath: string;
  lineageId: string;
  seedEntries: CensusSeedEntry[];
  variableCoverage: VariableCoverageEntry[];
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
const VARIABLE_COVERAGE_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;

const SIGNAL_PATTERNS: SignalPattern[] = [
  { tag: "ipc", regex: /\b(ipc|invoke|channel|electron)\b/i, weight: 0.22 },
  { tag: "rpc", regex: /\b(rpc|request|response|transport)\b/i, weight: 0.2 },
  { tag: "route", regex: /\b(route|router|navigate|path|screen|page)\b/i, weight: 0.2 },
  { tag: "event", regex: /\b(event|emit|listener|subscribe|dispatch)\b/i, weight: 0.2 },
  { tag: "state", regex: /\b(state|store|cache|reducer|atom)\b/i, weight: 0.19 },
  { tag: "async", regex: /\b(async|await|promise|then)\b/i, weight: 0.16 },
  { tag: "math", regex: /\b(Math|sum|total|average|calc|compute)\b/i, weight: 0.14 },
  { tag: "collection", regex: /\b(map|filter|reduce|forEach|find|sort)\b/i, weight: 0.12 },
  { tag: "config", regex: /\b(config|settings|profile|option|flag)\b/i, weight: 0.12 },
  { tag: "network", regex: /\b(fetch|http|socket|ws|request|client)\b/i, weight: 0.14 },
  { tag: "ui", regex: /\b(jsx|render|component|dialog|panel|view)\b/i, weight: 0.12 },
];

const TAG_PRIORITY = [
  "ipc",
  "rpc",
  "route",
  "event",
  "state",
  "async",
  "network",
  "config",
  "ui",
  "collection",
  "math",
];

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function ordinalToken(value: number): string {
  return value.toString(36).toUpperCase();
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
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
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
  const left = Math.max(0, start - 260);
  const right = Math.min(source.length, start + 360);
  return source.slice(left, right);
}

function collectSignalTags(snippet: string): { tags: string[]; score: number } {
  const tags: string[] = [];
  let score = 0.36;
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

function stemByTag(tag: string): string {
  if (tag === "ipc") {
    return "ipcTransport";
  }
  if (tag === "rpc") {
    return "rpcGateway";
  }
  if (tag === "route") {
    return "routeFlow";
  }
  if (tag === "event") {
    return "eventStream";
  }
  if (tag === "state") {
    return "stateStore";
  }
  if (tag === "async") {
    return "asyncWorkflow";
  }
  if (tag === "network") {
    return "networkClient";
  }
  if (tag === "config") {
    return "configProfile";
  }
  if (tag === "ui") {
    return "uiComponent";
  }
  if (tag === "collection") {
    return "collectionTransform";
  }
  if (tag === "math") {
    return "mathCompute";
  }
  return "domainUnit";
}

function fallbackName(kind: CensusSymbolKind, ordinal: number): string {
  if (kind === "class") {
    return `classUnit${ordinalToken(ordinal)}`;
  }
  if (kind === "function") {
    return `functionUnit${ordinalToken(ordinal)}`;
  }
  return `callableUnit${ordinalToken(ordinal)}`;
}

function composeCoverageName(
  kind: CensusSymbolKind,
  ordinal: number,
  tags: string[],
  usedNames: Set<string>,
): string {
  const dominantTag = tags[0];
  const stem = dominantTag ? stemByTag(dominantTag) : "";
  let raw = "";
  if (stem.length > 0) {
    if (kind === "class") {
      raw = `${toPascalCase(stem)}Class${ordinalToken(ordinal)}`;
    } else if (kind === "function") {
      raw = `${stem}Fn${ordinalToken(ordinal)}`;
    } else {
      raw = `${stem}Callable${ordinalToken(ordinal)}`;
    }
  } else {
    raw = fallbackName(kind, ordinal);
  }

  const base = sanitizeIdentifier(raw, fallbackName(kind, ordinal));
  let candidate = base;
  let collision = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}${ordinalToken(collision)}`;
    collision += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function shouldPromoteToQuality(name: string, signalScore: number, tags: string[]): boolean {
  const normalized = name.toLowerCase();
  if (normalized.startsWith("classunit")) {
    return false;
  }
  if (normalized.startsWith("functionunit")) {
    return false;
  }
  if (normalized.startsWith("callableunit")) {
    return false;
  }
  if (tags.length === 0) {
    return false;
  }
  return signalScore >= 0.68;
}

function assignCoverageNames(source: string, renames: RenameOccurrence[]): NamedOccurrence[] {
  const usedNames = new Set<string>();
  return renames.map((entry, index) => {
    const snippet = snippetAt(source, entry.start);
    const signal = collectSignalTags(snippet);
    const replacementName = composeCoverageName(entry.kind, index + 1, signal.tags, usedNames);
    return {
      ...entry,
      replacementName,
      signalTags: signal.tags,
      signalScore: signal.score,
      promoteToQuality: shouldPromoteToQuality(replacementName, signal.score, signal.tags),
    };
  });
}

function applyRenames(source: string, renames: NamedOccurrence[]): string {
  const sorted = [...renames].sort((left, right) => right.start - left.start);
  let output = source;
  for (const rename of sorted) {
    output = `${output.slice(0, rename.start)}${rename.replacementName}${output.slice(rename.end)}`;
  }
  return output;
}

function buildSeedEntries(lineageId: string, renames: NamedOccurrence[]): CensusSeedEntry[] {
  const classes = renames.filter((entry) => entry.kind === "class");
  const functions = renames.filter((entry) => entry.kind === "function");
  const callableVariables = renames.filter((entry) => entry.kind === "callable-variable");
  const ordered = [...classes, ...functions, ...callableVariables];
  return ordered.map((entry, index) => {
    const anchor = `symbol:${index}`;
    return {
      symbolKey: `${lineageId}:${anchor}`,
      owner: lineageId,
      anchor,
      kind: entry.kind,
      originalName: entry.originalName,
      censusName: entry.replacementName,
      signalTags: entry.signalTags,
      signalScore: entry.signalScore,
      promoteToQuality: entry.promoteToQuality,
    };
  });
}

function buildVariableCoverage(source: string): VariableCoverageEntry[] {
  return [...source.matchAll(VARIABLE_COVERAGE_REGEX)].map((match, index) => {
    const originalName = match[1];
    if (!originalName) {
      throw new Error("buildVariableCoverage: invalid variable match");
    }
    return {
      variableKey: `var:${index}`,
      originalName,
      censusName: `valueUnit${ordinalToken(index + 1)}`,
    };
  });
}

async function executeMonolithCensus(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<MonolithCensusStageInput>(request.inputPath);
  const source = await fs.readFile(input.sourceJsPath, "utf8");
  const renames = collectRenames(source);
  assertNoOverlaps(renames);
  const namedRenames = assignCoverageNames(source, renames);
  const censusSource = applyRenames(source, namedRenames);

  const seedEntries = buildSeedEntries(input.lineageId, namedRenames);
  const variableCoverage = buildVariableCoverage(source);
  const qualityPromotionCandidateCount = seedEntries.filter((entry) => entry.promoteToQuality).length;

  const mapping: MonolithCensusMapping = {
    version: 2,
    generatedAtIso: new Date().toISOString(),
    sourceJsPath: input.sourceJsPath,
    lineageId: input.lineageId,
    seedEntries,
    variableCoverage,
  };

  await ensureDirectory(input.outputDirectory);
  const censusJsPath = path.join(input.outputDirectory, "monolith-census.js");
  const mappingPath = path.join(input.outputDirectory, "census-mapping.json");
  await fs.writeFile(censusJsPath, censusSource, "utf8");
  await writeJsonFile(mappingPath, mapping);

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
  };
  await writeJsonFile(request.outputPath, output);
}

export const monolithCensusStage: PipelineStage = {
  id: "monolith-census",
  execute: executeMonolithCensus,
  cachePlan: {
    version: 2,
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
      };
    },
  } as StageCachePlan<unknown>,
};
