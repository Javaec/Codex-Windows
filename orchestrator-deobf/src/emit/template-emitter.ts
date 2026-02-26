import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as ts from "typescript";
import { ArchetypeId, LayerId } from "../contracts";
import { ChunkArtifactModel } from "../ir/chunk-artifact-model";
import { OwnershipModel, OwnershipRecord } from "../ir/ownership-model";
import { assertArchetypeLayerCompatibility } from "../ir/ownership-compatibility";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { SemanticIrModel } from "../ir/semantic-ir";
import { buildMonolithLayoutHintMaps, MonolithLayoutHintsModel } from "../ir/monolith-layout";
import { buildAstLiftResult, LiftedChunkArtifact, LiftedSymbolBinding } from "../lift/ast-lift";
import { ensureCleanDirectory, ensureDirectory } from "../utils/fs-json";

export interface TemplateEmitResult {
  emittedFiles: string[];
  emittedModuleCount: number;
  emittedSymbolCount: number;
  fileQualityReportPath: string;
  rerenderedModuleCount: number;
  hotChunkCount: number;
}

interface ModulePlan {
  layer: LayerId;
  archetype: ArchetypeId;
  clusterId: string;
  topic: string;
  moduleId: string;
  symbols: OwnershipRecord[];
  filePath: string;
}

interface SymbolSignalDescriptor {
  symbolKey: string;
  routeFlowScore: number;
  eventFlowScore: number;
  signalTokens: string[];
  callGraphTokens: string[];
  stateTokens: string[];
}

interface EmitterSignalContext {
  symbolSignalByKey: Map<string, SymbolSignalDescriptor>;
}

interface DomainRenameHint {
  symbolKey: string;
  preferredName: string;
  hintTokens: string[];
  confidence: number;
}

interface ModuleQualityEntry {
  moduleId: string;
  filePath: string;
  score: number;
  symbolCount: number;
  averageConfidence: number;
  averageNameQuality: number;
  liftedCoverage: number;
  rerendered: boolean;
}

interface MonolithTopicHints {
  bySymbolKey: Map<string, string>;
  bySymbolName: Map<string, string>;
}

interface EmittedAssetFile {
  absolutePath: string;
  content: string;
}

interface QualityModuleBuildResult {
  content: string;
  assetFiles: EmittedAssetFile[];
}

const GENERIC_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);
const LAYER_ORDER: LayerId[] = ["main", "renderer", "services", "tauri"];
const ARCHETYPE_ORDER: ArchetypeId[] = ["hook", "service", "ui", "transport", "store"];
const MAX_PARTS_PER_TOPIC = 2;
const HARD_SYMBOL_LIMIT_PER_MODULE = 560;
const FILE_QUALITY_WORST_PERCENT = 0.1;
const SYMBOL_EXPORT_MIN_QUALITY = 0.74;
const NOISE_NAME_TOKENS = new Set<string>(["module", "symbol", "entry"]);
const SIGNAL_TOKEN_STOPWORDS = new Set<string>([
  "chunk",
  "main",
  "entry",
  "symbol",
  "domain",
  "state",
  "store",
  "service",
  "renderer",
  "transport",
  "hook",
  "ui",
  "assets",
  "webview",
  "src",
  "part",
]);
const TEMPLATE_FALLBACK_NAME_PATTERNS: RegExp[] = [
  /^stateStore(?:[A-Za-z]+)?\d*$/i,
  /^domainService\d*$/i,
  /^uiComponents?\d*$/i,
  /^transportBridge(?:[A-Za-z]+)?\d*$/i,
  /^storeState(?:Store)?\d*$/i,
  /^serviceDomain(?:Service)?\d*$/i,
];
const ARCHETYPE_BUDGET_FACTOR: Record<ArchetypeId, number> = {
  hook: 0.7,
  service: 1.0,
  ui: 0.8,
  transport: 0.85,
  store: 0.9,
};
const ARCHETYPE_BUDGET_MIN: Record<ArchetypeId, number> = {
  hook: 16,
  service: 24,
  ui: 20,
  transport: 16,
  store: 24,
};
const ARCHETYPE_SYMBOL_BUDGET_FLOOR: Record<ArchetypeId, number> = {
  hook: 40,
  service: 160,
  ui: 64,
  transport: 72,
  store: 240,
};
const QUALITY_PLAN_BUDGET_MULTIPLIER = 4;
const QUALITY_PLAN_BUDGET_MIN = 128;
const SHARED_HELPER_MODULE_RELATIVE_PATH = "./_shared/helpers.js";
const SHARED_HELPER_MODULE_FILENAME = "helpers.ts";
const SHARED_HELPER_MIN_OCCURRENCES = 2;
const SHARED_HELPER_MAX_COUNT = 64;
const COHESION_MERGE_THRESHOLD = 0.44;
const COHESION_SPLIT_THRESHOLD = 0.2;
const COHESION_SPLIT_MIN_SYMBOLS = 22;
const MODULE_MERGE_MAX_SYMBOLS = 320;
const STATIC_PAYLOAD_LITERAL_MIN_LENGTH = 4096;
const STATIC_PAYLOAD_THEME_GRAMMAR_MIN_LENGTH = 1800;
const SHARED_HELPER_NAME_DENYLIST = new Set<string>([
  "liftedSourcePath",
  "liftedImportResolutionCount",
  "liftedImportShapingCount",
  "liftedPrunedDeclarationCount",
  "liftedDeclarationCount",
  "moduleExports",
]);
const SHARED_HELPER_ALLOWED_GLOBALS = new Set<string>([
  "Array",
  "ArrayBuffer",
  "BigInt",
  "Boolean",
  "Buffer",
  "Date",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "URIError",
  "URL",
  "URLSearchParams",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
]);
const RESERVED_IDENTIFIERS = new Set<string>([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const OBFUSCATED_ALIAS_STYLE_PATTERN = /^[A-Za-z_$]{1,2}\d*$/;
const IMPORT_ALIAS_PREFIX_BY_ARCHETYPE: Record<ArchetypeId, string> = {
  hook: "hook",
  service: "svc",
  ui: "ui",
  transport: "transport",
  store: "store",
};

interface HelperOccurrence {
  chunkId: string;
  helperName: string;
  helperText: string;
}

interface SharedHelperCandidate {
  helperName: string;
  helperText: string;
  chunkIds: Set<string>;
}

interface SharedHelperSelection {
  helperName: string;
  helperText: string;
  chunkIds: string[];
}

interface SharedHelperPoolResult {
  liftedChunks: LiftedChunkArtifact[];
  helperModuleContent: string;
  helperCount: number;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((segment, index) => {
      if (segment.length === 0) {
        return "";
      }
      if (index === 0) {
        return segment.charAt(0).toLowerCase() + segment.slice(1);
      }
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join("");
  if (cleaned.length === 0) {
    return "domainSymbol";
  }
  const head = cleaned.charAt(0);
  if (!/[A-Za-z_$]/.test(head)) {
    return `s${cleaned}`;
  }
  const normalized = RESERVED_IDENTIFIERS.has(cleaned) ? `${cleaned}Symbol` : cleaned;
  return normalized;
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
  if (normalized.length === 0) {
    return "Domain";
  }
  return normalized;
}

function sanitizeTypeIdentifier(value: string, fallback: string): string {
  const base = sanitizeIdentifier(value);
  const normalized = base.length > 0 ? `${base.charAt(0).toUpperCase()}${base.slice(1)}` : fallback;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function splitNameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
    .filter((token) => !GENERIC_SEGMENTS.has(token))
    .filter((token) => !NOISE_NAME_TOKENS.has(token));
}

function canonicalToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function dedupeNameTokens(tokens: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    const canonical = canonicalToken(token);
    const previous = result[result.length - 1];
    if (previous && canonicalToken(previous) === canonical) {
      continue;
    }
    if (seen.has(canonical)) {
      continue;
    }
    result.push(token);
    seen.add(canonical);
  }
  return result;
}

function statementBudgetForArchetype(archetype: ArchetypeId, baseBudget: number): number {
  const factor = ARCHETYPE_BUDGET_FACTOR[archetype];
  const minimum = ARCHETYPE_BUDGET_MIN[archetype];
  const floor = ARCHETYPE_SYMBOL_BUDGET_FLOOR[archetype];
  const scaled = Math.floor(baseBudget * factor);
  return Math.max(minimum, floor, scaled);
}

function sanitizeSegment(candidate: string, fallback: string): string {
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (normalized.length < 3) {
    return fallback;
  }
  if (GENERIC_SEGMENTS.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function kebabFromSymbol(symbolName: string): string {
  const normalizedName = symbolName.trim();
  const lower = normalizedName.toLowerCase();
  if (normalizedName.length <= 4 && /^[a-z]+$/i.test(normalizedName)) {
    return "domain";
  }
  if (RESERVED_IDENTIFIERS.has(lower)) {
    return "domain";
  }
  const quality = scoreNameQuality(symbolName);
  if (quality < 0.68) {
    return "domain";
  }
  return sanitizeSegment(
    symbolName
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .toLowerCase(),
    "domain",
  );
}

function clusterSegment(clusterId: string): string {
  const normalized = clusterId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (normalized.length < 6 || /\b[0-9a-f]{8,}\b/.test(normalized)) {
    return "cluster";
  }
  return normalized;
}

function fallbackTopicByArchetype(archetype: ArchetypeId): string {
  if (archetype === "hook") {
    return "hooks";
  }
  if (archetype === "service") {
    return "domain-service";
  }
  if (archetype === "ui") {
    return "ui-components";
  }
  if (archetype === "transport") {
    return "transport-bridge";
  }
  return "state-store";
}

function topicSegmentFromFilePath(filePath: string, archetype: ArchetypeId): string {
  const baseName = path.basename(filePath, ".ts");
  const prefix = `${archetype}-`;
  let candidate = baseName.startsWith(prefix) ? baseName.slice(prefix.length) : baseName;
  candidate = candidate.replace(/-g\d{3}-part-\d{3}(?:-quality-\d{2})?$/, "");
  candidate = candidate.replace(/-part-\d{3}(?:-v\d{2})?(?:-quality-\d{2})?$/, "");
  candidate = candidate.replace(/-v\d{2}(?:-quality-\d{2})?$/, "");
  candidate = candidate.replace(/-quality-\d{2}$/, "");
  const topic = sanitizeSegment(candidate, fallbackTopicByArchetype(archetype));
  if (topic === "domain") {
    return fallbackTopicByArchetype(archetype);
  }
  return topic;
}

function shouldKeepSymbolName(symbolName: string): boolean {
  if (isTemplateFallbackName(symbolName)) {
    return false;
  }
  if (isGenericName(symbolName)) {
    return false;
  }
  const quality = scoreNameQuality(symbolName);
  if (quality < SYMBOL_EXPORT_MIN_QUALITY) {
    return false;
  }
  if (/^[a-z]{3,4}\d*$/i.test(symbolName)) {
    return false;
  }
  return true;
}

function isTemplateFallbackName(symbolName: string): boolean {
  const normalized = symbolName.trim();
  if (normalized.length === 0) {
    return true;
  }
  for (const pattern of TEMPLATE_FALLBACK_NAME_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

function nextUniqueName(baseName: string, usedNames: Map<string, number>): string {
  const seen = usedNames.get(baseName) ?? 0;
  usedNames.set(baseName, seen + 1);
  return seen === 0 ? baseName : `${baseName}${seen + 1}`;
}

function nextUniqueIdentifier(baseName: string, usedNames: Set<string>): string {
  let candidate = baseName;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}${index}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function compactIdentifier(name: string, maxLength: number): string {
  if (name.length <= maxLength) {
    return name;
  }
  return name.slice(0, maxLength);
}

function isNoisyIdentifier(name: string): boolean {
  if (name.length <= 2) {
    return true;
  }
  if (/^[a-z]{1,2}\d*$/i.test(name)) {
    return true;
  }
  if (/^[A-Z][a-z]$/.test(name)) {
    return true;
  }
  if (/^[_$][A-Za-z0-9_$]*$/.test(name) && name.length <= 4) {
    return true;
  }
  return false;
}

function chunkTokensFromChunkId(chunkId: string): string[] {
  const normalized = chunkId.replace(/^chunk-/i, "");
  const tokens = normalized
    .split("-")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^[a-f0-9]{7,}$/i.test(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !GENERIC_SEGMENTS.has(token))
    .filter((token) => !NOISE_NAME_TOKENS.has(token))
    .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token));
  return dedupeNameTokens(tokens).slice(0, 2);
}

function isTailSaltSegment(segment: string): boolean {
  if (segment.length <= 2) {
    return true;
  }
  if (/^[a-f0-9]{7,}$/i.test(segment)) {
    return true;
  }
  const hasDigit = /\d/.test(segment);
  const hasUpper = /[A-Z]/.test(segment);
  const hasLower = /[a-z]/.test(segment);
  if (hasDigit) {
    return true;
  }
  if (hasUpper && hasLower) {
    return true;
  }
  return false;
}

function chunkTokensFromSourcePath(sourceFilePath: string): string[] {
  const baseName = path.basename(sourceFilePath, path.extname(sourceFilePath));
  const rawSegments = baseName
    .split(/[-_]+/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (rawSegments.length === 0) {
    return [];
  }

  let semanticEnd = rawSegments.length;
  while (semanticEnd > 0) {
    const tail = rawSegments[semanticEnd - 1];
    if (!tail) {
      semanticEnd -= 1;
      continue;
    }
    if (!isTailSaltSegment(tail)) {
      break;
    }
    semanticEnd -= 1;
  }

  const semanticSegments = rawSegments.slice(0, semanticEnd);
  const tokens = dedupeNameTokens(
    semanticSegments
      .flatMap((segment) => splitNameTokens(segment))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token)),
  );
  return tokens.slice(0, 3);
}

function buildChunkTopicTokensById(chunks: ChunkArtifactModel["chunks"]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const chunk of chunks) {
    const fromPath = chunkTokensFromSourcePath(chunk.sourceFilePath);
    if (fromPath.length > 0) {
      byId.set(chunk.chunkId, fromPath);
      continue;
    }
    byId.set(chunk.chunkId, chunkTokensFromChunkId(chunk.chunkId));
  }
  return byId;
}

function clusterTokensFromDeclaration(clusterId: string): string[] {
  const normalized = clusterId.replace(/^cluster-/i, "");
  const rawTokens = normalized
    .split("-")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^[a-f0-9]{8,}$/i.test(token))
    .filter((token) => !GENERIC_SEGMENTS.has(token))
    .filter((token) => !NOISE_NAME_TOKENS.has(token))
    .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token));
  return dedupeNameTokens(rawTokens).slice(0, 2);
}

function tokenizeSemanticSignalValue(value: string): string[] {
  return dedupeNameTokens(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token)),
  );
}

function buildEmitterSignalContext(semanticIr: SemanticIrModel): EmitterSignalContext {
  const symbolsByName = new Map<string, string[]>();
  for (const symbol of semanticIr.symbols) {
    const key = symbol.name.toLowerCase();
    const existing = symbolsByName.get(key);
    if (existing) {
      existing.push(symbol.symbolKey);
      continue;
    }
    symbolsByName.set(key, [symbol.symbolKey]);
  }

  const ownerStateTokens = new Map<string, Set<string>>();
  for (const stateKey of semanticIr.stateKeys) {
    for (const owner of stateKey.owners) {
      const bucket = ownerStateTokens.get(owner) ?? new Set<string>();
      for (const token of stateKey.tokens) {
        bucket.add(token);
      }
      ownerStateTokens.set(owner, bucket);
    }
  }

  const callNeighboursBySymbol = new Map<string, Set<string>>();
  for (const declaration of semanticIr.domainDeclarations) {
    const bucket = callNeighboursBySymbol.get(declaration.symbolKey) ?? new Set<string>();
    for (const neighbour of declaration.callNeighbours) {
      for (const token of tokenizeSemanticSignalValue(neighbour)) {
        bucket.add(token);
      }
    }
    callNeighboursBySymbol.set(declaration.symbolKey, bucket);
  }

  for (const edge of semanticIr.callEdges) {
    const callerCandidates = symbolsByName.get(edge.caller.toLowerCase()) ?? [];
    const calleeCandidates = symbolsByName.get(edge.callee.toLowerCase()) ?? [];
    const callerKey = callerCandidates.length === 1 ? callerCandidates[0] : undefined;
    const calleeKey = calleeCandidates.length === 1 ? calleeCandidates[0] : undefined;
    if (!callerKey || !calleeKey || callerKey === calleeKey) {
      continue;
    }
    const callerBucket = callNeighboursBySymbol.get(callerKey) ?? new Set<string>();
    const calleeBucket = callNeighboursBySymbol.get(calleeKey) ?? new Set<string>();
    for (const token of tokenizeSemanticSignalValue(edge.callee)) {
      callerBucket.add(token);
    }
    for (const token of tokenizeSemanticSignalValue(edge.caller)) {
      calleeBucket.add(token);
    }
    callNeighboursBySymbol.set(callerKey, callerBucket);
    callNeighboursBySymbol.set(calleeKey, calleeBucket);
  }

  const declarationBySymbolKey = new Map<string, SemanticIrModel["domainDeclarations"][number]>();
  for (const declaration of semanticIr.domainDeclarations) {
    declarationBySymbolKey.set(declaration.symbolKey, declaration);
  }

  const symbolSignalByKey = new Map<string, SymbolSignalDescriptor>();
  for (const symbol of semanticIr.symbols) {
    const declaration = declarationBySymbolKey.get(symbol.symbolKey);
    const signalTokens = new Set<string>();
    const callGraphTokens = new Set<string>();
    const stateTokens = new Set<string>();

    if (declaration) {
      for (const stateSignal of declaration.stateSignals) {
        for (const token of tokenizeSemanticSignalValue(stateSignal)) {
          signalTokens.add(token);
          stateTokens.add(token);
        }
      }
      const callTokens = callNeighboursBySymbol.get(symbol.symbolKey) ?? new Set<string>();
      for (const token of callTokens) {
        signalTokens.add(token);
        callGraphTokens.add(token);
      }
      const ownerSignals = ownerStateTokens.get(declaration.ownerLineageId) ?? new Set<string>();
      for (const token of ownerSignals) {
        signalTokens.add(token);
        stateTokens.add(token);
      }
      if (declaration.routeFlowScore >= 0.5) {
        signalTokens.add("route");
      }
      if (declaration.eventFlowScore >= 0.5) {
        signalTokens.add("event");
      }
    }

    symbolSignalByKey.set(symbol.symbolKey, {
      symbolKey: symbol.symbolKey,
      routeFlowScore: declaration ? declaration.routeFlowScore : 0,
      eventFlowScore: declaration ? declaration.eventFlowScore : 0,
      signalTokens: dedupeNameTokens([...signalTokens]).slice(0, 8),
      callGraphTokens: dedupeNameTokens([...callGraphTokens]).slice(0, 6),
      stateTokens: dedupeNameTokens([...stateTokens]).slice(0, 6),
    });
  }

  return {
    symbolSignalByKey,
  };
}

function domainRenameConfidence(baseName: string, candidateName: string): number {
  const baseQuality = scoreNameQuality(baseName);
  const candidateQuality = scoreNameQuality(candidateName);
  const qualityGain = Math.max(0, candidateQuality - baseQuality);
  const genericUpgrade = isGenericName(baseName) && !isGenericName(candidateName) ? 0.2 : 0;
  return clamp(candidateQuality * 0.62 + qualityGain * 0.24 + genericUpgrade * 0.14);
}

function buildDomainRenameHints(
  ownershipModel: OwnershipModel,
  signalContext: EmitterSignalContext,
): Map<string, DomainRenameHint> {
  const hintsBySymbol = new Map<string, DomainRenameHint>();
  const usedNames = new Set<string>();
  const sortedSymbols = [...ownershipModel.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  for (const symbol of sortedSymbols) {
    const signals = signalContext.symbolSignalByKey.get(symbol.symbolKey);
    if (!signals || signals.signalTokens.length === 0) {
      continue;
    }
    const rankedTokens = dedupeNameTokens([
      ...signals.stateTokens,
      ...signals.callGraphTokens,
      ...signals.signalTokens,
      ...chunkHintTokens(symbol.chunkHint),
    ])
      .filter((token) => token.length >= 3)
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .slice(0, 2);
    if (rankedTokens.length === 0) {
      continue;
    }

    const roleSuffix = archetypeRoleSuffix(symbol.archetype);
    const stem = rankedTokens.map((token) => toPascalCase(token)).join("");
    const candidateBase = symbol.archetype === "hook"
      ? `use${stem}${roleSuffix}`
      : `${stem}${roleSuffix}`;
    const candidate = sanitizeIdentifier(candidateBase);
    const confidence = domainRenameConfidence(symbol.symbolName, candidate);
    if (confidence < 0.58) {
      continue;
    }
    if (isNoisyIdentifier(candidate) || OBFUSCATED_ALIAS_STYLE_PATTERN.test(candidate)) {
      continue;
    }
    if (usedNames.has(candidate)) {
      continue;
    }
    usedNames.add(candidate);
    hintsBySymbol.set(symbol.symbolKey, {
      symbolKey: symbol.symbolKey,
      preferredName: candidate,
      hintTokens: rankedTokens,
      confidence,
    });
  }
  return hintsBySymbol;
}

function alignTokensToChunkHints(tokens: string[], chunkHints: string[]): string[] {
  if (tokens.length === 0 || chunkHints.length === 0) {
    return tokens;
  }
  const canonicalHints = chunkHints.map((token) => canonicalToken(token));
  const aligned: string[] = [];
  for (const token of tokens) {
    const normalizedToken = token.toLowerCase().replace(/^(store|service|hook|ui|transport)/i, "");
    const canonical = canonicalToken(normalizedToken);
    const directHint = canonicalHints.find((hint) => hint === canonical);
    if (directHint) {
      aligned.push(directHint);
      continue;
    }
    const prefixHint = canonicalHints.find((hint) => canonical.startsWith(hint) && canonical.length > hint.length + 1);
    if (prefixHint) {
      aligned.push(prefixHint);
    }
  }
  if (aligned.length > 0) {
    return dedupeNameTokens(aligned);
  }
  return tokens;
}

function bindingSignalTokens(
  liftBinding: LiftedSymbolBinding | undefined,
  chunkTopicTokensById: Map<string, string[]>,
): string[] {
  if (!liftBinding) {
    return [];
  }
  const chunkHints = chunkTopicTokensById.get(liftBinding.chunkId) ?? chunkTokensFromChunkId(liftBinding.chunkId);
  const sourceStem = liftBinding.sourceIdentifier.replace(/^(store|service|hook|ui|transport)/i, "");
  const sourceTokensRaw = !isNoisyIdentifier(sourceStem) && scoreNameQuality(sourceStem) >= 0.56 ? splitNameTokens(sourceStem) : [];
  const exportStem = liftBinding.exportName
    .replace(/symbol\d+$/i, "")
    .replace(/lifted$/i, "")
    .replace(/^(store|service|hook|ui|transport)/i, "");
  const exportTokensRaw = splitNameTokens(exportStem);
  const sourceTokens = alignTokensToChunkHints(sourceTokensRaw, chunkHints);
  const exportTokens = alignTokensToChunkHints(exportTokensRaw, chunkHints);
  const chunkTokens = chunkHints;
  const merged = dedupeNameTokens([...sourceTokens, ...exportTokens, ...chunkTokens]);
  return merged.filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token)).slice(0, 3);
}

function chunkHintTokens(chunkHint: string): string[] {
  if (chunkHint.trim().length === 0) {
    return [];
  }
  if (/^\d+$/.test(chunkHint.trim())) {
    return [];
  }
  return splitNameTokens(chunkHint)
    .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
    .slice(0, 2);
}

function symbolOrdinalToken(symbolKey: string, ordinal: number): string {
  const tail = symbolKey.split(":").pop()?.trim() ?? "";
  if (/^\d+$/.test(tail)) {
    return `entry${tail}`;
  }
  if (/^[a-z][a-z0-9]{2,}$/i.test(tail)) {
    return tail.toLowerCase();
  }
  return `entry${ordinal}`;
}

function archetypeRoleSuffix(archetype: ArchetypeId): string {
  if (archetype === "hook") {
    return "Hook";
  }
  if (archetype === "ui") {
    return "Component";
  }
  if (archetype === "transport") {
    return "Bridge";
  }
  if (archetype === "store") {
    return "State";
  }
  return "Service";
}

function normalizeSemanticToken(token: string, plan: ModulePlan, symbol: OwnershipRecord): string {
  let normalized = token.toLowerCase().replace(/^\d+/, "");
  const removablePrefixes = [
    plan.archetype,
    plan.layer,
    symbol.domainKind,
    "store",
    "service",
    "transport",
    "renderer",
    "main",
    "tauri",
    "hook",
    "ui",
    "state",
    "domain",
  ];
  for (const prefix of removablePrefixes) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length + 2) {
      normalized = normalized.slice(prefix.length);
    }
  }
  return normalized;
}

function buildSignalDrivenBaseName(
  symbol: OwnershipRecord,
  plan: ModulePlan,
  topic: string,
  ordinal: number,
  liftBinding: LiftedSymbolBinding | undefined,
  chunkTopicTokensById: Map<string, string[]>,
  renameHint: DomainRenameHint | undefined,
  signalContext: EmitterSignalContext,
): string {
  const signalDescriptor = signalContext.symbolSignalByKey.get(symbol.symbolKey);
  const domainTokens = splitNameTokens(symbol.domainKind);
  const layerTokens = splitNameTokens(plan.layer);
  const topicTokens = splitNameTokens(topic);
  const clusterTokens = clusterTokensFromDeclaration(symbol.declarationClusterId);
  const bindingTokens = bindingSignalTokens(liftBinding, chunkTopicTokensById);
  const hintTokens = chunkHintTokens(symbol.chunkHint);
  const renameHintTokens = renameHint ? renameHint.hintTokens : [];
  const callGraphTokens = signalDescriptor ? signalDescriptor.callGraphTokens : [];
  const stateSignalTokens = signalDescriptor ? signalDescriptor.stateTokens : [];
  const flowTokens: string[] = [];
  if (signalDescriptor && signalDescriptor.routeFlowScore >= 0.5) {
    flowTokens.push("route");
  }
  if (signalDescriptor && signalDescriptor.eventFlowScore >= 0.5) {
    flowTokens.push("event");
  }
  const semanticTokens = dedupeNameTokens(
    [
      ...renameHintTokens,
      ...stateSignalTokens,
      ...callGraphTokens,
      ...flowTokens,
      ...bindingTokens,
      ...hintTokens,
      ...clusterTokens,
      ...topicTokens,
      ...domainTokens,
      ...layerTokens,
    ]
      .map((token) => normalizeSemanticToken(token, plan, symbol))
      .filter((token) => token.length >= 3)
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
      .filter((token) => !GENERIC_SEGMENTS.has(token)),
  );

  const qualifierTokens = semanticTokens
    .filter((token) => token !== plan.archetype && token !== symbol.domainKind && token !== plan.layer)
    .slice(0, 2);
  if (qualifierTokens.length === 0) {
    qualifierTokens.push(symbolOrdinalToken(symbol.symbolKey, ordinal));
  }

  const roleSuffix = archetypeRoleSuffix(plan.archetype);
  if (plan.archetype === "hook") {
    const hookStem = qualifierTokens.map((token) => toPascalCase(token)).join("");
    const fallbackStem = `Domain${ordinal}`;
    return sanitizeIdentifier(`use${hookStem.length > 0 ? hookStem : fallbackStem}${roleSuffix}`);
  }

  const parts = [plan.archetype, ...qualifierTokens, roleSuffix];
  const stem = parts.map((token) => toPascalCase(token)).join("");
  const fallbackStem = `${toPascalCase(plan.archetype)}${toPascalCase(roleSuffix)}${ordinal}`;
  return sanitizeIdentifier(stem.length > 0 ? stem : fallbackStem);
}

function buildReadableImportAliasBase(
  exportName: string,
  sourceExportName: string,
  plan: ModulePlan,
  renameHint: DomainRenameHint | undefined,
): string {
  const exportTokens = dedupeNameTokens(splitNameTokens(exportName));
  const sourceTokens = dedupeNameTokens(splitNameTokens(sourceExportName));
  const hintTokens = renameHint ? renameHint.hintTokens : [];
  const semanticTokens = dedupeNameTokens([...hintTokens, ...exportTokens, ...sourceTokens])
    .filter((token) => token.length >= 3)
    .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
    .slice(0, 2);
  const stem = semanticTokens.length > 0 ? semanticTokens.map((token) => toPascalCase(token)).join("") : "Domain";
  const prefix = IMPORT_ALIAS_PREFIX_BY_ARCHETYPE[plan.archetype];
  const alias = compactIdentifier(sanitizeIdentifier(`${prefix}${stem}`), 28);
  if (isNoisyIdentifier(alias) || OBFUSCATED_ALIAS_STYLE_PATTERN.test(alias)) {
    return sanitizeIdentifier(`${prefix}DomainRef`);
  }
  return alias;
}

function buildDomainExportName(
  symbol: OwnershipRecord,
  plan: ModulePlan,
  topic: string,
  ordinal: number,
  usedNames: Map<string, number>,
  renameHint: DomainRenameHint | undefined,
  signalContext: EmitterSignalContext,
  liftBinding?: LiftedSymbolBinding,
  chunkTopicTokensById: Map<string, string[]> = new Map<string, string[]>(),
): string {
  if (renameHint && renameHint.confidence >= 0.62) {
    return nextUniqueName(sanitizeIdentifier(renameHint.preferredName), usedNames);
  }
  if (shouldKeepSymbolName(symbol.symbolName)) {
    return nextUniqueName(sanitizeIdentifier(symbol.symbolName), usedNames);
  }
  const base = buildSignalDrivenBaseName(
    symbol,
    plan,
    topic,
    ordinal,
    liftBinding,
    chunkTopicTokensById,
    renameHint,
    signalContext,
  );
  return nextUniqueName(base, usedNames);
}

function pickAnchorSymbol(symbols: OwnershipRecord[]): OwnershipRecord {
  if (symbols.length === 0) {
    throw new Error("pickAnchorSymbol: empty symbol list");
  }
  const ranked = [...symbols].sort((left, right) => {
    const leftScore = scoreNameQuality(left.symbolName) * 0.72 + left.confidence * 0.28;
    const rightScore = scoreNameQuality(right.symbolName) * 0.72 + right.confidence * 0.28;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.symbolKey.localeCompare(right.symbolKey);
  });
  const winner = ranked[0];
  if (!winner) {
    throw new Error("pickAnchorSymbol: no winner");
  }
  return winner;
}

function topicSegmentForChunk(archetype: ArchetypeId, symbols: OwnershipRecord[], clusterId: string): string {
  const ranked = [...symbols].sort((left, right) => {
    const leftQuality = scoreNameQuality(left.symbolName);
    const rightQuality = scoreNameQuality(right.symbolName);
    if (leftQuality !== rightQuality) {
      return rightQuality - leftQuality;
    }
    return left.symbolName.localeCompare(right.symbolName);
  });
  for (const symbol of ranked) {
    if (scoreNameQuality(symbol.symbolName) < 0.68) {
      continue;
    }
    const segment = kebabFromSymbol(symbol.symbolName);
    if (segment !== "domain") {
      return segment;
    }
  }

  const clusterTopic = clusterSegment(clusterId);
  if (clusterTopic !== "cluster") {
    return clusterTopic;
  }
  return fallbackTopicByArchetype(archetype);
}

function fallbackFileTopicForArchetype(archetype: ArchetypeId): string {
  if (archetype === "hook") {
    return "flow";
  }
  if (archetype === "ui") {
    return "view";
  }
  if (archetype === "transport") {
    return "bridge";
  }
  if (archetype === "store") {
    return "state";
  }
  return "domain";
}

function buildModuleFileName(archetype: ArchetypeId, topic: string, partSuffix: string): string {
  const topicTokens = topic
    .split("-")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const filteredTokens = dedupeNameTokens(
    topicTokens.filter((token) => token !== archetype).filter((token) => !GENERIC_SEGMENTS.has(token)),
  );
  const topicStem = filteredTokens.length > 0 ? filteredTokens.join("-") : fallbackFileTopicForArchetype(archetype);
  return sanitizeSegment(`${archetype}-${topicStem}${partSuffix}`, `${archetype}-${fallbackFileTopicForArchetype(archetype)}${partSuffix}`);
}

function splitByBudget<T>(items: T[], budget: number): T[][] {
  if (budget < 1) {
    throw new Error("statement budget must be >= 1");
  }
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += budget) {
    result.push(items.slice(offset, offset + budget));
  }
  return result;
}

function layerDirectory(layer: LayerId): string {
  if (layer === "main") {
    return "src/main";
  }
  if (layer === "renderer") {
    return "src/renderer";
  }
  if (layer === "services") {
    return "src/services";
  }
  return "src-tauri-adapter";
}

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function average(numbers: number[]): number {
  if (numbers.length === 0) {
    return 0;
  }
  const total = numbers.reduce((sum, entry) => sum + entry, 0);
  return total / numbers.length;
}

function computeModuleQuality(plan: ModulePlan, bindingByKey: Map<string, LiftedSymbolBinding>): ModuleQualityEntry {
  const symbolCount = plan.symbols.length;
  const averageConfidence = average(plan.symbols.map((symbol) => symbol.confidence));
  const averageNameQuality = average(plan.symbols.map((symbol) => scoreNameQuality(symbol.symbolName)));
  const liftedSymbolCount = plan.symbols.reduce((count, symbol) => count + (bindingByKey.has(symbol.symbolKey) ? 1 : 0), 0);
  const liftedCoverage = symbolCount > 0 ? liftedSymbolCount / symbolCount : 0;
  const score = clamp(averageConfidence * 0.43 + averageNameQuality * 0.35 + liftedCoverage * 0.22);
  return {
    moduleId: plan.moduleId,
    filePath: plan.filePath,
    score,
    symbolCount,
    averageConfidence: clamp(averageConfidence),
    averageNameQuality: clamp(averageNameQuality),
    liftedCoverage: clamp(liftedCoverage),
    rerendered: false,
  };
}

function buildOwnershipSubset(base: OwnershipModel, symbols: OwnershipRecord[]): OwnershipModel {
  return {
    ...base,
    generatedAtIso: new Date().toISOString(),
    symbols: [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
}

function buildMonolithTopicHints(monolithLayoutHints: MonolithLayoutHintsModel): MonolithTopicHints {
  const hintMaps = buildMonolithLayoutHintMaps(monolithLayoutHints);
  const bySymbolKey = new Map<string, string>();
  const bySymbolName = new Map<string, string>();
  for (const [symbolKey, entry] of hintMaps.bySymbolKey.entries()) {
    const topic = sanitizeSegment(entry.topic, bucketTopicFallback(entry.semanticBucket));
    bySymbolKey.set(symbolKey, topic);
  }
  for (const [symbolName, entry] of hintMaps.byFinalName.entries()) {
    const topic = sanitizeSegment(entry.topic, bucketTopicFallback(entry.semanticBucket));
    bySymbolName.set(symbolName, topic);
  }
  return {
    bySymbolKey,
    bySymbolName,
  };
}

function bucketTopicFallback(bucket: string): string {
  if (bucket === "parse") {
    return "parser";
  }
  if (bucket === "sum") {
    return "math";
  }
  if (bucket === "state") {
    return "state";
  }
  return "flow";
}

function topicSegmentForSymbol(
  symbol: OwnershipRecord,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  monolithTopicHints: MonolithTopicHints,
): string {
  const monolithByKey = monolithTopicHints.bySymbolKey.get(symbol.symbolKey);
  if (monolithByKey) {
    return monolithByKey;
  }
  const monolithByName = monolithTopicHints.bySymbolName.get(symbol.symbolName);
  if (monolithByName) {
    return monolithByName;
  }
  const renameHint = renameHintsBySymbolKey.get(symbol.symbolKey);
  const symbolicName = renameHint ? renameHint.preferredName : symbol.symbolName;
  const direct = kebabFromSymbol(symbolicName);
  if (direct !== "domain") {
    return direct;
  }
  if (renameHint && renameHint.hintTokens.length > 0) {
    const hintTopic = sanitizeSegment(renameHint.hintTokens.join("-"), "domain");
    if (hintTopic !== "domain") {
      return hintTopic;
    }
  }
  return fallbackTopicByArchetype(symbol.archetype);
}

function splitBalanced<T>(items: T[], parts: number): T[][] {
  if (parts < 1) {
    throw new Error(`splitBalanced: parts must be >= 1, got ${parts}`);
  }
  if (items.length === 0) {
    return [];
  }
  const boundedParts = Math.max(1, Math.min(parts, items.length));
  const result: T[][] = [];
  let offset = 0;
  for (let index = 0; index < boundedParts; index += 1) {
    const remainingItems = items.length - offset;
    const remainingParts = boundedParts - index;
    const size = Math.ceil(remainingItems / remainingParts);
    result.push(items.slice(offset, offset + size));
    offset += size;
  }
  return result.filter((part) => part.length > 0);
}

function splitTopicSymbols(symbols: OwnershipRecord[], chunkBudget: number): OwnershipRecord[][] {
  const initial = splitByBudget(symbols, chunkBudget);
  if (initial.length <= 1) {
    return initial;
  }
  const minPartCountByHardLimit = Math.max(1, Math.ceil(symbols.length / HARD_SYMBOL_LIMIT_PER_MODULE));
  const targetPartCount = Math.max(
    minPartCountByHardLimit,
    Math.min(MAX_PARTS_PER_TOPIC, initial.length),
  );
  if (targetPartCount >= initial.length) {
    return initial;
  }
  return splitBalanced(symbols, targetPartCount);
}

function buildModulePlans(
  ownershipModel: OwnershipModel,
  statementBudget: number,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  monolithTopicHints: MonolithTopicHints,
): ModulePlan[] {
  const buckets = new Map<string, OwnershipRecord[]>();
  const sortedSymbols = [...ownershipModel.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  for (const symbol of sortedSymbols) {
    assertArchetypeLayerCompatibility(symbol.layer, symbol.archetype, symbol.symbolKey);
    const topic = topicSegmentForSymbol(symbol, renameHintsBySymbolKey, monolithTopicHints);
    const key = `${symbol.layer}::${symbol.archetype}::${topic}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(symbol);
      continue;
    }
    buckets.set(key, [symbol]);
  }

  const plans: ModulePlan[] = [];
  for (const layer of LAYER_ORDER) {
    for (const archetype of ARCHETYPE_ORDER) {
      const groupedByTopic = [...buckets.entries()]
        .filter(([key]) => key.startsWith(`${layer}::${archetype}::`))
        .sort(([left], [right]) => left.localeCompare(right));
      for (const [topicKey, symbols] of groupedByTopic) {
        if (symbols.length === 0) {
          continue;
        }
        const topic = topicKey.split("::")[2] ?? fallbackTopicByArchetype(archetype);
        const byName = [...symbols].sort((left, right) => left.symbolName.localeCompare(right.symbolName));
        const chunkBudget = statementBudgetForArchetype(archetype, statementBudget);
        const chunks = splitTopicSymbols(byName, chunkBudget);
        for (let partIndex = 0; partIndex < chunks.length; partIndex += 1) {
          const partSymbols = chunks[partIndex];
          if (!partSymbols || partSymbols.length === 0) {
            continue;
          }
          const hasMultipleParts = chunks.length > 1;
          const partSuffix = hasMultipleParts ? `-part-${String(partIndex + 1).padStart(3, "0")}` : "";
          const moduleFileName = buildModuleFileName(archetype, topic, partSuffix);
          const modulePartId = hasMultipleParts ? `:part-${String(partIndex + 1).padStart(3, "0")}` : "";
          plans.push({
            layer,
            archetype,
            clusterId: topic,
            topic,
            moduleId: `${layer}:${archetype}:${topic}${modulePartId}`,
            symbols: partSymbols,
            filePath: `${layerDirectory(layer)}/${archetype}/${moduleFileName}.ts`,
          });
        }
      }
    }
  }

  return plans.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function applyFileQualityRerender(
  modulePlans: ModulePlan[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
  statementBudget: number,
): { modulePlans: ModulePlan[]; qualityEntries: ModuleQualityEntry[]; rerenderedModuleCount: number } {
  if (modulePlans.length === 0) {
    return {
      modulePlans: [],
      qualityEntries: [],
      rerenderedModuleCount: 0,
    };
  }

  const orderedPlans = [...modulePlans].sort((left, right) => left.filePath.localeCompare(right.filePath));
  const baselineEntries = orderedPlans.map((plan) => computeModuleQuality(plan, bindingByKey));
  const worstTargetCount = Math.max(1, Math.ceil(orderedPlans.length * FILE_QUALITY_WORST_PERCENT));
  const worstCandidates = [...baselineEntries]
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, worstTargetCount)
    .filter((entry) => entry.symbolCount >= 8);

  const rerenderedPlanByModuleId = new Map<string, ModulePlan[]>();
  for (const candidate of worstCandidates) {
    const plan = orderedPlans.find((entry) => entry.moduleId === candidate.moduleId);
    if (!plan) {
      continue;
    }
    const baseBudget = statementBudgetForArchetype(plan.archetype, statementBudget);
    const reducedBudget = Math.max(ARCHETYPE_BUDGET_MIN[plan.archetype], Math.floor(baseBudget * 0.55));
    const targetPartCount = Math.max(2, Math.ceil(plan.symbols.length / Math.max(1, reducedBudget)));
    if (targetPartCount <= 1 || plan.symbols.length <= 1) {
      continue;
    }
    const parts = splitBalanced(plan.symbols, Math.min(MAX_PARTS_PER_TOPIC, targetPartCount));
    if (parts.length <= 1) {
      continue;
    }
    const nextPlans: ModulePlan[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const symbols = parts[partIndex];
      if (!symbols || symbols.length === 0) {
        continue;
      }
      const partSuffix = `-quality-${String(partIndex + 1).padStart(2, "0")}`;
      const filePath = plan.filePath.replace(/\.ts$/, `${partSuffix}.ts`);
      nextPlans.push({
        layer: plan.layer,
        archetype: plan.archetype,
        clusterId: plan.clusterId,
        topic: plan.topic,
        moduleId: `${plan.moduleId}:quality-${String(partIndex + 1).padStart(2, "0")}`,
        symbols,
        filePath,
      });
    }
    if (nextPlans.length > 1) {
      rerenderedPlanByModuleId.set(plan.moduleId, nextPlans);
    }
  }

  const rerenderedModuleIds = new Set<string>(rerenderedPlanByModuleId.keys());
  const finalPlans: ModulePlan[] = [];
  for (const plan of orderedPlans) {
    const replacement = rerenderedPlanByModuleId.get(plan.moduleId);
    if (replacement && replacement.length > 0) {
      finalPlans.push(...replacement);
      continue;
    }
    finalPlans.push(plan);
  }

  finalPlans.sort((left, right) => left.filePath.localeCompare(right.filePath));
  const qualityEntries = finalPlans.map((plan) => {
    const entry = computeModuleQuality(plan, bindingByKey);
    const originalIdRaw = plan.moduleId.split(":quality-")[0];
    const originalId = originalIdRaw && originalIdRaw.length > 0 ? originalIdRaw : plan.moduleId;
    return {
      ...entry,
      rerendered: rerenderedModuleIds.has(originalId),
    };
  });

  return {
    modulePlans: finalPlans,
    qualityEntries,
    rerenderedModuleCount: rerenderedModuleIds.size,
  };
}

function buildCohesionTokensForSymbol(
  symbol: OwnershipRecord,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): string[] {
  const renameHint = renameHintsBySymbolKey.get(symbol.symbolKey);
  const signal = signalContext.symbolSignalByKey.get(symbol.symbolKey);
  const tokens = dedupeNameTokens([
    ...(renameHint ? renameHint.hintTokens : []),
    ...splitNameTokens(renameHint ? renameHint.preferredName : symbol.symbolName),
    ...(signal ? signal.signalTokens : []),
    ...chunkHintTokens(symbol.chunkHint),
  ])
    .filter((token) => token.length >= 3)
    .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
    .slice(0, 6);
  return tokens;
}

function tokenOverlapRatio(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }
  const union = new Set<string>([...leftSet, ...rightSet]).size;
  if (union === 0) {
    return 0;
  }
  return overlap / union;
}

function moduleCohesionScore(
  plan: ModulePlan,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): number {
  if (plan.symbols.length <= 1) {
    return 1;
  }
  const tokenSets = plan.symbols.map((symbol) => buildCohesionTokensForSymbol(symbol, renameHintsBySymbolKey, signalContext));
  let total = 0;
  let pairs = 0;
  for (let leftIndex = 0; leftIndex < tokenSets.length; leftIndex += 1) {
    const left = tokenSets[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < tokenSets.length; rightIndex += 1) {
      const right = tokenSets[rightIndex];
      if (!right) {
        continue;
      }
      total += tokenOverlapRatio(left, right);
      pairs += 1;
      if (pairs >= 72) {
        break;
      }
    }
    if (pairs >= 72) {
      break;
    }
  }
  if (pairs === 0) {
    return 0;
  }
  return clamp(total / pairs);
}

function mergeTopics(left: string, right: string, archetype: ArchetypeId): string {
  const leftTokens = left.split("-").filter((token) => token.length > 0);
  const rightTokens = right.split("-").filter((token) => token.length > 0);
  const shared = dedupeNameTokens(leftTokens.filter((token) => rightTokens.includes(token))).slice(0, 2);
  if (shared.length > 0) {
    return sanitizeSegment(shared.join("-"), fallbackTopicByArchetype(archetype));
  }
  const combined = dedupeNameTokens([...leftTokens, ...rightTokens]).slice(0, 2);
  if (combined.length > 0) {
    return sanitizeSegment(combined.join("-"), fallbackTopicByArchetype(archetype));
  }
  return fallbackTopicByArchetype(archetype);
}

function rebuildModulePlanIdentity(plan: ModulePlan, groupIndex: number): ModulePlan {
  const mergeSuffix = groupIndex > 0 ? `-g${String(groupIndex + 1).padStart(3, "0")}` : "";
  const fileName = buildModuleFileName(plan.archetype, plan.topic, mergeSuffix);
  return {
    ...plan,
    moduleId: `${plan.layer}:${plan.archetype}:${plan.topic}${mergeSuffix}`,
    filePath: `${layerDirectory(plan.layer)}/${plan.archetype}/${fileName}.ts`,
  };
}

function splitPlanByCohesion(
  plan: ModulePlan,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): ModulePlan[] {
  if (plan.symbols.length < COHESION_SPLIT_MIN_SYMBOLS) {
    return [plan];
  }
  const cohesion = moduleCohesionScore(plan, renameHintsBySymbolKey, signalContext);
  if (cohesion >= COHESION_SPLIT_THRESHOLD) {
    return [plan];
  }

  const buckets = new Map<string, OwnershipRecord[]>();
  for (const symbol of plan.symbols) {
    const tokens = buildCohesionTokensForSymbol(symbol, renameHintsBySymbolKey, signalContext);
    const head = tokens[0] ?? "domain";
    const bucket = buckets.get(head) ?? [];
    bucket.push(symbol);
    buckets.set(head, bucket);
  }
  const rankedBuckets = [...buckets.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 2);
  if (rankedBuckets.length < 2) {
    return [plan];
  }
  const parts: ModulePlan[] = [];
  for (let index = 0; index < rankedBuckets.length; index += 1) {
    const bucket = rankedBuckets[index];
    if (!bucket) {
      continue;
    }
    const [token, symbols] = bucket;
    const partTopic = sanitizeSegment(`${plan.topic}-${token}`, plan.topic);
    parts.push({
      ...plan,
      topic: partTopic,
      clusterId: partTopic,
      moduleId: `${plan.moduleId}:cohesion-${String(index + 1).padStart(2, "0")}`,
      symbols: [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
      filePath: plan.filePath.replace(/\.ts$/, `-cohesion-${String(index + 1).padStart(2, "0")}.ts`),
    });
  }
  const splitSymbolsCount = parts.reduce((sum, entry) => sum + entry.symbols.length, 0);
  if (splitSymbolsCount < plan.symbols.length) {
    return [plan];
  }
  return parts;
}

function applyCohesionMergeSplit(
  modulePlans: ModulePlan[],
  statementBudget: number,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): ModulePlan[] {
  if (modulePlans.length === 0) {
    return [];
  }
  const groupedPlans = new Map<string, ModulePlan[]>();
  for (const plan of modulePlans) {
    const key = `${plan.layer}:${plan.archetype}`;
    const bucket = groupedPlans.get(key) ?? [];
    bucket.push(plan);
    groupedPlans.set(key, bucket);
  }

  const mergedPlans: ModulePlan[] = [];
  const groupedKeys = [...groupedPlans.keys()].sort((left, right) => left.localeCompare(right));
  for (const key of groupedKeys) {
    const plans = groupedPlans.get(key);
    if (!plans || plans.length === 0) {
      continue;
    }
    const ordered = [...plans].sort((left, right) => left.filePath.localeCompare(right.filePath));
    let current = ordered[0];
    if (!current) {
      continue;
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const candidate = ordered[index];
      if (!candidate) {
        continue;
      }
      const budget = statementBudgetForArchetype(current.archetype, statementBudget);
      const combinedSize = current.symbols.length + candidate.symbols.length;
      const currentTokens = dedupeNameTokens(current.topic.split("-").filter((token) => token.length > 0));
      const candidateTokens = dedupeNameTokens(candidate.topic.split("-").filter((token) => token.length > 0));
      const topicOverlap = tokenOverlapRatio(currentTokens, candidateTokens);
      const canMerge =
        combinedSize <= Math.min(MODULE_MERGE_MAX_SYMBOLS, Math.floor(budget * 1.35)) &&
        topicOverlap >= COHESION_MERGE_THRESHOLD &&
        current.symbols.length <= Math.max(16, Math.floor(budget * 0.8)) &&
        candidate.symbols.length <= Math.max(16, Math.floor(budget * 0.8));
      if (!canMerge) {
        mergedPlans.push(current);
        current = candidate;
        continue;
      }
      const mergedTopic = mergeTopics(current.topic, candidate.topic, current.archetype);
      current = {
        ...current,
        topic: mergedTopic,
        clusterId: mergedTopic,
        symbols: [...current.symbols, ...candidate.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
      };
    }
    mergedPlans.push(current);
  }

  const splitPlans: ModulePlan[] = [];
  for (const plan of mergedPlans) {
    const split = splitPlanByCohesion(plan, renameHintsBySymbolKey, signalContext);
    splitPlans.push(...split);
  }

  const groupIndexByKey = new Map<string, number>();
  const finalized = [...splitPlans]
    .sort((left, right) => {
      if (left.layer !== right.layer) {
        return LAYER_ORDER.indexOf(left.layer) - LAYER_ORDER.indexOf(right.layer);
      }
      if (left.archetype !== right.archetype) {
        return ARCHETYPE_ORDER.indexOf(left.archetype) - ARCHETYPE_ORDER.indexOf(right.archetype);
      }
      if (left.topic !== right.topic) {
        return left.topic.localeCompare(right.topic);
      }
      return left.moduleId.localeCompare(right.moduleId);
    })
    .map((plan) => {
      const key = `${plan.layer}:${plan.archetype}:${plan.topic}`;
      const nextIndex = groupIndexByKey.get(key) ?? 0;
      groupIndexByKey.set(key, nextIndex + 1);
      return rebuildModulePlanIdentity(plan, nextIndex);
    });

  return finalized;
}

function buildGeneratedPackageJson(): string {
  const lines = [
    "{",
    '  "name": "generated-codex-project",',
    '  "private": true,',
    '  "type": "module",',
    '  "version": "0.0.1",',
    '  "scripts": {',
    '    "typecheck": "tsc --noEmit",',
    '    "build": "tsc -p tsconfig.json",',
    '    "lint": "eslint . --ext .ts --max-warnings=0",',
    '    "dev:smoke": "node ./runtime/smoke-runner.mjs"',
    "  },",
    '  "devDependencies": {',
    '    "typescript": "^5.9.3",',
    '    "eslint": "^9.39.1",',
    '    "@eslint/js": "^9.39.1",',
    '    "@typescript-eslint/parser": "^8.46.2",',
    '    "@typescript-eslint/eslint-plugin": "^8.46.2"',
    "  }",
    "}",
    "",
  ];
  return lines.join("\n");
}

function buildGeneratedTsConfig(): string {
  return [
    "{",
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "module": "ES2022",',
    '    "moduleResolution": "Bundler",',
    '    "rootDir": ".",',
    '    "outDir": "dist",',
    '    "strict": true,',
    '    "noImplicitAny": false,',
    '    "skipLibCheck": true',
  "  },",
    '  "include": ["src/**/*.ts", "src-tauri-adapter/**/*.ts", "runtime/**/*.ts"]',
    "}",
    "",
  ].join("\n");
}

function buildEslintConfig(): string {
  return [
    'import js from "@eslint/js";',
    'import tsParser from "@typescript-eslint/parser";',
    'import tsPlugin from "@typescript-eslint/eslint-plugin";',
    "",
    "export default [",
    "  js.configs.recommended,",
    "  {",
    '    files: ["runtime/**/*.mjs"],',
    "    languageOptions: {",
    "      globals: {",
    '        console: "readonly",',
    '        URL: "readonly",',
    "      },",
    "    },",
    "  },",
    "  {",
    '    files: ["src/chunks-ts/**/*.ts"],',
    "    linterOptions: {",
    '      reportUnusedDisableDirectives: "off",',
    "    },",
    "    languageOptions: {",
    "      parser: tsParser,",
    '      sourceType: "module",',
    '      ecmaVersion: "latest",',
    "    },",
    "    plugins: {",
    '      "@typescript-eslint": tsPlugin,',
    "    },",
    "    rules: {",
      '      "no-undef": "off",',
      '      "no-unused-vars": "off",',
      '      "no-fallthrough": "off",',
      '      "no-empty": "off",',
      '      "no-redeclare": "off",',
      '      "no-useless-escape": "off",',
      '      "no-case-declarations": "off",',
      '      "no-unreachable": "off",',
      '      "no-func-assign": "off",',
      '      "no-sparse-arrays": "off",',
      '      "no-irregular-whitespace": "off",',
      '      "no-unsafe-finally": "off",',
      '      "getter-return": "off",',
      '      "no-unused-private-class-members": "off",',
      '      "no-constant-condition": "off",',
      '      "no-prototype-builtins": "off",',
      '      "no-control-regex": "off",',
      '      "@typescript-eslint/no-unused-vars": "off"',
    "    },",
    "  },",
    "  {",
    '    files: ["**/*.ts"],',
    '    ignores: ["src/chunks-ts/**/*.ts"],',
    "    languageOptions: {",
      "      parser: tsParser,",
      '      sourceType: "module",',
      '      ecmaVersion: "latest",',
    "    },",
    "    plugins: {",
    '      "@typescript-eslint": tsPlugin,',
    "    },",
    "    rules: {",
    '      "no-undef": "off",',
      '      "no-unused-vars": "off",',
      '      "no-case-declarations": "off",',
      '      "no-unreachable": "off",',
      '      "no-useless-escape": "off",',
      '      "no-control-regex": "off",',
      '      "no-prototype-builtins": "off",',
      '      "no-cond-assign": "off",',
      '      "no-redeclare": "off",',
      '      "no-constant-condition": "off",',
      '      "no-unsafe-finally": "off",',
      '      "no-fallthrough": "off",',
      '      "@typescript-eslint/no-unused-vars": "off"',
    "    },",
    "  },",
    "];",
    "",
  ].join("\n");
}

function shortStableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function unwrapLiteralExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapLiteralExpression(expression.expression);
  }
  if (ts.isAsExpression(expression)) {
    return unwrapLiteralExpression(expression.expression);
  }
  if (ts.isTypeAssertionExpression(expression)) {
    return unwrapLiteralExpression(expression.expression);
  }
  if (ts.isSatisfiesExpression(expression)) {
    return unwrapLiteralExpression(expression.expression);
  }
  return expression;
}

function isStaticLiteralExpression(expression: ts.Expression): boolean {
  const normalized = unwrapLiteralExpression(expression);
  const isJsonParseCall = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const objectRef = node.expression.expression;
    const methodRef = node.expression.name;
    if (!ts.isIdentifier(objectRef) || objectRef.text !== "JSON" || methodRef.text !== "parse") {
      return false;
    }
    if (node.arguments.length !== 1) {
      return false;
    }
    const [payloadArg] = node.arguments;
    if (!payloadArg) {
      return false;
    }
    const payloadExpression = unwrapLiteralExpression(payloadArg);
    return ts.isStringLiteral(payloadExpression) || ts.isNoSubstitutionTemplateLiteral(payloadExpression);
  };
  const isObjectFreezeJsonParseCall = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    if (!ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }
    const objectRef = node.expression.expression;
    const methodRef = node.expression.name;
    if (!ts.isIdentifier(objectRef) || objectRef.text !== "Object" || methodRef.text !== "freeze") {
      return false;
    }
    if (node.arguments.length !== 1) {
      return false;
    }
    const [payloadArg] = node.arguments;
    if (!payloadArg) {
      return false;
    }
    return isJsonParseCall(unwrapLiteralExpression(payloadArg));
  };

  if (isObjectFreezeJsonParseCall(normalized) || isJsonParseCall(normalized)) {
    return true;
  }
  if (
    ts.isStringLiteral(normalized) ||
    ts.isNumericLiteral(normalized) ||
    ts.isBigIntLiteral(normalized) ||
    normalized.kind === ts.SyntaxKind.TrueKeyword ||
    normalized.kind === ts.SyntaxKind.FalseKeyword ||
    normalized.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNoSubstitutionTemplateLiteral(normalized)
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(normalized)) {
    const operand = unwrapLiteralExpression(normalized.operand);
    return ts.isNumericLiteral(operand) || ts.isBigIntLiteral(operand);
  }
  if (ts.isArrayLiteralExpression(normalized)) {
    for (const element of normalized.elements) {
      if (ts.isSpreadElement(element)) {
        return false;
      }
      if (!isStaticLiteralExpression(element)) {
        return false;
      }
    }
    return true;
  }
  if (ts.isObjectLiteralExpression(normalized)) {
    for (const property of normalized.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (!isStaticLiteralExpression(property.initializer)) {
          return false;
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return false;
      }
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        return false;
      }
      return false;
    }
    return true;
  }
  return false;
}

function isThemeOrGrammarIdentifier(identifier: string): boolean {
  const lower = identifier.toLowerCase();
  return lower.includes("theme") || lower.includes("grammar");
}

function buildQualityModuleContent(
  plan: ModulePlan,
  moduleAbsolutePath: string,
  outputProjectDirectory: string,
  symbols: OwnershipRecord[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
  liftedChunkById: ReadonlyMap<string, LiftedChunkArtifact>,
  chunkTopicTokensById: Map<string, string[]>,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): QualityModuleBuildResult {
  if (symbols.length === 0) {
    throw new Error(`buildQualityModuleContent: module ${plan.moduleId} has no symbols`);
  }

  const topic = topicSegmentFromFilePath(plan.filePath, plan.archetype);
  const usedExportNames = new Map<string, number>();
  const exportEntries: Array<{ exportName: string; chunkId: string; sourceIdentifier: string }> = [];
  const runtimeNamesByChunkId = new Map<string, string>();
  const dependencyImportsByPath = new Map<string, string>();
  const assetImportsByPath = new Map<string, string>();
  const assetFilesByPath = new Map<string, string>();
  const chunkRuntimes: string[] = [];

  type ChunkImportBindingKind = "named" | "default" | "namespace";
  interface ChunkImportBinding {
    localName: string;
    kind: ChunkImportBindingKind;
    moduleSpecifier: string;
    importedName: string;
  }

  interface ChunkImportNeed {
    modulePath: string;
    localName: string;
    kind: ChunkImportBindingKind;
    importedName: string;
  }

  const collectBindingNames = (name: ts.BindingName, sink: Set<string>): void => {
    if (ts.isIdentifier(name)) {
      sink.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      collectBindingNames(element.name, sink);
    }
  };

  const collectStatementDeclaredNames = (statement: ts.Statement): Set<string> => {
    const names = new Set<string>();
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
      return names;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      return names;
    }
    return names;
  };

  const collectStatementReferencedNames = (statement: ts.Statement): Set<string> => {
    const declared = new Set<string>();
    const collectDeclaredDeep = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        declared.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node)) {
        collectBindingNames(node.name, declared);
      }
      if (ts.isParameter(node)) {
        collectBindingNames(node.name, declared);
      }
      if (ts.isBindingElement(node)) {
        collectBindingNames(node.name, declared);
      }
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        collectBindingNames(node.variableDeclaration.name, declared);
      }
      ts.forEachChild(node, collectDeclaredDeep);
    };
    collectDeclaredDeep(statement);

    const refs = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isIdentifierReference(node) && !declared.has(node.text)) {
        refs.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
    return refs;
  };

  const stripExportModifiers = (statement: ts.Statement): ts.Statement | undefined => {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      return undefined;
    }
    const removeExport = (node: ts.Node): ts.Modifier[] | undefined => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      if (!modifiers || modifiers.length < 1) {
        return undefined;
      }
      const next = modifiers.filter((modifier) => {
        if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
          return false;
        }
        if (modifier.kind === ts.SyntaxKind.DefaultKeyword) {
          return false;
        }
        return true;
      });
      return next.length > 0 ? [...next] : undefined;
    };

    if (ts.isFunctionDeclaration(statement)) {
      return ts.factory.updateFunctionDeclaration(
        statement,
        removeExport(statement),
        statement.asteriskToken,
        statement.name,
        statement.typeParameters,
        statement.parameters,
        statement.type,
        statement.body,
      );
    }
    if (ts.isClassDeclaration(statement)) {
      return ts.factory.updateClassDeclaration(
        statement,
        removeExport(statement),
        statement.name,
        statement.typeParameters,
        statement.heritageClauses,
        statement.members,
      );
    }
    if (ts.isVariableStatement(statement)) {
      return ts.factory.updateVariableStatement(statement, removeExport(statement), statement.declarationList);
    }
    return statement;
  };

  const normalizeChunkImportPath = (chunkId: string, moduleSpecifier: string): string => {
    if (!moduleSpecifier.startsWith(".")) {
      return moduleSpecifier;
    }
    const chunkModulePath = path.join(outputProjectDirectory, "src", "chunks-ts", `${chunkId}.ts`);
    const normalizedSpecifier = /\.[cm]?[jt]sx?$/i.test(moduleSpecifier)
      ? moduleSpecifier.replace(/\.[cm]?[jt]sx?$/i, ".ts")
      : `${moduleSpecifier}.ts`;
    const targetPath = path.resolve(path.dirname(chunkModulePath), normalizedSpecifier);
    return toJsImportPath(moduleAbsolutePath, targetPath);
  };

  const buildChunkImportBindings = (sourceFile: ts.SourceFile): Map<string, ChunkImportBinding> => {
    const bindings = new Map<string, ChunkImportBinding>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const clause = statement.importClause;
      const moduleSpecifier = statement.moduleSpecifier.text;
      if (clause.name) {
        bindings.set(clause.name.text, {
          localName: clause.name.text,
          kind: "default",
          moduleSpecifier,
          importedName: "default",
        });
      }
      const namedBindings = clause.namedBindings;
      if (!namedBindings) {
        continue;
      }
      if (ts.isNamespaceImport(namedBindings)) {
        bindings.set(namedBindings.name.text, {
          localName: namedBindings.name.text,
          kind: "namespace",
          moduleSpecifier,
          importedName: "*",
        });
        continue;
      }
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName ? element.propertyName.text : element.name.text;
        bindings.set(element.name.text, {
          localName: element.name.text,
          kind: "named",
          moduleSpecifier,
          importedName,
        });
      }
    }
    return bindings;
  };

  const resolveAssetImportAlias = (modulePath: string): string => {
    const existingAlias = assetImportsByPath.get(modulePath);
    if (existingAlias) {
      return existingAlias;
    }
    const usedAliases = new Set<string>([...dependencyImportsByPath.values(), ...assetImportsByPath.values()]);
    const nextAlias = nextUniqueIdentifier("payloadAsset", usedAliases);
    assetImportsByPath.set(modulePath, nextAlias);
    return nextAlias;
  };

  const buildAssetModulePath = (chunkId: string, identifier: string, initializerText: string): string => {
    const hash = shortStableHash(`${chunkId}:${identifier}:${initializerText}`);
    const stem = sanitizeSegment(`${chunkId}-${identifier}-${hash}`, `payload-${hash}`);
    return path.join(outputProjectDirectory, "assets", "payloads", `${stem}.ts`);
  };

  const extractStaticPayloadFromStatement = (
    statement: ts.Statement,
    chunkId: string,
    sourceFile: ts.SourceFile,
    printer: ts.Printer,
  ): ts.Statement => {
    if (!ts.isVariableStatement(statement)) {
      return statement;
    }

    let changed = false;
    const nextDeclarations: ts.VariableDeclaration[] = [];
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        nextDeclarations.push(declaration);
        continue;
      }
      const initializer = unwrapLiteralExpression(declaration.initializer);
      if (!isStaticLiteralExpression(initializer)) {
        nextDeclarations.push(declaration);
        continue;
      }
      const initializerText = printer.printNode(ts.EmitHint.Unspecified, initializer, sourceFile).trim();
      const minLength = isThemeOrGrammarIdentifier(declaration.name.text)
        ? STATIC_PAYLOAD_THEME_GRAMMAR_MIN_LENGTH
        : STATIC_PAYLOAD_LITERAL_MIN_LENGTH;
      if (initializerText.length < minLength) {
        nextDeclarations.push(declaration);
        continue;
      }

      const assetAbsolutePath = buildAssetModulePath(chunkId, declaration.name.text, initializerText);
      const assetModulePath = toJsImportPath(moduleAbsolutePath, assetAbsolutePath);
      const importAlias = resolveAssetImportAlias(assetModulePath);
      const assetContent = `const payload = ${initializerText};\n\nexport default payload;\n`;
      const existingAssetContent = assetFilesByPath.get(assetAbsolutePath);
      if (existingAssetContent) {
        if (existingAssetContent !== assetContent) {
          throw new Error(`buildQualityModuleContent: static payload collision at ${assetAbsolutePath}`);
        }
      } else {
        assetFilesByPath.set(assetAbsolutePath, assetContent);
      }

      const nextDeclaration = ts.factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        ts.factory.createIdentifier(importAlias),
      );
      nextDeclarations.push(nextDeclaration);
      changed = true;
    }

    if (!changed) {
      return statement;
    }

    const nextDeclarationList = ts.factory.updateVariableDeclarationList(statement.declarationList, nextDeclarations);
    return ts.factory.updateVariableStatement(statement, statement.modifiers, nextDeclarationList);
  };

  const createChunkRuntime = (
    chunkId: string,
    requiredSourceIdentifiers: string[],
    runtimeVarName: string,
  ): string => {
    const liftedChunk = liftedChunkById.get(chunkId);
    if (!liftedChunk) {
      throw new Error(`buildQualityModuleContent: missing lifted chunk ${chunkId}`);
    }

    const sourceFile = ts.createSourceFile(
      `${chunkId}.ts`,
      liftedChunk.content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const importBindings = buildChunkImportBindings(sourceFile);
    const statementByDeclaredName = new Map<string, ts.Statement>();
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
        continue;
      }
      const names = collectStatementDeclaredNames(statement);
      for (const name of names) {
        if (!statementByDeclaredName.has(name)) {
          statementByDeclaredName.set(name, statement);
        }
      }
    }

    const selectedStatements = new Set<ts.Statement>();
    const requiredImportLocals = new Set<string>();
    const pending = [...new Set(requiredSourceIdentifiers)].sort((left, right) => left.localeCompare(right));
    while (pending.length > 0) {
      const identifier = pending.shift();
      if (!identifier) {
        continue;
      }
      const declarationStatement = statementByDeclaredName.get(identifier);
      if (!declarationStatement) {
        if (importBindings.has(identifier)) {
          requiredImportLocals.add(identifier);
          continue;
        }
        throw new Error(`buildQualityModuleContent: unresolved identifier "${identifier}" in chunk ${chunkId}`);
      }
      if (selectedStatements.has(declarationStatement)) {
        continue;
      }
      selectedStatements.add(declarationStatement);
      const refs = collectStatementReferencedNames(declarationStatement);
      for (const ref of refs) {
        if (statementByDeclaredName.has(ref) || importBindings.has(ref)) {
          pending.push(ref);
        }
      }
    }

    const importNeeds: ChunkImportNeed[] = [...requiredImportLocals]
      .sort((left, right) => left.localeCompare(right))
      .map((localName) => {
        const binding = importBindings.get(localName);
        if (!binding) {
          throw new Error(`buildQualityModuleContent: missing import binding "${localName}" in chunk ${chunkId}`);
        }
        return {
          modulePath: normalizeChunkImportPath(chunkId, binding.moduleSpecifier),
          localName,
          kind: binding.kind,
          importedName: binding.importedName,
        };
      });

    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const bodyStatements: string[] = [];
    for (const statement of sourceFile.statements) {
      if (!selectedStatements.has(statement)) {
        continue;
      }
      const withExtractedPayload = extractStaticPayloadFromStatement(statement, chunkId, sourceFile, printer);
      const stripped = stripExportModifiers(withExtractedPayload);
      if (!stripped) {
        continue;
      }
      const rendered = printer.printNode(ts.EmitHint.Unspecified, stripped, sourceFile).trim();
      if (rendered.length > 0) {
        bodyStatements.push(rendered);
      }
    }

    const accessExpr = (dependencyAlias: string, need: ChunkImportNeed): string => {
      if (need.kind === "namespace") {
        return dependencyAlias;
      }
      if (need.kind === "default") {
        return `${dependencyAlias}.default`;
      }
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(need.importedName)) {
        return `${dependencyAlias}.${need.importedName}`;
      }
      return `${dependencyAlias}[${quote(need.importedName)}]`;
    };

    const lines: string[] = [`const ${runtimeVarName} = (() => {`];
    for (const need of importNeeds) {
      const existingAlias = dependencyImportsByPath.get(need.modulePath);
      if (existingAlias) {
        lines.push(`  const ${need.localName} = ${accessExpr(existingAlias, need)};`);
        continue;
      }
      const nextAlias = nextUniqueIdentifier("chunkDependency", new Set(dependencyImportsByPath.values()));
      dependencyImportsByPath.set(need.modulePath, nextAlias);
      lines.push(`  const ${need.localName} = ${accessExpr(nextAlias, need)};`);
    }
    if (importNeeds.length > 0 && bodyStatements.length > 0) {
      lines.push("");
    }
    for (const statementText of bodyStatements) {
      const statementLines = statementText.split("\n");
      for (const statementLine of statementLines) {
        lines.push(`  ${statementLine}`);
      }
      lines.push("");
    }
    lines.push("  return {");
    for (const identifier of [...new Set(requiredSourceIdentifiers)].sort((left, right) => left.localeCompare(right))) {
      lines.push(`    ${identifier},`);
    }
    lines.push("  };");
    lines.push("})();");
    return lines.join("\n");
  };

  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const symbol = symbols[symbolIndex];
    if (!symbol) {
      continue;
    }
    const liftBinding = bindingByKey.get(symbol.symbolKey);
    if (!liftBinding) {
      throw new Error(`buildQualityModuleContent: missing AST-lift binding for ${symbol.symbolKey}`);
    }
    const renameHint = renameHintsBySymbolKey.get(symbol.symbolKey);

    const exportName = buildDomainExportName(
      symbol,
      plan,
      topic,
      symbolIndex + 1,
      usedExportNames,
      renameHint,
      signalContext,
      liftBinding,
      chunkTopicTokensById,
    );
    exportEntries.push({
      exportName,
      chunkId: liftBinding.chunkId,
      sourceIdentifier: liftBinding.sourceIdentifier,
    });
  }

  const sourceIdsByChunk = new Map<string, Set<string>>();
  for (const entry of exportEntries) {
    const existing = sourceIdsByChunk.get(entry.chunkId) ?? new Set<string>();
    existing.add(entry.sourceIdentifier);
    sourceIdsByChunk.set(entry.chunkId, existing);
  }

  const sortedChunkIds = [...sourceIdsByChunk.keys()].sort((left, right) => left.localeCompare(right));
  for (let chunkIndex = 0; chunkIndex < sortedChunkIds.length; chunkIndex += 1) {
    const chunkId = sortedChunkIds[chunkIndex];
    if (!chunkId) {
      continue;
    }
    const runtimeVarName = `chunkRuntime${String(chunkIndex + 1).padStart(2, "0")}`;
    runtimeNamesByChunkId.set(chunkId, runtimeVarName);
    const identifiers = [...(sourceIdsByChunk.get(chunkId) ?? new Set<string>())].sort((left, right) =>
      left.localeCompare(right),
    );
    const runtimeBlock = createChunkRuntime(chunkId, identifiers, runtimeVarName);
    chunkRuntimes.push(runtimeBlock);
  }

  const lines: string[] = [
    "// @ts-nocheck",
    "// Quality contour module: AST-lift declarations only.",
  ];
  const sortedDependencies = [...dependencyImportsByPath.entries()].sort(([left], [right]) => left.localeCompare(right));
  const sortedAssetImports = [...assetImportsByPath.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (sortedDependencies.length > 0 || sortedAssetImports.length > 0) {
    lines.push("");
    lines.push("// imports");
    for (const [importPath, alias] of sortedDependencies) {
      lines.push(`import * as ${alias} from ${quote(importPath)};`);
    }
    for (const [importPath, alias] of sortedAssetImports) {
      lines.push(`import ${alias} from ${quote(importPath)};`);
    }
  }

  lines.push("");
  lines.push("// lifted logic");
  for (const runtime of chunkRuntimes) {
    lines.push(runtime);
    lines.push("");
  }

  lines.push("// exports");
  for (const entry of exportEntries) {
    const runtimeVarName = runtimeNamesByChunkId.get(entry.chunkId);
    if (!runtimeVarName) {
      throw new Error(`buildQualityModuleContent: missing runtime var for chunk ${entry.chunkId}`);
    }
    lines.push(`export const ${entry.exportName} = ${runtimeVarName}.${entry.sourceIdentifier};`);
  }
  lines.push("");
  lines.push("const api = {");
  for (const entry of exportEntries) {
    lines.push(`  ${entry.exportName},`);
  }
  lines.push("} as const;");

  lines.push("");
  lines.push("export default api;");
  lines.push("");
  const assetFiles = [...assetFilesByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([absolutePath, content]) => ({
      absolutePath,
      content,
    }));
  return {
    content: lines.join("\n"),
    assetFiles,
  };
}

function buildSmokeRunner(modulePaths: string[]): string {
  const imports = modulePaths.map((modulePath) => `  ${quote(modulePath)},`);
  return [
    'import * as fs from "node:fs/promises";',
    "",
    "const modules = [",
    ...imports,
    "];",
    "",
    "let imported = 0;",
    "let skipped = 0;",
    "const skippedModules = [];",
    "for (const modulePath of modules) {",
    "  try {",
    "    await import(new URL(modulePath, import.meta.url));",
    "    imported += 1;",
    "  } catch {",
    "    skipped += 1;",
    "    skippedModules.push(modulePath);",
    "  }",
    "}",
    'console.log(`[dev-smoke] imported ${imported} modules`);',
    'console.log(`[dev-smoke] skipped ${skipped} modules`);',
    "if (skippedModules.length > 0) {",
    "  const payload = { generatedAtIso: new Date().toISOString(), skippedModules };",
    '  await fs.writeFile(new URL("./smoke-skipped.json", import.meta.url), `${JSON.stringify(payload, null, 2)}\\n`, "utf8");',
    "}",
    "",
  ].join("\n");
}

function buildFileQualityReport(qualityEntries: ModuleQualityEntry[], rerenderedModuleCount: number): string {
  const payload = {
    generatedAtIso: new Date().toISOString(),
    rerenderedModuleCount,
    worstPercent: FILE_QUALITY_WORST_PERCENT,
    files: [...qualityEntries].sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.filePath.localeCompare(right.filePath);
    }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) {
    return false;
  }
  for (const modifier of modifiers) {
    if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      return true;
    }
  }
  return false;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }

  if (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isMethodDeclaration(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyDeclaration(parent) && parent.name === node) {
    return false;
  }
  return true;
}

function collectTopLevelExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const exported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        exported.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exported.add(declaration.name.text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exported.add(element.name.text);
      }
    }
  }
  return exported;
}

function collectDeclaredNamesInFunction(functionNode: ts.FunctionDeclaration): Set<string> {
  const declared = new Set<string>();
  if (functionNode.name) {
    declared.add(functionNode.name.text);
  }
  for (const parameter of functionNode.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      declared.add(parameter.name.text);
    }
  }
  if (!functionNode.body) {
    return declared;
  }
  const visitDeclaration = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node !== functionNode &&
      node.name
    ) {
      declared.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      declared.add(node.variableDeclaration.name.text);
    }
    ts.forEachChild(node, visitDeclaration);
  };
  ts.forEachChild(functionNode.body, visitDeclaration);
  return declared;
}

function isSelfContainedHelperFunction(functionNode: ts.FunctionDeclaration): boolean {
  if (!functionNode.body) {
    return false;
  }
  const declaredNames = collectDeclaredNamesInFunction(functionNode);
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) {
      return;
    }
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      if (declaredNames.has(node.text) || SHARED_HELPER_ALLOWED_GLOBALS.has(node.text)) {
        ts.forEachChild(node, visit);
        return;
      }
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode.body, visit);
  return valid;
}

function helperOccurrenceKey(helperName: string, helperText: string): string {
  return `${helperName}::${helperText}`;
}

function collectHelperOccurrences(liftedChunks: LiftedChunkArtifact[]): HelperOccurrence[] {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const occurrences: HelperOccurrence[] = [];
  for (const liftedChunk of liftedChunks) {
    const sourceFile = ts.createSourceFile(
      `${liftedChunk.chunkId}.ts`,
      liftedChunk.content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const exportedNames = collectTopLevelExportedNames(sourceFile);
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) {
        continue;
      }
      const helperName = statement.name.text;
      if (helperName.length < 3 || helperName.length > 64) {
        continue;
      }
      if (SHARED_HELPER_NAME_DENYLIST.has(helperName) || RESERVED_IDENTIFIERS.has(helperName)) {
        continue;
      }
      if (exportedNames.has(helperName)) {
        continue;
      }
      if (!isSelfContainedHelperFunction(statement)) {
        continue;
      }
      const helperText = printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim();
      if (helperText.length === 0) {
        continue;
      }
      occurrences.push({
        chunkId: liftedChunk.chunkId,
        helperName,
        helperText,
      });
    }
  }
  return occurrences;
}

function selectSharedHelperCandidates(occurrences: HelperOccurrence[]): SharedHelperSelection[] {
  const candidatesByKey = new Map<string, SharedHelperCandidate>();
  for (const occurrence of occurrences) {
    const key = helperOccurrenceKey(occurrence.helperName, occurrence.helperText);
    const existing = candidatesByKey.get(key);
    if (existing) {
      existing.chunkIds.add(occurrence.chunkId);
      continue;
    }
    candidatesByKey.set(key, {
      helperName: occurrence.helperName,
      helperText: occurrence.helperText,
      chunkIds: new Set<string>([occurrence.chunkId]),
    });
  }

  const selected = [...candidatesByKey.values()]
    .filter((candidate) => candidate.chunkIds.size >= SHARED_HELPER_MIN_OCCURRENCES)
    .sort((left, right) => {
      if (left.chunkIds.size !== right.chunkIds.size) {
        return right.chunkIds.size - left.chunkIds.size;
      }
      return left.helperName.localeCompare(right.helperName);
    });

  const helperNameCounts = new Map<string, number>();
  for (const candidate of selected) {
    const current = helperNameCounts.get(candidate.helperName) ?? 0;
    helperNameCounts.set(candidate.helperName, current + 1);
  }

  const deduped = selected
    .filter((candidate) => (helperNameCounts.get(candidate.helperName) ?? 0) === 1)
    .slice(0, SHARED_HELPER_MAX_COUNT)
    .map((candidate) => ({
      helperName: candidate.helperName,
      helperText: candidate.helperText,
      chunkIds: [...candidate.chunkIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.helperName.localeCompare(right.helperName));

  return deduped;
}

function buildSharedHelperModuleContent(helpers: SharedHelperSelection[]): string {
  const lines: string[] = ["// Shared helper pool extracted from lifted chunks.", ""];
  for (const helper of helpers) {
    lines.push(helper.helperText);
    lines.push("");
  }
  const exportNames = helpers.map((helper) => helper.helperName).sort((left, right) => left.localeCompare(right));
  lines.push(`export { ${exportNames.join(", ")} };`);
  lines.push("");
  return lines.join("\n");
}

function rewriteLiftedChunkWithSharedHelpers(
  chunk: LiftedChunkArtifact,
  selectedHelpersByKey: ReadonlyMap<string, SharedHelperSelection>,
): LiftedChunkArtifact {
  const sourceFile = ts.createSourceFile(`${chunk.chunkId}.ts`, chunk.content, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const exportedNames = collectTopLevelExportedNames(sourceFile);

  const helperNamesToImport = new Set<string>();
  const keptStatements: ts.Statement[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === SHARED_HELPER_MODULE_RELATIVE_PATH) {
      const clause = statement.importClause;
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          helperNamesToImport.add(element.name.text);
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && !exportedNames.has(statement.name.text)) {
      const helperText = printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim();
      const candidateKey = helperOccurrenceKey(statement.name.text, helperText);
      const selectedHelper = selectedHelpersByKey.get(candidateKey);
      if (selectedHelper) {
        helperNamesToImport.add(selectedHelper.helperName);
        continue;
      }
    }
    keptStatements.push(statement);
  }

  if (helperNamesToImport.size === 0) {
    return chunk;
  }

  const helperImportElements = [...helperNamesToImport]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name)));
  const helperImportDeclaration = ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports(helperImportElements)),
    ts.factory.createStringLiteral(SHARED_HELPER_MODULE_RELATIVE_PATH),
    undefined,
  );

  const firstNonImportIndex = keptStatements.findIndex((statement) => !ts.isImportDeclaration(statement));
  const insertAt = firstNonImportIndex < 0 ? keptStatements.length : firstNonImportIndex;
  const nextStatements = [...keptStatements];
  nextStatements.splice(insertAt, 0, helperImportDeclaration);

  const rewrittenSourceFile = ts.factory.updateSourceFile(sourceFile, nextStatements);
  let rewrittenContent = printer.printFile(rewrittenSourceFile).trimEnd();
  if (!rewrittenContent.startsWith("// @ts-nocheck")) {
    rewrittenContent = `// @ts-nocheck\n${rewrittenContent}`;
  }
  rewrittenContent = `${rewrittenContent}\n`;

  const rewrittenAst = ts.createSourceFile(`${chunk.chunkId}.ts`, rewrittenContent, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const nonImportDeclarationCount = rewrittenAst.statements.reduce(
    (count, statement) => count + (ts.isImportDeclaration(statement) ? 0 : 1),
    0,
  );

  return {
    ...chunk,
    content: rewrittenContent,
    liftedDeclarationCount: nonImportDeclarationCount,
  };
}

function extractSharedHelperPool(liftedChunks: LiftedChunkArtifact[]): SharedHelperPoolResult {
  const occurrences = collectHelperOccurrences(liftedChunks);
  const selectedHelpers = selectSharedHelperCandidates(occurrences);
  if (selectedHelpers.length === 0) {
    return {
      liftedChunks,
      helperModuleContent: "",
      helperCount: 0,
    };
  }

  const selectedHelpersByKey = new Map<string, SharedHelperSelection>();
  for (const helper of selectedHelpers) {
    selectedHelpersByKey.set(helperOccurrenceKey(helper.helperName, helper.helperText), helper);
  }

  const rewrittenChunks = liftedChunks.map((chunk) => rewriteLiftedChunkWithSharedHelpers(chunk, selectedHelpersByKey));
  return {
    liftedChunks: rewrittenChunks,
    helperModuleContent: buildSharedHelperModuleContent(selectedHelpers),
    helperCount: selectedHelpers.length,
  };
}

async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, "utf8");
}

function toProjectRelative(projectDirectory: string, absolutePath: string): string {
  return path.relative(projectDirectory, absolutePath).split(path.sep).join("/");
}

function toJsImportPath(fromFile: string, targetFile: string): string {
  const relative = path.relative(path.dirname(fromFile), targetFile).replace(/\\/g, "/").replace(/\.ts$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function chunkIdFromRelativeImport(moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith(".")) {
    return undefined;
  }
  const normalized = moduleSpecifier.replace(/\\/g, "/");
  if (normalized.includes("/_shared/")) {
    return undefined;
  }
  const baseName = path.basename(normalized).replace(/\.[cm]?[jt]sx?$/i, "");
  if (baseName.length === 0) {
    return undefined;
  }
  return baseName;
}

function collectChunkStubDependencies(
  liftedChunks: Awaited<ReturnType<typeof buildAstLiftResult>>["liftedChunks"],
  emittedChunkIds: Set<string>,
): Set<string> {
  const dependencies = new Set<string>();

  for (const liftedChunk of liftedChunks) {
    const sourceFile = ts.createSourceFile(
      `${liftedChunk.chunkId}.ts`,
      liftedChunk.content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      if (!ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const importedChunkId = chunkIdFromRelativeImport(statement.moduleSpecifier.text);
      if (!importedChunkId || emittedChunkIds.has(importedChunkId)) {
        continue;
      }
      dependencies.add(importedChunkId);
    }
  }

  return dependencies;
}

export async function emitTemplateProject(
  ownershipModel: OwnershipModel,
  chunkArtifacts: ChunkArtifactModel,
  semanticIr: SemanticIrModel,
  monolithLayoutHints: MonolithLayoutHintsModel,
  outputProjectDirectory: string,
  statementBudget: number,
): Promise<TemplateEmitResult> {
  await ensureCleanDirectory(outputProjectDirectory);
  const emittedFiles: string[] = [];

  const packageJsonPath = path.join(outputProjectDirectory, "package.json");
  await writeTextFile(packageJsonPath, buildGeneratedPackageJson());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, packageJsonPath));

  const eslintConfigPath = path.join(outputProjectDirectory, "eslint.config.mjs");
  await writeTextFile(eslintConfigPath, buildEslintConfig());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, eslintConfigPath));

  const tsconfigPath = path.join(outputProjectDirectory, "tsconfig.json");
  await writeTextFile(tsconfigPath, buildGeneratedTsConfig());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, tsconfigPath));

  const sortedChunks = [...chunkArtifacts.chunks].sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const chunkArtifactManifestPath = path.join(outputProjectDirectory, "artifacts", "chunk-artifacts.json");
  await writeTextFile(
    chunkArtifactManifestPath,
    `${JSON.stringify({ generatedAtIso: new Date().toISOString(), chunks: sortedChunks }, null, 2)}\n`,
  );
  emittedFiles.push(toProjectRelative(outputProjectDirectory, chunkArtifactManifestPath));

  const astLift = await buildAstLiftResult(chunkArtifacts, ownershipModel, {
    hotChunkMax: 28,
    targetCoverage: 0.95,
    minHotChunkCount: 20,
    preferredArchetypes: ["ui", "service", "hook", "transport"],
    minimumChunkScore: 0,
    closureChunkLimit: 256,
  });
  const sharedHelperPool = extractSharedHelperPool(astLift.liftedChunks);
  const liftedChunkById = new Map<string, LiftedChunkArtifact>(
    sharedHelperPool.liftedChunks.map((liftedChunk) => [liftedChunk.chunkId, liftedChunk]),
  );

  const liftedChunkIds = new Set<string>();
  for (const liftedChunk of sharedHelperPool.liftedChunks) {
    liftedChunkIds.add(liftedChunk.chunkId);
    const liftedPath = path.join(outputProjectDirectory, "src", "chunks-ts", `${liftedChunk.chunkId}.ts`);
    await writeTextFile(liftedPath, liftedChunk.content);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, liftedPath));
  }
  if (sharedHelperPool.helperCount > 0) {
    const helperModulePath = path.join(outputProjectDirectory, "src", "chunks-ts", "_shared", SHARED_HELPER_MODULE_FILENAME);
    await writeTextFile(helperModulePath, sharedHelperPool.helperModuleContent);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, helperModulePath));
  }

  const missingChunkDependencies = collectChunkStubDependencies(sharedHelperPool.liftedChunks, liftedChunkIds);
  if (missingChunkDependencies.size > 0) {
    const unresolvedChunkIds = [...missingChunkDependencies].sort((left, right) => left.localeCompare(right));
    const preview = unresolvedChunkIds.slice(0, 16).join(", ");
    throw new Error(
      `quality-emitter requires AST-lift declarations for all chunk dependencies; unresolved chunk(s): ${preview}`,
    );
  }

  const chunkTopicTokensById = buildChunkTopicTokensById(sortedChunks);
  const signalContext = buildEmitterSignalContext(semanticIr);
  const domainRenameHints = buildDomainRenameHints(ownershipModel, signalContext);
  const monolithTopicHints = buildMonolithTopicHints(monolithLayoutHints);
  const qualitySymbols = ownershipModel.symbols.filter((symbol) => astLift.symbolBindingByKey.has(symbol.symbolKey));
  const unresolvedSymbols = ownershipModel.symbols
    .filter((symbol) => !astLift.symbolBindingByKey.has(symbol.symbolKey))
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))
    .map((symbol) => ({
      symbolKey: symbol.symbolKey,
      symbolName: symbol.symbolName,
      layer: symbol.layer,
      archetype: symbol.archetype,
      confidence: symbol.confidence,
    }));

  const qualityOwnership = buildOwnershipSubset(ownershipModel, qualitySymbols);
  const qualityRawPlans = buildModulePlans(
    qualityOwnership,
    Math.max(statementBudget * QUALITY_PLAN_BUDGET_MULTIPLIER, QUALITY_PLAN_BUDGET_MIN),
    domainRenameHints,
    monolithTopicHints,
  );
  const qualityCohesionPlans = applyCohesionMergeSplit(
    qualityRawPlans,
    statementBudget,
    domainRenameHints,
    signalContext,
  );
  const qualityPass = applyFileQualityRerender(qualityCohesionPlans, astLift.symbolBindingByKey, statementBudget);
  const qualityModulePlans = qualityPass.modulePlans;
  const emittedAssetContentByPath = new Map<string, string>();

  for (const plan of qualityModulePlans) {
    const absoluteFilePath = path.join(outputProjectDirectory, plan.filePath);
    const moduleBuildResult = buildQualityModuleContent(
      plan,
      absoluteFilePath,
      outputProjectDirectory,
      plan.symbols,
      astLift.symbolBindingByKey,
      liftedChunkById,
      chunkTopicTokensById,
      domainRenameHints,
      signalContext,
    );
    await writeTextFile(absoluteFilePath, moduleBuildResult.content);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, absoluteFilePath));
    for (const assetFile of moduleBuildResult.assetFiles) {
      const existing = emittedAssetContentByPath.get(assetFile.absolutePath);
      if (existing) {
        if (existing !== assetFile.content) {
          throw new Error(`emitTemplateProject: payload asset collision at ${assetFile.absolutePath}`);
        }
        continue;
      }
      emittedAssetContentByPath.set(assetFile.absolutePath, assetFile.content);
    }
  }

  const sortedAssetFiles = [...emittedAssetContentByPath.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [absolutePath, content] of sortedAssetFiles) {
    await writeTextFile(absolutePath, content);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, absolutePath));
  }

  const pendingLiftPath = path.join(outputProjectDirectory, "artifacts", "pending-lift-symbols.json");
  await writeTextFile(
    pendingLiftPath,
    `${JSON.stringify({ generatedAtIso: new Date().toISOString(), symbols: unresolvedSymbols }, null, 2)}\n`,
  );
  emittedFiles.push(toProjectRelative(outputProjectDirectory, pendingLiftPath));

  const smokeModuleTargets = emittedFiles
    .filter((relativePath) => relativePath.endsWith(".ts"))
    .filter((relativePath) => relativePath.startsWith("src/") || relativePath.startsWith("src-tauri-adapter/") || relativePath.startsWith("runtime/"))
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => `../dist/${relativePath.replace(/\.ts$/, ".js")}`);

  const smokeRunnerPath = path.join(outputProjectDirectory, "runtime", "smoke-runner.mjs");
  await writeTextFile(smokeRunnerPath, buildSmokeRunner(smokeModuleTargets));
  emittedFiles.push(toProjectRelative(outputProjectDirectory, smokeRunnerPath));

  const fileQualityReportPath = path.join(outputProjectDirectory, "runtime", "file-quality.json");
  await writeTextFile(
    fileQualityReportPath,
    buildFileQualityReport(qualityPass.qualityEntries, qualityPass.rerenderedModuleCount),
  );
  emittedFiles.push(toProjectRelative(outputProjectDirectory, fileQualityReportPath));

  const sortedFiles = [...emittedFiles].sort((left, right) => left.localeCompare(right));
  return {
    emittedFiles: sortedFiles,
    emittedModuleCount: qualityModulePlans.length,
    emittedSymbolCount: qualitySymbols.length,
    fileQualityReportPath,
    rerenderedModuleCount: qualityPass.rerenderedModuleCount,
    hotChunkCount: astLift.hotChunkIds.length,
  };
}
