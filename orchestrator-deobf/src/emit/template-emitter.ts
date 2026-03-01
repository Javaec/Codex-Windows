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
import { ensureCleanDirectory, ensureDirectory, readJsonFile } from "../utils/fs-json";

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
  hotPriority: boolean;
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
  symbolKeys: string[];
  averageConfidence: number;
  averageNameQuality: number;
  liftedCoverage: number;
  rerendered: boolean;
  hotFocus: boolean;
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

interface ManualRefactorCandidate {
  filePath: string;
  averageScore: number;
}

interface ManualRefactorCandidatesModel {
  candidates: ManualRefactorCandidate[];
}

interface ManualHotTargets {
  hotSeedFamilies: Set<string>;
  criticalHotFilePaths: Set<string>;
}

const GENERIC_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);
const LAYER_ORDER: LayerId[] = ["main", "renderer", "services", "tauri"];
const ARCHETYPE_ORDER: ArchetypeId[] = ["hook", "service", "ui", "transport", "store"];
const MAX_PARTS_PER_TOPIC = 2;
const MAX_PARTS_PER_HEAVY_DOMAIN_TOPIC = 3;
const HARD_SYMBOL_LIMIT_PER_MODULE = 560;
const FILE_QUALITY_WORST_PERCENT = 0.1;
const HOT_FIRST_REGENERATION_ENABLED = true;
const HOT_FIRST_MIN_TARGET_FILES = 5;
const HOT_FIRST_MAX_TARGET_FILES = 10;
const HOT_FIRST_MIN_SYMBOL_COUNT = 8;
const HOT_FIRST_CRITICAL_TOP_WORST_COUNT = 5;
const HOT_INLINE_WRAPPER_MAX_PER_MODULE = 24;
const HOT_BEHAVIOR_CLUSTER_MAX_EXTRACTED = 36;
const HOT_FUNCTION_BODY_NAME_QUALITY_THRESHOLD = 0.78;
const HOT_STORE_SHARD_LONG_FUNCTION_LINES = 120;
const HOT_STORE_SHARD_FUNCTION_MAX_LINES = 1300;
const HOT_STORE_SHARD_MAX_CLUSTER_MODULES = 6;
const HOT_STORE_SHARD_MAX_MOVED_LONG_FUNCTIONS = 28;
const HOT_STORE_SHARD_MAX_DOMAIN_HELPERS = 16;
const HOT_STORE_SHARD_DEPENDENCY_CLUSTER_MAX_MODULES = 3;
const HOT_STORE_SHARD_DEPENDENCY_CLOSURE_MAX_STATEMENTS = 84;
const HOT_STORE_SHARD_RUNTIME_CLUSTER_MAX_MODULES = 3;
const HOT_STORE_SHARD_RUNTIME_CLUSTER_MIN_LINES = 48;
const HOT_STORE_SHARD_RUNTIME_CLUSTER_MAX_STATEMENTS = 96;
const HOT_STORE_SHARD_DEPENDENCY_STRICT_MIN_LINES = 72;
const HOT_STORE_SHARD_DEPENDENCY_STRICT_MAX_MODULES = 5;
const HOT_STORE_SHARD_DEPENDENCY_STRICT_MAX_STATEMENTS = 168;
const HOT_STORE_SHARD_RUNTIME_STRICT_MIN_LINES = 24;
const HOT_STORE_SHARD_RUNTIME_STRICT_MAX_MODULES = 6;
const HOT_STORE_SHARD_RUNTIME_STRICT_MAX_STATEMENTS = 168;
const HOT_STORE_SHARD_CLUSTER_EXTRACTION_PASSES = 2;
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
  "channel",
  "dispatch",
  "component",
  "bridge",
  "extends",
  "inline",
  "impl",
]);
const DOMAIN_ALIAS_WEAK_TOKENS = new Set<string>([
  "run",
  "impl",
  "entry",
  "default",
  "value",
  "member",
  "node",
  "domain",
  "service",
  "store",
  "hook",
  "transport",
  "ui",
]);
const TEMPLATE_FALLBACK_NAME_PATTERNS: RegExp[] = [
  /^stateStore(?:[A-Za-z]+)?\d*$/i,
  /^domainService\d*$/i,
  /^uiComponents?\d*$/i,
  /^transportBridge(?:[A-Za-z]+)?\d*$/i,
  /^storeState(?:Store)?\d*$/i,
  /^serviceDomain(?:Service)?\d*$/i,
  /^(?:store|service|ui|transport|hook)?ChannelDispatch(?:[A-Za-z]+)?\d*$/i,
  /^renderAbcdefghijklmnopqrstuvwxyz(?:View)?\d*$/i,
  /^[A-Za-z]*Abcdefghijklmnopqrstuvwxyz[A-Za-z0-9]*$/i,
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
const QUALITY_PLAN_BUDGET_MULTIPLIER = 6;
const QUALITY_PLAN_BUDGET_MIN = 160;
const SHARED_HELPER_MODULE_RELATIVE_PATH = "./_shared/helpers.js";
const SHARED_HELPER_MODULE_FILENAME = "helpers.ts";
const SHARED_HELPER_MIN_OCCURRENCES = 2;
const SHARED_HELPER_MAX_COUNT = 64;
const COHESION_MERGE_THRESHOLD = 0.3;
const COHESION_SPLIT_THRESHOLD = 0.16;
const COHESION_SPLIT_MIN_SYMBOLS = 42;
const COHESION_FORCE_SPLIT_SYMBOLS = 420;
const MODULE_MERGE_MAX_SYMBOLS = 680;
const TINY_MODULE_SYMBOL_LIMIT = 96;
const TINY_MODULE_MERGE_BUDGET_FACTOR = 3;
const CHUNK_INDEX_INLINE_IMPORT_THRESHOLD = 4;
const CHUNK_INDEX_INLINE_MAX_NEEDS_PER_CHUNK = 40;
const CHUNK_INDEX_INLINE_MAX_NEEDS_PER_MODULE = 120;
const HEAVY_CHUNK_IMPORT_FALLBACK_STATEMENT_THRESHOLD = 96;
const HEAVY_CHUNK_IMPORT_FALLBACK_IDENTIFIER_THRESHOLD = 36;
const TARGETED_CHUNK_INDEX_INLINE_MAX_NEEDS_PER_MODULE = 24;
const TARGETED_CHUNK_INDEX_INLINE_MAX_NEEDS_PER_TARGET_CHUNK = 8;
const TARGETED_CHUNK_INDEX_INLINE_MAX_SELECTED_STATEMENTS = 20;
const TARGETED_CHUNK_INDEX_INLINE_MAX_DECLARATION_CHARS = 14000;
const TARGETED_CHUNK_INDEX_INLINE_MAX_REQUIRED_IMPORTS = 24;
const BOOTSTRAP_PAYLOAD_STATIC_DECLARATION_MIN = 24;
const BOOTSTRAP_PAYLOAD_STATIC_RATIO_MIN = 0.35;
const BOOTSTRAP_PAYLOAD_IMPORT_FANOUT_MIN = 80;
const STATIC_PAYLOAD_ONLY_VAR_DECLARATION_MIN = 2;
const STATIC_PAYLOAD_ONLY_RATIO_MIN = 0.8;
const STATIC_PAYLOAD_ONLY_MAX_FUNCTION_CLASS_COUNT = 1;
const STATIC_PAYLOAD_LITERAL_MIN_LENGTH = 4096;
const STATIC_PAYLOAD_THEME_GRAMMAR_MIN_LENGTH = 1800;
const STORE_MODULE_MAX_LINES_FAILFAST = 12000;
const SERVICE_MODULE_MAX_LINES_FAILFAST = 12000;
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

function maxPartsForArchetype(archetype: ArchetypeId): number {
  if (archetype === "service" || archetype === "store") {
    return MAX_PARTS_PER_HEAVY_DOMAIN_TOPIC;
  }
  return MAX_PARTS_PER_TOPIC;
}

function sanitizeSegment(candidate: string, fallback: string): string {
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const tokens = normalized
    .split("-")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !/^[a-z]{20,}$/.test(token))
    .filter((token) => !token.includes("abcdefghijklmnopqrstuvwxyz"))
    .filter((token) => !/^[a-f0-9]{10,}$/i.test(token))
    .filter((token) => !/^g\d{3}$/i.test(token));
  const cleaned = tokens.join("-");
  const fallbackNormalized = fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (cleaned.length < 3) {
    return fallback;
  }
  if (GENERIC_SEGMENTS.has(cleaned)) {
    return fallback;
  }
  if (cleaned.includes("abcdefghijklmnopqrstuvwxyz")) {
    return fallbackNormalized.length >= 3 ? fallbackNormalized : fallback;
  }
  return cleaned;
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
  if (/channeldispatch/i.test(symbolName)) {
    return false;
  }
  if (/abcdefghijklmnopqrstuvwxyz/i.test(symbolName)) {
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

function alphabeticStableSuffix(seed: string, length: number): string {
  const hash = shortStableHash(seed);
  const letters: string[] = [];
  let cursor = 0;
  while (letters.length < length) {
    const char = hash[cursor % hash.length] ?? "a";
    const value = Number.parseInt(char, 16);
    const normalized = Number.isNaN(value) ? 0 : value % 26;
    letters.push(String.fromCharCode(97 + normalized));
    cursor += 1;
  }
  return letters.join("");
}

function nextUniqueIdentifier(baseName: string, usedNames: Set<string>): string {
  let candidate = baseName;
  let index = 1;
  while (usedNames.has(candidate)) {
    const suffix = toPascalCase(alphabeticStableSuffix(`${baseName}:${index}`, 3));
    candidate = `${baseName}${suffix}`;
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
      ...bindingTokens,
      ...hintTokens,
      ...clusterTokens,
      ...topicTokens,
      ...stateSignalTokens,
      ...callGraphTokens,
      ...flowTokens,
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
  if (qualifierTokens.length > 0) {
    const weakQualifierSet = new Set<string>(["event", "navigate", "route", "flow", "state", "dispatch"]);
    const allWeak = qualifierTokens.every((token) => weakQualifierSet.has(token));
    if (allWeak) {
      const strongHintTokens = dedupeNameTokens([...bindingTokens, ...hintTokens, ...clusterTokens, ...topicTokens])
        .filter((token) => token.length >= 3)
        .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
        .filter((token) => !GENERIC_SEGMENTS.has(token))
        .filter((token) => !weakQualifierSet.has(token))
        .slice(0, 2);
      if (strongHintTokens.length > 0) {
        qualifierTokens.splice(0, qualifierTokens.length, ...strongHintTokens);
      }
    }
  }
  if (qualifierTokens.length === 0 && liftBinding) {
    const chunkTokens = chunkTopicTokensById.get(liftBinding.chunkId) ?? chunkTokensFromChunkId(liftBinding.chunkId);
    const chunkQualifiers = dedupeNameTokens(chunkTokens)
      .filter((token) => token.length >= 3)
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .slice(0, 1);
    qualifierTokens.push(...chunkQualifiers);
  }
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
  const hasNoisyPattern = (name: string): boolean => {
    const normalized = name.toLowerCase();
    if (normalized.includes("abcdefghijklmnopqrstuvwxyz")) {
      return true;
    }
    if (/^[a-z]{20,}$/.test(normalized)) {
      return true;
    }
    if (/^run[A-Z]/.test(name) && /[a-z]{10,}/.test(normalized)) {
      return true;
    }
    return false;
  };

  if (renameHint && renameHint.confidence >= 0.62) {
    const preferred = sanitizeIdentifier(renameHint.preferredName);
    if (!hasNoisyPattern(preferred)) {
      return nextUniqueName(preferred, usedNames);
    }
  }
  if (shouldKeepSymbolName(symbol.symbolName)) {
    const kept = sanitizeIdentifier(symbol.symbolName);
    if (!hasNoisyPattern(kept)) {
      return nextUniqueName(kept, usedNames);
    }
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
  if (hasNoisyPattern(base)) {
    const fallbackBase = sanitizeIdentifier(
      `${plan.archetype}${toPascalCase(topic)}${archetypeRoleSuffix(plan.archetype)}${ordinal}`,
    );
    return nextUniqueName(fallbackBase, usedNames);
  }
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
  const symbolKeys = [...new Set(plan.symbols.map((symbol) => symbol.symbolKey))].sort((left, right) =>
    left.localeCompare(right),
  );
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
    symbolKeys,
    averageConfidence: clamp(averageConfidence),
    averageNameQuality: clamp(averageNameQuality),
    liftedCoverage: clamp(liftedCoverage),
    rerendered: false,
    hotFocus: plan.hotPriority,
  };
}

function buildOwnershipSubset(base: OwnershipModel, symbols: OwnershipRecord[]): OwnershipModel {
  const bySymbolKey = new Map<string, OwnershipRecord>();
  for (const symbol of symbols) {
    const existing = bySymbolKey.get(symbol.symbolKey);
    if (existing) {
      if (existing.layer !== symbol.layer || existing.archetype !== symbol.archetype) {
        throw new Error(
          `buildOwnershipSubset: symbol ownership conflict for ${symbol.symbolKey}: ` +
          `${existing.layer}/${existing.archetype} vs ${symbol.layer}/${symbol.archetype}`,
        );
      }
      continue;
    }
    assertArchetypeLayerCompatibility(symbol.layer, symbol.archetype, symbol.symbolKey);
    bySymbolKey.set(symbol.symbolKey, symbol);
  }
  return {
    ...base,
    generatedAtIso: new Date().toISOString(),
    symbols: [...bySymbolKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
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
  const genericTopicSeeds = new Set<string>([
    "domain",
    "flow",
    "state",
    "service",
    "hooks",
    "ui-components",
    "transport-bridge",
    "state-store",
    "domain-service",
    "parser",
    "math",
  ]);
  const buildChunkHintTopic = (base: string): string | undefined => {
    const chunkHints = chunkHintTokens(symbol.chunkHint)
      .filter((token) => token.length >= 3)
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token));
    const firstHint = chunkHints[0];
    if (!firstHint) {
      return undefined;
    }
    const normalizedBase = sanitizeSegment(base, "domain");
    if (genericTopicSeeds.has(normalizedBase) || /abcdefghijklmnopqrstuvwxyz/i.test(normalizedBase)) {
      return sanitizeSegment(`${normalizedBase}-${firstHint}`, firstHint);
    }
    return undefined;
  };

  const monolithByKey = monolithTopicHints.bySymbolKey.get(symbol.symbolKey);
  if (monolithByKey) {
    const hinted = buildChunkHintTopic(monolithByKey);
    return hinted ?? monolithByKey;
  }
  const monolithByName = monolithTopicHints.bySymbolName.get(symbol.symbolName);
  if (monolithByName) {
    const hinted = buildChunkHintTopic(monolithByName);
    return hinted ?? monolithByName;
  }
  const renameHint = renameHintsBySymbolKey.get(symbol.symbolKey);
  const symbolicName = renameHint ? renameHint.preferredName : symbol.symbolName;
  const direct = kebabFromSymbol(symbolicName);
  if (direct !== "domain") {
    const hinted = buildChunkHintTopic(direct);
    return hinted ?? direct;
  }
  if (renameHint && renameHint.hintTokens.length > 0) {
    const hintTopic = sanitizeSegment(renameHint.hintTokens.join("-"), "domain");
    if (hintTopic !== "domain") {
      const hinted = buildChunkHintTopic(hintTopic);
      return hinted ?? hintTopic;
    }
  }
  const fallback = fallbackTopicByArchetype(symbol.archetype);
  const hinted = buildChunkHintTopic(fallback);
  return hinted ?? fallback;
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

function splitTopicSymbols(symbols: OwnershipRecord[], chunkBudget: number, archetype: ArchetypeId): OwnershipRecord[][] {
  const maxParts = maxPartsForArchetype(archetype);
  const chunkHintBuckets = new Map<string, OwnershipRecord[]>();
  for (const symbol of symbols) {
    const bucketToken = chunkHintTokens(symbol.chunkHint)[0] ?? "domain";
    const bucket = chunkHintBuckets.get(bucketToken) ?? [];
    bucket.push(symbol);
    chunkHintBuckets.set(bucketToken, bucket);
  }
  if (chunkHintBuckets.size >= 2 && symbols.length >= Math.max(chunkBudget, 48)) {
    const rankedBuckets = [...chunkHintBuckets.entries()]
      .sort((left, right) => {
        if (left[1].length !== right[1].length) {
          return right[1].length - left[1].length;
        }
        return left[0].localeCompare(right[0]);
      });
    const parts: OwnershipRecord[][] = rankedBuckets
      .slice(0, maxParts)
      .map(([, bucket]) => [...bucket].sort((left, right) => left.symbolName.localeCompare(right.symbolName)));
    const overflowBuckets = rankedBuckets.slice(maxParts);
    if (parts.length > 0) {
      let partIndex = 0;
      for (const [, overflow] of overflowBuckets) {
        const targetPart = parts[partIndex];
        if (targetPart) {
          targetPart.push(...overflow);
        }
        partIndex = (partIndex + 1) % parts.length;
      }
    }
    const normalizedParts = parts
      .map((part) => part.sort((left, right) => left.symbolName.localeCompare(right.symbolName)))
      .filter((part) => part.length > 0);
    if (normalizedParts.length >= 2) {
      return normalizedParts;
    }
  }

  const initial = splitByBudget(symbols, chunkBudget);
  if (initial.length <= 1) {
    return initial;
  }
  const minPartCountByHardLimit = Math.max(1, Math.ceil(symbols.length / HARD_SYMBOL_LIMIT_PER_MODULE));
  const targetPartCount = Math.max(
    minPartCountByHardLimit,
    Math.min(maxParts, initial.length),
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
        const chunks = splitTopicSymbols(byName, chunkBudget, archetype);
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
            hotPriority: false,
          });
        }
      }
    }
  }

  return plans.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function isHotFirstFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|\/)src\/services\/service\/service-run\.ts$/.test(normalized)) {
    return true;
  }
  if (/(?:^|\/)src\/services\/store\/store-state(?:-g\d+|-quality-\d+)?\.ts$/.test(normalized)) {
    return true;
  }
  if (/(?:^|\/)src\/services\/(?:service|store)\//.test(normalized)) {
    return true;
  }
  return false;
}

function hotFamilyKeyFromFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const withoutExt = normalized.replace(/\.ts$/i, "");
  return withoutExt
    .replace(/-quality-\d+$/i, "")
    .replace(/-cohesion-\d+$/i, "")
    .replace(/-part-\d+$/i, "")
    .replace(/-g\d+$/i, "");
}

function applyHotSeedPriority(modulePlans: ModulePlan[], hotSeedFamilies: ReadonlySet<string>): ModulePlan[] {
  if (hotSeedFamilies.size < 1) {
    return modulePlans;
  }
  return modulePlans.map((plan) => ({
    ...plan,
    hotPriority: plan.hotPriority || hotSeedFamilies.has(hotFamilyKeyFromFilePath(plan.filePath)),
  }));
}

async function loadManualHotTargets(
  manualRefactorCandidatesPath: string | undefined,
): Promise<ManualHotTargets> {
  const seedFamilies = new Set<string>();
  const criticalHotFilePaths = new Set<string>();
  if (!manualRefactorCandidatesPath || manualRefactorCandidatesPath.length < 1) {
    return {
      hotSeedFamilies: seedFamilies,
      criticalHotFilePaths,
    };
  }
  const exists = await fs
    .stat(manualRefactorCandidatesPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return {
      hotSeedFamilies: seedFamilies,
      criticalHotFilePaths,
    };
  }

  const report = await readJsonFile<ManualRefactorCandidatesModel>(manualRefactorCandidatesPath);
  if (!report || !Array.isArray(report.candidates)) {
    return {
      hotSeedFamilies: seedFamilies,
      criticalHotFilePaths,
    };
  }

  const candidates = [...report.candidates]
    .filter((candidate) => typeof candidate.filePath === "string" && candidate.filePath.length > 0)
    .filter((candidate) => typeof candidate.averageScore === "number" && Number.isFinite(candidate.averageScore))
    .filter((candidate) => isHotFirstFilePath(candidate.filePath))
    .sort((left, right) => {
      if (left.averageScore !== right.averageScore) {
        return left.averageScore - right.averageScore;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, HOT_FIRST_MAX_TARGET_FILES);

  const criticalCandidates = candidates.slice(0, Math.min(HOT_FIRST_CRITICAL_TOP_WORST_COUNT, candidates.length));
  for (const candidate of criticalCandidates) {
    criticalHotFilePaths.add(candidate.filePath.replace(/\\/g, "/").toLowerCase());
  }

  for (const candidate of candidates) {
    seedFamilies.add(hotFamilyKeyFromFilePath(candidate.filePath));
  }
  return {
    hotSeedFamilies: seedFamilies,
    criticalHotFilePaths,
  };
}

function isHotFirstCandidate(plan: ModulePlan, entry: ModuleQualityEntry): boolean {
  if (plan.hotPriority) {
    return true;
  }
  if (isHotFirstFilePath(plan.filePath)) {
    return true;
  }
  if (plan.layer === "services" && (plan.archetype === "service" || plan.archetype === "store")) {
    return true;
  }
  if ((plan.archetype === "service" || plan.archetype === "store") && entry.symbolCount >= 48) {
    return true;
  }
  return false;
}

function resolveHotFirstTargetCount(planCount: number): number {
  if (planCount <= 0) {
    return 0;
  }
  const baselineTarget = Math.max(1, Math.ceil(planCount * FILE_QUALITY_WORST_PERCENT));
  if (!HOT_FIRST_REGENERATION_ENABLED) {
    return baselineTarget;
  }
  const boundedMax = Math.min(HOT_FIRST_MAX_TARGET_FILES, planCount);
  const boundedMin = Math.min(HOT_FIRST_MIN_TARGET_FILES, boundedMax);
  return Math.max(boundedMin, Math.min(baselineTarget, boundedMax));
}

function applyFileQualityRerender(
  modulePlans: ModulePlan[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
  statementBudget: number,
  hotSeedFamilies: ReadonlySet<string>,
  criticalHotFilePaths: ReadonlySet<string>,
): { modulePlans: ModulePlan[]; qualityEntries: ModuleQualityEntry[]; rerenderedModuleCount: number } {
  if (modulePlans.length === 0) {
    return {
      modulePlans: [],
      qualityEntries: [],
      rerenderedModuleCount: 0,
    };
  }

  const orderedPlans = [...modulePlans].sort((left, right) => left.filePath.localeCompare(right.filePath));
  const planByModuleId = new Map<string, ModulePlan>(orderedPlans.map((plan) => [plan.moduleId, plan]));
  const baselineEntries = orderedPlans.map((plan) => computeModuleQuality(plan, bindingByKey));
  const targetCount = resolveHotFirstTargetCount(orderedPlans.length);
  const sortedCandidates = [...baselineEntries]
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.filePath.localeCompare(right.filePath);
    })
    .filter((entry) => entry.symbolCount >= HOT_FIRST_MIN_SYMBOL_COUNT);

  const hotCandidates = HOT_FIRST_REGENERATION_ENABLED
    ? sortedCandidates.filter((entry) => {
      const plan = planByModuleId.get(entry.moduleId);
      if (!plan) {
        return false;
      }
      return isHotFirstCandidate(plan, entry);
    })
    : sortedCandidates;
  const candidatePool = hotCandidates.length > 0 ? hotCandidates : sortedCandidates;
  const selectedCandidates: ModuleQualityEntry[] = [];
  const selectedModuleIds = new Set<string>();
  if (criticalHotFilePaths.size > 0) {
    const criticalCandidates = candidatePool.filter((entry) => {
      const normalized = entry.filePath.replace(/\\/g, "/").toLowerCase();
      return criticalHotFilePaths.has(normalized);
    });
    for (const candidate of criticalCandidates) {
      if (selectedCandidates.length >= targetCount) {
        break;
      }
      if (selectedModuleIds.has(candidate.moduleId)) {
        continue;
      }
      selectedModuleIds.add(candidate.moduleId);
      selectedCandidates.push(candidate);
    }
  }
  if (hotSeedFamilies.size > 0) {
    const seededCandidates = candidatePool.filter((entry) => {
      const plan = planByModuleId.get(entry.moduleId);
      if (!plan) {
        return false;
      }
      return hotSeedFamilies.has(hotFamilyKeyFromFilePath(plan.filePath));
    });
    for (const candidate of seededCandidates) {
      if (selectedCandidates.length >= targetCount) {
        break;
      }
      if (selectedModuleIds.has(candidate.moduleId)) {
        continue;
      }
      selectedModuleIds.add(candidate.moduleId);
      selectedCandidates.push(candidate);
    }
  }
  for (const candidate of candidatePool) {
    if (selectedCandidates.length >= targetCount) {
      break;
    }
    if (selectedModuleIds.has(candidate.moduleId)) {
      continue;
    }
    selectedModuleIds.add(candidate.moduleId);
    selectedCandidates.push(candidate);
  }
  const hotCandidateModuleIds = new Set<string>(selectedCandidates.map((entry) => entry.moduleId));

  const rerenderedPlanByModuleId = new Map<string, ModulePlan[]>();
  for (const candidate of selectedCandidates) {
    const plan = planByModuleId.get(candidate.moduleId);
    if (!plan) {
      continue;
    }
    const baseBudget = statementBudgetForArchetype(plan.archetype, statementBudget);
    const reducedBudget = Math.max(ARCHETYPE_BUDGET_MIN[plan.archetype], Math.floor(baseBudget * 0.55));
    const targetPartCount = Math.max(2, Math.ceil(plan.symbols.length / Math.max(1, reducedBudget)));
    if (targetPartCount <= 1 || plan.symbols.length <= 1) {
      continue;
    }
    const parts = splitBalanced(plan.symbols, Math.min(maxPartsForArchetype(plan.archetype), targetPartCount));
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
        hotPriority: true,
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
    finalPlans.push({
      ...plan,
      hotPriority: plan.hotPriority || hotCandidateModuleIds.has(plan.moduleId),
    });
  }

  finalPlans.sort((left, right) => left.filePath.localeCompare(right.filePath));
  const qualityEntries = finalPlans.map((plan) => {
    const entry = computeModuleQuality(plan, bindingByKey);
    const originalIdRaw = plan.moduleId.split(":quality-")[0];
    const originalId = originalIdRaw && originalIdRaw.length > 0 ? originalIdRaw : plan.moduleId;
    return {
      ...entry,
      rerendered: rerenderedModuleIds.has(originalId),
      hotFocus: plan.hotPriority,
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

function resolveBoundaryTagForSymbol(
  symbol: OwnershipRecord,
  signalContext: EmitterSignalContext,
): "state-boundary" | "event-boundary" | "route-boundary" | "mixed-boundary" | "domain-boundary" {
  const signal = signalContext.symbolSignalByKey.get(symbol.symbolKey);
  if (!signal) {
    return "domain-boundary";
  }
  const hasState = signal.stateTokens.length >= 2;
  const hasEvent = signal.eventFlowScore >= 0.58;
  const hasRoute = signal.routeFlowScore >= 0.58;
  if ((hasState && hasEvent) || (hasState && hasRoute) || (hasEvent && hasRoute)) {
    return "mixed-boundary";
  }
  if (hasState) {
    return "state-boundary";
  }
  if (hasEvent) {
    return "event-boundary";
  }
  if (hasRoute) {
    return "route-boundary";
  }
  return "domain-boundary";
}

function resolveBoundaryTagForPlan(
  plan: ModulePlan,
  signalContext: EmitterSignalContext,
): "state-boundary" | "event-boundary" | "route-boundary" | "mixed-boundary" | "domain-boundary" {
  const countByBoundary = new Map<string, number>();
  for (const symbol of plan.symbols) {
    const boundary = resolveBoundaryTagForSymbol(symbol, signalContext);
    countByBoundary.set(boundary, (countByBoundary.get(boundary) ?? 0) + 1);
  }
  let bestBoundary: "state-boundary" | "event-boundary" | "route-boundary" | "mixed-boundary" | "domain-boundary" =
    "domain-boundary";
  let bestCount = 0;
  for (const boundary of ["mixed-boundary", "state-boundary", "event-boundary", "route-boundary", "domain-boundary"] as const) {
    const count = countByBoundary.get(boundary) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestBoundary = boundary;
    }
  }
  return bestBoundary;
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

function ensureUniqueModulePlanPaths(modulePlans: ModulePlan[]): ModulePlan[] {
  if (modulePlans.length < 2) {
    return modulePlans;
  }
  const usedPaths = new Set<string>();
  const collisionCountByBasePath = new Map<string, number>();
  return modulePlans.map((plan) => {
    let candidatePath = plan.filePath;
    if (!usedPaths.has(candidatePath)) {
      usedPaths.add(candidatePath);
      return plan;
    }
    const baseCount = collisionCountByBasePath.get(plan.filePath) ?? 1;
    let suffixIndex = baseCount + 1;
    while (true) {
      const suffix = `-g${String(suffixIndex).padStart(3, "0")}`;
      candidatePath = plan.filePath.replace(/\.ts$/, `${suffix}.ts`);
      if (!usedPaths.has(candidatePath)) {
        usedPaths.add(candidatePath);
        collisionCountByBasePath.set(plan.filePath, suffixIndex);
        return {
          ...plan,
          moduleId: `${plan.moduleId}:g${String(suffixIndex).padStart(3, "0")}`,
          filePath: candidatePath,
        };
      }
      suffixIndex += 1;
    }
  });
}

function dedupeSymbolsByKey(symbols: OwnershipRecord[]): OwnershipRecord[] {
  const byKey = new Map<string, OwnershipRecord>();
  for (const symbol of symbols) {
    const existing = byKey.get(symbol.symbolKey);
    if (existing) {
      if (existing.layer !== symbol.layer || existing.archetype !== symbol.archetype) {
        throw new Error(
          `dedupeSymbolsByKey: ownership mismatch for ${symbol.symbolKey}: ` +
          `${existing.layer}/${existing.archetype} vs ${symbol.layer}/${symbol.archetype}`,
        );
      }
      continue;
    }
    byKey.set(symbol.symbolKey, symbol);
  }
  return [...byKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
}

function isTargetedQualityShardFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)src\/services\/store\/(?:store-state-quality-01|store-state-quality-02|store-state-g002-quality-03)(?:-cohesion-\d+)?\.ts$/i.test(
    normalized,
  );
}

function isPrimaryTargetedQualityShardFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)src\/services\/store\/(?:store-state-quality-01|store-state-quality-02|store-state-g002-quality-03)(?:-cohesion-\d+)?\.ts$/i.test(
    normalized,
  );
}

function collapseTinyModulePlans(modulePlans: ModulePlan[], statementBudget: number): ModulePlan[] {
  if (modulePlans.length <= 1) {
    return modulePlans;
  }
  const grouped = new Map<string, ModulePlan[]>();
  for (const plan of modulePlans) {
    const key = `${plan.layer}:${plan.archetype}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(plan);
    grouped.set(key, bucket);
  }

  const collapsed: ModulePlan[] = [];
  const keys = [...grouped.keys()].sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const group = grouped.get(key);
    if (!group || group.length === 0) {
      continue;
    }
    const ordered = [...group].sort((left, right) => left.filePath.localeCompare(right.filePath));
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
      const mergeBudget = Math.min(MODULE_MERGE_MAX_SYMBOLS, Math.floor(budget * TINY_MODULE_MERGE_BUDGET_FACTOR));
      const combinedSize = current.symbols.length + candidate.symbols.length;
      const hasTinySide =
        current.symbols.length <= TINY_MODULE_SYMBOL_LIMIT || candidate.symbols.length <= TINY_MODULE_SYMBOL_LIMIT;
      const compatible = current.layer === candidate.layer && current.archetype === candidate.archetype;
      if (!compatible || !hasTinySide || combinedSize > mergeBudget) {
        collapsed.push(current);
        current = candidate;
        continue;
      }
      const mergedTopic = mergeTopics(current.topic, candidate.topic, current.archetype);
      current = {
        ...current,
        topic: mergedTopic,
        clusterId: mergedTopic,
        symbols: dedupeSymbolsByKey([...current.symbols, ...candidate.symbols]),
        hotPriority: current.hotPriority || candidate.hotPriority,
      };
    }
    collapsed.push(current);
  }
  return collapsed;
}

function splitPlanByCohesion(
  plan: ModulePlan,
  renameHintsBySymbolKey: ReadonlyMap<string, DomainRenameHint>,
  signalContext: EmitterSignalContext,
): ModulePlan[] {
  const targetedQualityShardPlan = isTargetedQualityShardFilePath(plan.filePath);
  if (!targetedQualityShardPlan && plan.symbols.length < COHESION_SPLIT_MIN_SYMBOLS) {
    return [plan];
  }
  const forceSplit = targetedQualityShardPlan || plan.symbols.length >= COHESION_FORCE_SPLIT_SYMBOLS;
  const cohesion = moduleCohesionScore(plan, renameHintsBySymbolKey, signalContext);
  if (!targetedQualityShardPlan && !forceSplit && cohesion >= COHESION_SPLIT_THRESHOLD) {
    return [plan];
  }

  const buckets = new Map<string, OwnershipRecord[]>();
  for (const symbol of plan.symbols) {
    const tokens = buildCohesionTokensForSymbol(symbol, renameHintsBySymbolKey, signalContext);
    const head = tokens[0] ?? "domain";
    const boundary = resolveBoundaryTagForSymbol(symbol, signalContext);
    const bucketKey = `${boundary}:${head}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(symbol);
    buckets.set(bucketKey, bucket);
  }
  const maxBucketCount = targetedQualityShardPlan
    ? Math.min(6, Math.max(4, maxPartsForArchetype(plan.archetype) + 1))
    : forceSplit
      ? Math.min(5, maxPartsForArchetype(plan.archetype))
      : 2;
  const boundaryPriority = (bucketToken: string): number => {
    const boundary = bucketToken.split(":")[0] ?? "domain-boundary";
    if (boundary === "state-boundary") {
      return 6;
    }
    if (boundary === "event-boundary") {
      return 5;
    }
    if (boundary === "mixed-boundary") {
      return 4;
    }
    if (boundary === "route-boundary") {
      return 3;
    }
    return 1;
  };
  const rankedBuckets = [...buckets.entries()]
    .sort((left, right) => {
      if (targetedQualityShardPlan) {
        const priorityDelta = boundaryPriority(right[0]) - boundaryPriority(left[0]);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
      }
      const sizeDelta = right[1].length - left[1].length;
      if (sizeDelta !== 0) {
        return sizeDelta;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, maxBucketCount);
  if (rankedBuckets.length < 2) {
    return [plan];
  }
  const parts: ModulePlan[] = [];
  const selectedSymbolKeys = new Set<string>();
  for (let index = 0; index < rankedBuckets.length; index += 1) {
    const bucket = rankedBuckets[index];
    if (!bucket) {
      continue;
    }
    const [token, symbols] = bucket;
    const boundaryToken = token.split(":")[0] ?? "domain";
    const topicToken = token.split(":")[1] ?? "domain";
    for (const symbol of symbols) {
      selectedSymbolKeys.add(symbol.symbolKey);
    }
    const partTopic = sanitizeSegment(`${plan.topic}-${boundaryToken}-${topicToken}`, plan.topic);
    parts.push({
      ...plan,
      topic: partTopic,
      clusterId: partTopic,
      moduleId: `${plan.moduleId}:cohesion-${String(index + 1).padStart(2, "0")}`,
      symbols: [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
      filePath: plan.filePath.replace(/\.ts$/, `-cohesion-${String(index + 1).padStart(2, "0")}.ts`),
    });
  }
  if (targetedQualityShardPlan) {
    const residualSymbols = plan.symbols.filter((symbol) => !selectedSymbolKeys.has(symbol.symbolKey));
    if (residualSymbols.length > 0) {
      const partIndex = parts.length + 1;
      const residualTopic = sanitizeSegment(`${plan.topic}-state-event-residual`, plan.topic);
      parts.push({
        ...plan,
        topic: residualTopic,
        clusterId: residualTopic,
        moduleId: `${plan.moduleId}:cohesion-${String(partIndex).padStart(2, "0")}`,
        symbols: residualSymbols.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
        filePath: plan.filePath.replace(/\.ts$/, `-cohesion-${String(partIndex).padStart(2, "0")}.ts`),
      });
    }
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
      const currentBoundary = resolveBoundaryTagForPlan(current, signalContext);
      const candidateBoundary = resolveBoundaryTagForPlan(candidate, signalContext);
      const compatibleBoundary =
        currentBoundary === candidateBoundary ||
        currentBoundary === "domain-boundary" ||
        candidateBoundary === "domain-boundary";
      const canMerge =
        combinedSize <= Math.min(MODULE_MERGE_MAX_SYMBOLS, Math.floor(budget * 1.35)) &&
        compatibleBoundary &&
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
        hotPriority: current.hotPriority || candidate.hotPriority,
      };
    }
    mergedPlans.push(current);
  }

  const splitPlans: ModulePlan[] = [];
  for (const plan of mergedPlans) {
    const split = splitPlanByCohesion(plan, renameHintsBySymbolKey, signalContext);
    splitPlans.push(...split);
  }
  const collapsedPlans = collapseTinyModulePlans(splitPlans, statementBudget);

  const groupIndexByKey = new Map<string, number>();
  const finalized = [...collapsedPlans]
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

  return ensureUniqueModulePlanPaths(finalized);
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
      '      "require-yield": "off",',
      '      "no-self-assign": "off",',
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
      '      "no-empty": "off",',
      '      "getter-return": "off",',
      '      "no-unused-private-class-members": "off",',
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
  criticalHotFilePaths: ReadonlySet<string>,
): QualityModuleBuildResult {
  if (symbols.length === 0) {
    throw new Error(`buildQualityModuleContent: module ${plan.moduleId} has no symbols`);
  }

  interface ExportEntry {
    exportName: string;
    chunkId: string;
    sourceIdentifier: string;
    localIdentifier: string;
  }

  const topic = topicSegmentFromFilePath(plan.filePath, plan.archetype);
  const usedExportNames = new Map<string, number>();
  const exportEntries: ExportEntry[] = [];
  const dependencyImportLines = new Set<string>();
  const dependencyAliasNames = new Set<string>();
  const moduleNamespaceAliasByModulePath = new Map<string, string>();
  const moduleNamespaceBindingsByAlias = new Map<string, Map<string, string>>();
  const assetImportsByPath = new Map<string, string>();
  const assetFilesByPath = new Map<string, string>();
  const chunkDeclarationBlocks: string[] = [];
  const usedTopLevelNames = new Set<string>();
  const IMPORT_CHAIN_NOISE_TOKENS = new Set<string>([
    "symbol",
    "symbols",
    "lifted",
    "chunk",
    "chunks",
    "runtime",
    "module",
    "modules",
    "entry",
    "main",
    "renderer",
    "service",
    "services",
    "store",
    "stores",
  ]);
  const sanitizeAliasTokens = (tokens: string[]): string[] =>
    tokens
      .filter((token) => token.length >= 3)
      .filter((token) => !IMPORT_CHAIN_NOISE_TOKENS.has(token))
      .filter((token) => !DOMAIN_ALIAS_WEAK_TOKENS.has(token))
      .filter((token) => !/^[a-f0-9]{6,}$/i.test(token))
      .filter((token) => !/^[a-z]{18,}$/.test(token))
      .filter((token) => !token.includes("abcdefghijklmnopqrstuvwxyz"))
      .filter((token) => !/\d/.test(token))
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token));
  const planSignalTokens = dedupeNameTokens(
    plan.symbols.flatMap((symbol) => {
      const signal = signalContext.symbolSignalByKey.get(symbol.symbolKey);
      if (!signal) {
        return [];
      }
      return [...signal.stateTokens, ...signal.callGraphTokens, ...signal.signalTokens];
    }),
  );
  const planAliasDomainTokens = sanitizeAliasTokens(planSignalTokens).slice(0, 8);
  const targetedHotDomainStopTokens = new Set<string>([
    ...SIGNAL_TOKEN_STOPWORDS,
    ...GENERIC_SEGMENTS,
    ...DOMAIN_ALIAS_WEAK_TOKENS,
    "agent",
    "settings",
    "config",
    "event",
    "events",
    "state",
    "states",
    "node",
    "nodes",
    "store",
    "service",
    "services",
    "renderer",
    "main",
    "tauri",
    "domain",
    "dep",
    "default",
    "value",
    "values",
  ]);
  const planDomainPriorityTokens = dedupeNameTokens([...planSignalTokens, ...planAliasDomainTokens])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3)
    .filter((token) => !targetedHotDomainStopTokens.has(token))
    .slice(0, 16);
  const pickPlanDomainToken = (seed: string): string => {
    if (planDomainPriorityTokens.length < 1) {
      return fallbackTopicByArchetype(plan.archetype);
    }
    const hash = shortStableHash(`${plan.moduleId}:${seed}`);
    const index = Number.parseInt(hash.slice(0, 6), 16) % planDomainPriorityTokens.length;
    return planDomainPriorityTokens[index] ?? planDomainPriorityTokens[0] ?? fallbackTopicByArchetype(plan.archetype);
  };
  const weakAliasStemTokenSet = new Set<string>([
    "domain",
    "event",
    "navigate",
    "state",
    "store",
    "service",
    "flow",
    "route",
    "dispatch",
    "node",
    "chunk",
    "member",
    "dependency",
  ]);
  const importAliasStopTokens = new Set<string>([
    ...SIGNAL_TOKEN_STOPWORDS,
    ...GENERIC_SEGMENTS,
    ...DOMAIN_ALIAS_WEAK_TOKENS,
    "event",
    "events",
    "navigate",
    "route",
    "flow",
    "state",
    "states",
    "node",
    "nodes",
    "ref",
    "default",
    "value",
    "values",
  ]);
  const sanitizeImportAliasTokens = (tokens: string[]): string[] =>
    sanitizeAliasTokens(tokens).filter((token) => !importAliasStopTokens.has(token));
  const normalizedHotFilePath = plan.filePath.replace(/\\/g, "/");
  const targetedQualityShardModule = isTargetedQualityShardFilePath(normalizedHotFilePath);
  const strictTargetedQualityShardModule = isPrimaryTargetedQualityShardFilePath(normalizedHotFilePath);
  const hotFocusModule = plan.hotPriority;
  const criticalTopWorstModule = hotFocusModule && criticalHotFilePaths.has(normalizedHotFilePath.toLowerCase());
  const targetedHotStoreModule = criticalTopWorstModule && plan.archetype === "store";
  const targetedHotStoreG003Module = criticalTopWorstModule && /(?:^|\/)store-state-g003\.ts$/i.test(normalizedHotFilePath);
  const targetedHotServiceModule = criticalTopWorstModule && plan.archetype === "service";
  const targetedHotWorstStoreServiceModule =
    criticalTopWorstModule && (plan.archetype === "service" || plan.archetype === "store");
  const fullLiftFocusedStoreServiceModule =
    targetedHotWorstStoreServiceModule || (targetedQualityShardModule && plan.archetype === "store");
  const targetedHotCriticalStoreServiceModule =
    criticalTopWorstModule && /(?:^|\/)(?:store-state-g002|service-run)\.ts$/i.test(normalizedHotFilePath);
  const targetedHotLocalRenameEnabled =
    (plan.archetype === "service" || plan.archetype === "store") &&
    (targetedHotStoreModule || targetedHotServiceModule || targetedQualityShardModule);
  const targetedHotWeakTokenSet = new Set<string>([
    "event",
    "events",
    "state",
    "states",
    "navigate",
    "route",
    "flow",
    "node",
    "nodes",
    "page",
    "service",
    "store",
    "domain",
    "member",
    "dependency",
    "default",
    "value",
    "values",
    "agent",
    "settings",
    "config",
    "path",
    "route",
    "navigation",
    "diagram",
    "page",
    "panel",
    "abnormal",
    "exit",
    "eventflow",
    "nnetne",
    "ane",
    "iae",
    "sae",
    "sie",
  ]);
  const targetedHotSemanticAllowTokens = new Set<string>([
    "angular",
    "core",
    "channel",
    "diagram",
    "language",
    "runtime",
    "theme",
    "grammar",
    "payload",
    "parser",
    "render",
    "route",
    "store",
    "service",
    "hook",
    "transport",
    "state",
    "event",
    "dispatch",
    "workspace",
    "session",
    "project",
    "layout",
    "config",
    "settings",
    "schema",
    "workspace",
    "session",
    "chat",
    "router",
    "layout",
    "terminal",
    "git",
    "auth",
    "transport",
  ]);
  const targetedHotAlphabetRunPattern = /abcdefghijklmnopqrstuvwxyz/i;
  const targetedHotNoiseSuffixPattern = /(?:Event|State)[A-Za-z]{0,3}\d+$/;
  const targetedHotImportAliasPattern = /(?:Event|State)Ref[A-Za-z]{2,}$/;
  const targetedHotQeAliasPattern = /^[a-z]Qe[A-Za-z0-9]{2,}$/;
  const targetedHotSyntheticStemPattern = /^(?:store|service)(?:[A-Z][a-z]{2}){2,}Local[A-Za-z0-9]{2,}$/;
  const targetedHotLocalNoiseIdentifierPattern =
    /(?:EventFlowNode|Abnormal(?:Exit)?|NneTne|(?:store|service)Iae[A-Za-z]{2,}Local[A-Z]{2}|(?:store|service)SaeSieLocal[A-Za-z0-9]{2,}|(?:store|service)(?:[A-Z][a-z]{2}){2,}Local[A-Za-z0-9]{2,}|[a-z]Qe[A-Za-z0-9]{2,})/i;
  const targetedHotDomainNoisePattern =
    /(?:Event|State)(?:Navigate)?Node[A-Za-z]{2,}Node$|EventFlowNode|(?:store|svc|service)AgentSettings|Abnormal(?:Exit)?|Abcdefghijklmnopqrstuvwxyz|(?:store|service)Iae[A-Za-z]{2,}Local[A-Z]{2}|(?:store|service)SaeSie/i;
  const maxConsonantRunLength = (token: string): number => {
    let best = 0;
    let current = 0;
    for (const char of token) {
      if ("aeiou".includes(char)) {
        current = 0;
        continue;
      }
      current += 1;
      if (current > best) {
        best = current;
      }
    }
    return best;
  };
  const isLikelyObfuscatedAliasToken = (token: string): boolean => {
    const normalized = token.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.length < 3) {
      return true;
    }
    if (targetedHotSemanticAllowTokens.has(normalized)) {
      return false;
    }
    if (targetedHotAlphabetRunPattern.test(normalized)) {
      return true;
    }
    if (/^[a-f0-9]{6,}$/i.test(normalized)) {
      return true;
    }
    if (/^dep[a-z]{3,4}$/i.test(normalized) && normalized !== "deploy") {
      return true;
    }
    if (
      /^de[a-z]{4,}$/i.test(normalized) &&
      !normalized.startsWith("default") &&
      !normalized.startsWith("debug") &&
      !normalized.startsWith("deploy") &&
      !normalized.startsWith("design")
    ) {
      return true;
    }
    let vowels = 0;
    for (const char of normalized) {
      if ("aeiou".includes(char)) {
        vowels += 1;
      }
    }
    if (normalized.length === 3 && vowels <= 1) {
      return true;
    }
    if (normalized.length >= 6 && vowels <= 1) {
      return true;
    }
    if (normalized.length >= 6 && maxConsonantRunLength(normalized) >= 5) {
      return true;
    }
    return false;
  };
  const normalizeTargetedAliasBase = (value: string): string => {
    let normalized = value;
    normalized = normalized.replace(/Abcdefghijklmnopqrstuvwxyz/gi, "Domain");
    normalized = normalized.replace(/EventFlowNode/gi, "Domain");
    normalized = normalized.replace(/Abnormal(?:Exit)?/gi, "Domain");
    normalized = normalized.replace(/NneTne/gi, "Domain");
    normalized = normalized.replace(/Iae/gi, "");
    normalized = normalized.replace(/SaeSie/gi, "Core");
    normalized = normalized.replace(/\b(store|service)(?:[A-Z][a-z]{2}){2,}(Local)/g, "$1Core$2");
    normalized = normalized.replace(/(?:Event|State)NavigateNode/gi, "Flow");
    normalized = normalized.replace(/NavigatePage/gi, "Flow");
    normalized = normalized.replace(/DepDep+/g, "Dep");
    normalized = normalized.replace(/NodeNode+/g, "Node");
    normalized = normalized.replace(
      /(store|service)(Runtime|State|React|Preload|Language|Diagram)\2(Local)/g,
      "$1$2$3",
    );
    normalized = normalized.replace(/(Local|Dep)(Local|Dep)$/g, "$2");
    const sanitized = sanitizeIdentifier(normalized);
    if (sanitized.length > 0) {
      return sanitized;
    }
    return "domainAlias";
  };
  const stabilizeTargetedAliasEntropy = (value: string, seed: string): string => {
    const depTailMatch = value.match(/^(.*Dep)([A-Za-z]{3,8})$/);
    if (!depTailMatch) {
      return value;
    }
    const depPrefix = depTailMatch[1];
    const depTail = depTailMatch[2];
    if (!depPrefix || !depTail) {
      return value;
    }
    if (!isLikelyObfuscatedAliasToken(`dep${depTail.toLowerCase()}`) && !isLikelyObfuscatedAliasToken(depTail)) {
      return value;
    }
    const stabilizedTail = toPascalCase(alphabeticStableSuffix(`dep-tail:${seed}:${value}`, 3));
    return `${depPrefix}${stabilizedTail}`;
  };
  const buildStableAliasTag = (rawValue: string, fallbackPrefix: string): string => {
    const normalized = rawValue.replace(/[^A-Za-z0-9]+/g, "");
    const shouldUseRaw =
      normalized.length >= 3 &&
      !/\d/.test(normalized) &&
      !OBFUSCATED_ALIAS_STYLE_PATTERN.test(normalized) &&
      !/^[a-z]\d+$/i.test(normalized) &&
      !isLikelyObfuscatedAliasToken(normalized);
    if (shouldUseRaw) {
      return toPascalCase(normalized.length <= 8 ? normalized : normalized.slice(0, 8));
    }
    return toPascalCase(`${fallbackPrefix}${alphabeticStableSuffix(`${fallbackPrefix}:${rawValue}`, 3)}`);
  };
  const isWeakAliasStem = (tokens: string[]): boolean => {
    if (tokens.length < 1) {
      return true;
    }
    return tokens.every((token) => weakAliasStemTokenSet.has(token));
  };
  const buildTargetedHotLocalAliasBase = (
    currentName: string,
    originalName: string,
    chunkId: string,
    kind: "import" | "local",
  ): string => {
    if (!targetedHotLocalRenameEnabled) {
      return currentName;
    }
    const shortObfuscatedLocalCandidate =
      kind === "local" &&
      currentName.length <= 4 &&
      !targetedHotSemanticAllowTokens.has(currentName.toLowerCase()) &&
      isLikelyObfuscatedAliasToken(currentName);
    const shouldRewrite =
      targetedHotNoiseSuffixPattern.test(currentName) ||
      targetedHotImportAliasPattern.test(currentName) ||
      targetedHotDomainNoisePattern.test(currentName) ||
      /(?:NneTne|Abnormal(?:Exit)?|EventFlow)(?:Local|Node)/i.test(currentName) ||
      /(?:store|service)Iae[A-Za-z]{2,}Local[A-Z]{2}$/i.test(currentName) ||
      /(?:store|service)SaeSieLocal[A-Za-z0-9]{2,}$/i.test(currentName) ||
      targetedHotSyntheticStemPattern.test(currentName) ||
      targetedHotQeAliasPattern.test(currentName) ||
      /StateState/i.test(currentName) ||
      /Node\d+$/i.test(currentName) ||
      /EventFlowNode/i.test(currentName) ||
      /(?:Event|State)NavigateNode/i.test(currentName) ||
      /[A-Za-z]{34,}/.test(currentName) ||
      shortObfuscatedLocalCandidate;
    if (!shouldRewrite) {
      return currentName;
    }
    const chunkTokens = sanitizeAliasTokens(chunkTopicTokensById.get(chunkId) ?? chunkTokensFromChunkId(chunkId));
    const originalTokens = sanitizeAliasTokens(splitNameTokens(originalName));
    const currentTokens = sanitizeAliasTokens(splitNameTokens(currentName));
    const forceStoreDomainReset =
      targetedHotStoreModule &&
      (/(?:Abnormal|EventFlow|NneTne)/i.test(currentName) || /(?:Abnormal|EventFlow|NneTne)/i.test(originalName));
    const topicTokens = sanitizeAliasTokens(splitNameTokens(topic));
    const seedTokens = forceStoreDomainReset
      ? dedupeNameTokens([
          ...planDomainPriorityTokens,
          ...topicTokens,
          ...chunkTokens,
          ...planAliasDomainTokens,
        ])
      : dedupeNameTokens([
          ...planDomainPriorityTokens,
          ...planAliasDomainTokens,
          ...originalTokens,
          ...currentTokens,
          ...chunkTokens,
        ]);
    const stemTokens = seedTokens
      .filter((token) => !targetedHotWeakTokenSet.has(token))
      .filter((token) => !token.startsWith("ref"))
      .filter((token) => !targetedHotDomainStopTokens.has(token))
      .filter((token) => !isLikelyObfuscatedAliasToken(token))
      .slice(0, 2);
    const topicalFallbackToken =
      splitNameTokens(topic).find((token) => token.length >= 3 && !GENERIC_SEGMENTS.has(token)) ??
      fallbackTopicByArchetype(plan.archetype);
    const stemPrimary = stemTokens[0] ?? topicalFallbackToken;
    const stemSecondary = stemTokens[1] ? toPascalCase(stemTokens[1]) : "";
    const looksImportStyleAlias = kind === "import" || targetedHotImportAliasPattern.test(currentName);
    const suffix = looksImportStyleAlias ? "Dep" : "Local";
    const shortTag = alphabeticStableSuffix(`${chunkId}:${originalName}:${kind}`, 2).toUpperCase();
    const candidate = compactIdentifier(
      normalizeTargetedAliasBase(
        sanitizeIdentifier(`${plan.archetype}${toPascalCase(stemPrimary)}${stemSecondary}${suffix}${shortTag}`),
      ),
      34,
    );
    const hasForcedNoise = /(?:EventFlowNode|EventFlow|Abnormal(?:Exit)?|NneTne)/i.test(candidate);
    if (!hasForcedNoise && !isNoisyIdentifier(candidate) && !OBFUSCATED_ALIAS_STYLE_PATTERN.test(candidate)) {
      return candidate;
    }
    const strictDomainTokens = dedupeNameTokens([
      ...planDomainPriorityTokens,
      ...planAliasDomainTokens,
      ...chunkTokens,
      ...topicTokens,
    ])
      .filter((token) => token.length >= 3)
      .filter((token) => !targetedHotWeakTokenSet.has(token))
      .filter((token) => !targetedHotDomainStopTokens.has(token))
      .filter((token) => !isLikelyObfuscatedAliasToken(token))
      .filter((token) => !/(?:eventflow|abnormal|nnetne|ane)/i.test(token))
      .slice(0, 2);
    const strictPrimary = strictDomainTokens[0] ?? fallbackTopicByArchetype(plan.archetype);
    const strictSecondary = strictDomainTokens[1] ? toPascalCase(strictDomainTokens[1]) : "";
    const strictCandidate = compactIdentifier(
      normalizeTargetedAliasBase(
        sanitizeIdentifier(`${plan.archetype}${toPascalCase(strictPrimary)}${strictSecondary}${suffix}${shortTag}`),
      ),
      34,
    );
    if (
      strictCandidate.length > 0 &&
      !/(?:EventFlowNode|EventFlow|Abnormal(?:Exit)?|NneTne)/i.test(strictCandidate) &&
      !isNoisyIdentifier(strictCandidate) &&
      !OBFUSCATED_ALIAS_STYLE_PATTERN.test(strictCandidate)
    ) {
      return strictCandidate;
    }
    return compactIdentifier(
      normalizeTargetedAliasBase(
        sanitizeIdentifier(
          `${plan.archetype}${toPascalCase(fallbackTopicByArchetype(plan.archetype))}${suffix}${shortTag}`,
        ),
      ),
      30,
    );
  };
  const buildTargetedHotImportAliasBase = (
    currentName: string,
    originalName: string,
    chunkId: string,
    modulePath: string,
    importedName: string,
  ): string => {
    if (!targetedHotLocalRenameEnabled) {
      return currentName;
    }
    const moduleTokens = sanitizeImportAliasTokens(splitNameTokens(path.basename(modulePath))).filter(
      (token) => !targetedHotDomainStopTokens.has(token),
    );
    const chunkTokens = sanitizeImportAliasTokens(chunkTopicTokensById.get(chunkId) ?? chunkTokensFromChunkId(chunkId)).filter(
      (token) => !targetedHotDomainStopTokens.has(token),
    );
    const originalTokens = sanitizeImportAliasTokens(splitNameTokens(originalName)).filter(
      (token) => !targetedHotDomainStopTokens.has(token),
    );
    const currentTokens = sanitizeImportAliasTokens(splitNameTokens(currentName)).filter(
      (token) => !targetedHotDomainStopTokens.has(token),
    );
    const importedTokens = sanitizeImportAliasTokens(splitNameTokens(importedName)).filter(
      (token) => !targetedHotDomainStopTokens.has(token),
    );
    const semanticTokens = dedupeNameTokens([
      ...planDomainPriorityTokens,
      ...moduleTokens,
      ...chunkTokens,
      ...originalTokens,
      ...currentTokens,
      ...importedTokens,
    ])
      .filter((token) => !isLikelyObfuscatedAliasToken(token))
      .slice(0, 2);
    const stemPrimary = semanticTokens[0] ?? pickPlanDomainToken(`${chunkId}:${originalName}:${importedName}`);
    const stemSecondary = semanticTokens[1] ? toPascalCase(semanticTokens[1]) : "";
    const shortTag = alphabeticStableSuffix(`${chunkId}:${modulePath}:${importedName}`, 2).toUpperCase();
    const prefix = plan.archetype === "service" ? "svc" : "store";
    const candidate = compactIdentifier(
      normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${toPascalCase(stemPrimary)}${stemSecondary}Dep${shortTag}`)),
      32,
    );
    if (!isNoisyIdentifier(candidate) && !OBFUSCATED_ALIAS_STYLE_PATTERN.test(candidate)) {
      return candidate;
    }
    return compactIdentifier(
      normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${toPascalCase(pickPlanDomainToken(chunkId))}Dep${shortTag}`)),
      28,
    );
  };
  const resolveTargetedImportFamilyToken = (modulePath: string): string => {
    const normalized = modulePath.replace(/\\/g, "/").toLowerCase();
    if (normalized.includes("/chunk-index-") || normalized.includes("/chunk-chunk-")) {
      return "core";
    }
    if (normalized.includes("/chunk-channel-")) {
      return "channel";
    }
    if (
      normalized.includes("diagram") ||
      normalized.includes("treemap") ||
      normalized.includes("cytoscape") ||
      normalized.includes("architecture")
    ) {
      return "diagram";
    }
    if (
      normalized.includes("angular") ||
      normalized.includes("html") ||
      normalized.includes("css") ||
      normalized.includes("scss") ||
      normalized.includes("tsx") ||
      normalized.includes("typescript") ||
      normalized.includes("javascript") ||
      normalized.includes("json") ||
      normalized.includes("python") ||
      normalized.includes("sql") ||
      normalized.includes("xml") ||
      normalized.includes("postcss")
    ) {
      return "language";
    }
    if (normalized.includes("clone") || normalized.includes("baseuniq") || normalized.includes("basepick")) {
      return "runtime";
    }
    const signalFamily =
      planDomainPriorityTokens.find((token) => !targetedHotDomainStopTokens.has(token)) ??
      planAliasDomainTokens.find((token) => !targetedHotDomainStopTokens.has(token));
    if (signalFamily) {
      return signalFamily;
    }
    return fallbackTopicByArchetype(plan.archetype);
  };
  const buildTargetedImportFamilyAliasBase = (
    currentName: string,
    modulePath: string,
    importedName: string,
  ): string => {
    if (!targetedHotLocalRenameEnabled) {
      return currentName;
    }
    const shouldRewrite =
      /^(?:store|svc).+Dep/i.test(currentName) ||
      /(?:EventRef|NavigatePageDep|DepDep|DepDefault)/i.test(currentName);
    if (!shouldRewrite) {
      return currentName;
    }
    const familyToken = resolveTargetedImportFamilyToken(modulePath);
    const importedTokenTag = buildStableAliasTag(importedName, "dep");
    const prefix = plan.archetype === "service" ? "svc" : "store";
    const candidate = compactIdentifier(
      normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${toPascalCase(familyToken)}Dep${importedTokenTag}`)),
      30,
    );
    if (!isNoisyIdentifier(candidate) && !OBFUSCATED_ALIAS_STYLE_PATTERN.test(candidate)) {
      return candidate;
    }
    return compactIdentifier(normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${toPascalCase(familyToken)}Dep`)), 24);
  };

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

  interface RenameScopeFrame {
    node: ts.Node;
    declarations: Set<string>;
    parent?: RenameScopeFrame;
  }

  interface LiftedChunkMetadata {
    sourceFile: ts.SourceFile;
    importBindings: Map<string, ChunkImportBinding>;
    statementByDeclaredName: Map<string, ts.Statement>;
    exportLocalByExportedName: Map<string, string>;
  }

  const liftedChunkMetadataById = new Map<string, LiftedChunkMetadata>();

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

  const statementHasModifier = (statement: ts.Statement, kind: ts.SyntaxKind): boolean => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers) {
      return false;
    }
    for (const modifier of modifiers) {
      if (modifier.kind === kind) {
        return true;
      }
    }
    return false;
  };

  const collectExportLocalByExportedName = (sourceFile: ts.SourceFile): Map<string, string> => {
    const exportLocalByExportedName = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (statementHasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        const declaredNames = collectStatementDeclaredNames(statement);
        for (const declaredName of declaredNames) {
          if (!exportLocalByExportedName.has(declaredName)) {
            exportLocalByExportedName.set(declaredName, declaredName);
          }
        }
      }
      if (!ts.isExportDeclaration(statement)) {
        continue;
      }
      if (!statement.exportClause || statement.moduleSpecifier) {
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) {
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        const localName = element.propertyName ? element.propertyName.text : element.name.text;
        if (!exportLocalByExportedName.has(exportedName)) {
          exportLocalByExportedName.set(exportedName, localName);
        }
      }
    }
    return exportLocalByExportedName;
  };

  const resolveLiftedChunkMetadata = (chunkId: string): LiftedChunkMetadata => {
    const existing = liftedChunkMetadataById.get(chunkId);
    if (existing) {
      return existing;
    }
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
    const metadata: LiftedChunkMetadata = {
      sourceFile,
      importBindings,
      statementByDeclaredName,
      exportLocalByExportedName: collectExportLocalByExportedName(sourceFile),
    };
    liftedChunkMetadataById.set(chunkId, metadata);
    return metadata;
  };

  const isBootstrapPayloadChunk = (metadata: LiftedChunkMetadata): boolean => {
    let hasBootstrapSignals = false;
    let staticLiteralDeclarationCount = 0;
    let variableDeclarationCount = 0;
    let importFanoutCount = 0;
    const heuristicPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

    for (const statement of metadata.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!declaration.initializer) {
            continue;
          }
          variableDeclarationCount += 1;
          if (isStaticLiteralExpression(declaration.initializer)) {
            staticLiteralDeclarationCount += 1;
          }
        }
      }
      const rendered = heuristicPrinter.printNode(ts.EmitHint.Unspecified, statement, metadata.sourceFile);
      if (rendered.includes("__vite__mapDeps") || rendered.includes("modulepreload")) {
        hasBootstrapSignals = true;
      }
      if (rendered.includes("__vite__mapDeps")) {
        importFanoutCount += rendered.split('"./').length - 1;
      }
    }

    if (!hasBootstrapSignals) {
      return false;
    }
    const staticRatio = variableDeclarationCount > 0 ? staticLiteralDeclarationCount / variableDeclarationCount : 0;
    return (
      staticLiteralDeclarationCount >= BOOTSTRAP_PAYLOAD_STATIC_DECLARATION_MIN ||
      staticRatio >= BOOTSTRAP_PAYLOAD_STATIC_RATIO_MIN ||
      importFanoutCount >= BOOTSTRAP_PAYLOAD_IMPORT_FANOUT_MIN
    );
  };

  const isStaticPayloadOnlyChunk = (metadata: LiftedChunkMetadata): boolean => {
    let variableDeclarationCount = 0;
    let staticVariableDeclarationCount = 0;
    let functionOrClassCount = 0;

    for (const statement of metadata.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        functionOrClassCount += 1;
        continue;
      }
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          continue;
        }
        variableDeclarationCount += 1;
        if (isStaticLiteralExpression(declaration.initializer)) {
          staticVariableDeclarationCount += 1;
        }
      }
    }

    if (functionOrClassCount > STATIC_PAYLOAD_ONLY_MAX_FUNCTION_CLASS_COUNT) {
      return false;
    }
    if (variableDeclarationCount < STATIC_PAYLOAD_ONLY_VAR_DECLARATION_MIN) {
      return false;
    }
    const staticRatio = staticVariableDeclarationCount / Math.max(1, variableDeclarationCount);
    return staticRatio >= STATIC_PAYLOAD_ONLY_RATIO_MIN;
  };

  const chunkIdFromChunkModulePath = (modulePath: string): string => {
    const base = path.basename(modulePath).replace(/\.[cm]?[jt]sx?$/i, "");
    if (base.length < 1) {
      throw new Error(`buildQualityModuleContent: malformed chunk module path ${modulePath}`);
    }
    return base;
  };

  const isChunkIndexModulePath = (modulePath: string): boolean => {
    const chunkId = chunkIdFromChunkModulePath(modulePath);
    return chunkId.startsWith("chunk-index-");
  };

  const applyTopLevelDeclarationRenames = (statements: ts.Statement[], renameMap: Map<string, string>): ts.Statement[] => {
    if (renameMap.size === 0) {
      return statements;
    }
    const renamed: ts.Statement[] = [];
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const replacement = renameMap.get(statement.name.text);
        if (replacement) {
          renamed.push(
            ts.factory.updateFunctionDeclaration(
              statement,
              statement.modifiers,
              statement.asteriskToken,
              ts.factory.createIdentifier(replacement),
              statement.typeParameters,
              statement.parameters,
              statement.type,
              statement.body,
            ),
          );
          continue;
        }
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        const replacement = renameMap.get(statement.name.text);
        if (replacement) {
          renamed.push(
            ts.factory.updateClassDeclaration(
              statement,
              statement.modifiers,
              ts.factory.createIdentifier(replacement),
              statement.typeParameters,
              statement.heritageClauses,
              statement.members,
            ),
          );
          continue;
        }
      }
      if (ts.isVariableStatement(statement)) {
        let changed = false;
        const nextDeclarations = statement.declarationList.declarations.map((declaration) => {
          if (!ts.isIdentifier(declaration.name)) {
            return declaration;
          }
          const replacement = renameMap.get(declaration.name.text);
          if (!replacement) {
            return declaration;
          }
          changed = true;
          return ts.factory.updateVariableDeclaration(
            declaration,
            ts.factory.createIdentifier(replacement),
            declaration.exclamationToken,
            declaration.type,
            declaration.initializer,
          );
        });
        if (changed) {
          renamed.push(
            ts.factory.updateVariableStatement(
              statement,
              statement.modifiers,
              ts.factory.updateVariableDeclarationList(statement.declarationList, nextDeclarations),
            ),
          );
          continue;
        }
      }
      renamed.push(statement);
    }
    return renamed;
  };

  const collectDirectDeclarations = (scopeNode: ts.Node): Set<string> => {
    const declarations = new Set<string>();

    if (ts.isSourceFile(scopeNode)) {
      for (const statement of scopeNode.statements) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
          declarations.add(statement.name.text);
          continue;
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            collectBindingNames(declaration.name, declarations);
          }
        }
      }
      return declarations;
    }

    if (ts.isFunctionLike(scopeNode)) {
      if ((ts.isFunctionDeclaration(scopeNode) || ts.isFunctionExpression(scopeNode)) && scopeNode.name) {
        declarations.add(scopeNode.name.text);
      }
      for (const parameter of scopeNode.parameters) {
        collectBindingNames(parameter.name, declarations);
      }
      return declarations;
    }

    if (ts.isCatchClause(scopeNode)) {
      if (scopeNode.variableDeclaration) {
        collectBindingNames(scopeNode.variableDeclaration.name, declarations);
      }
      return declarations;
    }

    if (ts.isBlock(scopeNode)) {
      for (const statement of scopeNode.statements) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
          declarations.add(statement.name.text);
          continue;
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            collectBindingNames(declaration.name, declarations);
          }
        }
      }
    }

    return declarations;
  };

  const isScopeNode = (node: ts.Node): boolean => {
    if (ts.isSourceFile(node)) {
      return true;
    }
    if (ts.isBlock(node)) {
      return true;
    }
    if (ts.isFunctionLike(node)) {
      return true;
    }
    if (ts.isCatchClause(node)) {
      return true;
    }
    return false;
  };

  const identifierCanBeRenamed = (name: string, scope: RenameScopeFrame | undefined): boolean => {
    let cursor = scope;
    while (cursor) {
      if (cursor.declarations.has(name)) {
        if (ts.isSourceFile(cursor.node)) {
          cursor = cursor.parent;
          continue;
        }
        return false;
      }
      cursor = cursor.parent;
    }
    return true;
  };

  const applyScopedReferenceRenames = (statements: ts.Statement[], renameMap: Map<string, string>): ts.Statement[] => {
    if (renameMap.size === 0) {
      return statements;
    }
    const syntheticFile = ts.factory.createSourceFile(
      statements,
      ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
      ts.NodeFlags.None,
    );
    const transformerFactory: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit = (node: ts.Node, scope: RenameScopeFrame | undefined): ts.VisitResult<ts.Node> => {
        const nextScope = isScopeNode(node)
          ? {
              node,
              declarations: collectDirectDeclarations(node),
              parent: scope,
            }
          : scope;

        if (ts.isIdentifier(node) && isIdentifierReference(node)) {
          const replacement = renameMap.get(node.text);
          if (replacement && identifierCanBeRenamed(node.text, nextScope)) {
            return ts.factory.createIdentifier(replacement);
          }
        }

        return ts.visitEachChild(
          node,
          (child) => visit(child, nextScope),
          context,
        );
      };

      return (sourceFile) => ts.visitNode(sourceFile, (node) => visit(node, undefined)) as ts.SourceFile;
    };

    const result = ts.transform(syntheticFile, [transformerFactory]);
    const transformed = result.transformed[0];
    if (!transformed) {
      result.dispose();
      throw new Error("buildQualityModuleContent: missing transformed source");
    }
    const nextStatements = [...transformed.statements];
    result.dispose();
    return nextStatements;
  };

  const applyScopedIdentifierRenames = (statements: ts.Statement[], renameMap: Map<string, string>): ts.Statement[] => {
    if (renameMap.size === 0) {
      return statements;
    }
    const declarationsRenamed = applyTopLevelDeclarationRenames(statements, renameMap);
    return applyScopedReferenceRenames(declarationsRenamed, renameMap);
  };

  const isDeclarationIdentifierName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (!parent) {
      return false;
    }
    if (
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionExpression(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isClassExpression(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.name === node)
    ) {
      return true;
    }
    if (ts.isCatchClause(parent) && parent.variableDeclaration && parent.variableDeclaration.name === node) {
      return true;
    }
    return false;
  };
  const isTopLevelDeclarationIdentifier = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (!parent) {
      return false;
    }
    if (ts.isVariableDeclaration(parent) && parent.name === node) {
      const variableDeclarationList = parent.parent;
      const variableStatement = variableDeclarationList ? variableDeclarationList.parent : undefined;
      return Boolean(variableStatement && ts.isVariableStatement(variableStatement) && ts.isSourceFile(variableStatement.parent));
    }
    if (
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node)
    ) {
      return Boolean(parent.parent && ts.isSourceFile(parent.parent));
    }
    return false;
  };

  const isHotLocalReference = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      return true;
    }
    return isIdentifierReference(node);
  };

  const collectDeclaredNamesDeep = (statements: ts.Statement[]): Set<string> => {
    const declared = new Set<string>();
    const syntheticFile = ts.factory.createSourceFile(
      statements,
      ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
      ts.NodeFlags.None,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isDeclarationIdentifierName(node)) {
        declared.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(syntheticFile, visit);
    return declared;
  };

  const applyTargetedHotLocalIdentifierPass = (
    statements: ts.Statement[],
  ): { statements: ts.Statement[]; renameMap: Map<string, string> } => {
    if (!targetedHotLocalRenameEnabled || statements.length < 1) {
      return {
        statements,
        renameMap: new Map<string, string>(),
      };
    }
    const syntheticFile = ts.factory.createSourceFile(
      statements,
      ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
      ts.NodeFlags.None,
    );
    const candidates = new Set<string>();
    const collectCandidates = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isDeclarationIdentifierName(node)) {
        const shortObfuscatedTopLevelCandidate =
          isTopLevelDeclarationIdentifier(node) &&
          node.text.length <= 4 &&
          !targetedHotSemanticAllowTokens.has(node.text.toLowerCase()) &&
          isLikelyObfuscatedAliasToken(node.text);
        const qeAliasTopLevelCandidate = isTopLevelDeclarationIdentifier(node) && targetedHotQeAliasPattern.test(node.text);
        if (
          ((node.text.length >= 8 && targetedHotLocalNoiseIdentifierPattern.test(node.text)) ||
            shortObfuscatedTopLevelCandidate ||
            qeAliasTopLevelCandidate) &&
          !RESERVED_IDENTIFIERS.has(node.text)
        ) {
          candidates.add(node.text);
        }
      }
      ts.forEachChild(node, collectCandidates);
    };
    ts.forEachChild(syntheticFile, collectCandidates);
    if (candidates.size < 1) {
      return {
        statements,
        renameMap: new Map<string, string>(),
      };
    }
    const usedNames = collectDeclaredNamesDeep(statements);
    const renameMap = new Map<string, string>();
    for (const candidate of [...candidates].sort((left, right) => left.localeCompare(right))) {
      const base = buildTargetedHotLocalAliasBase(candidate, candidate, "targeted-hot-local", "local");
      const resolved = nextUniqueIdentifier(compactIdentifier(base, 34), usedNames);
      if (resolved === candidate) {
        continue;
      }
      renameMap.set(candidate, resolved);
    }
    if (renameMap.size < 1) {
      return {
        statements,
        renameMap,
      };
    }
    const transformerFactory: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
        if (ts.isIdentifier(node)) {
          const replacement = renameMap.get(node.text);
          if (replacement && (isDeclarationIdentifierName(node) || isHotLocalReference(node))) {
            return ts.factory.createIdentifier(replacement);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
    const result = ts.transform(syntheticFile, [transformerFactory]);
    const transformed = result.transformed[0];
    if (!transformed) {
      result.dispose();
      throw new Error("buildQualityModuleContent: missing transformed source in targeted hot local pass");
    }
    const nextStatements = [...transformed.statements];
    result.dispose();
    return {
      statements: nextStatements,
      renameMap,
    };
  };

  const applyTargetedHotFinalContentPass = (content: string): string => {
    if (!targetedHotLocalRenameEnabled || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const declarationCandidates = new Set<string>();
    const declaredNames = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isDeclarationIdentifierName(node)) {
        declaredNames.add(node.text);
        const shortObfuscatedTopLevelCandidate =
          isTopLevelDeclarationIdentifier(node) &&
          node.text.length <= 4 &&
          !targetedHotSemanticAllowTokens.has(node.text.toLowerCase()) &&
          isLikelyObfuscatedAliasToken(node.text);
        const qeAliasTopLevelCandidate = isTopLevelDeclarationIdentifier(node) && targetedHotQeAliasPattern.test(node.text);
        if (
          ((node.text.length >= 8 && targetedHotLocalNoiseIdentifierPattern.test(node.text)) ||
            shortObfuscatedTopLevelCandidate ||
            qeAliasTopLevelCandidate) &&
          !RESERVED_IDENTIFIERS.has(node.text)
        ) {
          declarationCandidates.add(node.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(sourceFile, collect);
    if (declarationCandidates.size < 1) {
      return content;
    }
    const renameMap = new Map<string, string>();
    for (const candidate of [...declarationCandidates].sort((left, right) => left.localeCompare(right))) {
      const base = buildTargetedHotLocalAliasBase(candidate, candidate, "targeted-hot-content", "local");
      const resolved = nextUniqueIdentifier(compactIdentifier(base, 34), declaredNames);
      if (resolved === candidate) {
        continue;
      }
      renameMap.set(candidate, resolved);
    }
    if (renameMap.size < 1) {
      return content;
    }
    const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let rewritten = content;
    for (const [from, to] of [...renameMap.entries()].sort((left, right) => right[0].length - left[0].length)) {
      rewritten = rewritten.replace(new RegExp(`\\b${escaped(from)}\\b`, "g"), to);
    }
    return rewritten;
  };
  const applyTargetedHotResidualLocalNoiseSweep = (content: string): string => {
    if (!targetedHotLocalRenameEnabled || content.length < 1) {
      return content;
    }
    const residualPattern = /\b(?:store|service)(?:Iae[A-Za-z]{2,}|(?:[A-Z][a-z]{2}){2,})Local[A-Za-z0-9]{2,}\b/g;
    const residualMatches = content.match(residualPattern) ?? [];
    if (residualMatches.length < 1) {
      return content;
    }
    const residualCandidates = [...new Set(residualMatches)].sort((left, right) => left.localeCompare(right));
    const usedNames = new Set<string>(content.match(/\b[$A-Za-z_][$A-Za-z0-9_]*\b/g) ?? []);
    const renameMap = new Map<string, string>();
    for (const candidate of residualCandidates) {
      const base = buildTargetedHotLocalAliasBase(candidate, candidate, "targeted-hot-residual", "local");
      const resolved = nextUniqueIdentifier(compactIdentifier(base, 34), usedNames);
      if (resolved === candidate) {
        continue;
      }
      renameMap.set(candidate, resolved);
    }
    if (renameMap.size < 1) {
      return content;
    }
    const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let rewritten = content;
    for (const [from, to] of [...renameMap.entries()].sort((left, right) => right[0].length - left[0].length)) {
      rewritten = rewritten.replace(new RegExp(`\\b${escaped(from)}\\b`, "g"), to);
    }
    return rewritten;
  };
  const inferTargetedHotDomainLocalToken = (
    statementText: string,
    referencedNames: ReadonlySet<string>,
    family: TargetedCoreFamily,
  ): string => {
    const normalizedText = `${statementText}\n${[...referencedNames].join(" ")}`.toLowerCase();
    const scoreByToken = new Map<string, number>();
    const add = (token: string, signal: string, weight = 1): void => {
      if (!normalizedText.includes(signal)) {
        return;
      }
      scoreByToken.set(token, (scoreByToken.get(token) ?? 0) + weight);
    };

    add("workspace", "workspace", 2);
    add("workspace", "project", 1);
    add("workspace", "repo", 1);
    add("workspace", "worktree", 2);

    add("session", "session", 2);
    add("session", "conversation", 2);
    add("session", "thread", 1);
    add("session", "chat", 1);

    add("navigation", "route", 2);
    add("navigation", "router", 2);
    add("navigation", "navigate", 3);
    add("navigation", "location", 1);
    add("navigation", "path", 1);

    add("state", "store", 2);
    add("state", "state", 2);
    add("state", "dispatch", 2);
    add("state", "reducer", 2);
    add("state", "atom", 2);
    add("state", "selector", 1);

    add("transport", "ipc", 3);
    add("transport", "rpc", 3);
    add("transport", "channel", 2);
    add("transport", "request", 2);
    add("transport", "response", 2);
    add("transport", "event", 1);
    add("transport", "message", 1);

    add("runtime", "promise", 2);
    add("runtime", "prototype", 2);
    add("runtime", "symbol", 2);
    add("runtime", "globalthis", 2);

    add("parser", "parse", 3);
    add("parser", "parser", 2);
    add("parser", "token", 1);
    add("parser", "grammar", 2);
    add("parser", "schema", 2);
    add("parser", "json", 1);
    add("parser", "ast", 2);

    add("config", "config", 2);
    add("config", "setting", 2);
    add("config", "preference", 2);
    add("config", "option", 1);
    add("config", "flag", 1);

    add("filesystem", "file", 2);
    add("filesystem", "fs", 1);
    add("filesystem", "read", 1);
    add("filesystem", "write", 1);
    add("filesystem", "directory", 2);

    add("diagram", "diagram", 3);
    add("diagram", "cytoscape", 3);
    add("diagram", "treemap", 3);
    add("diagram", "layout", 1);

    add("language", "language", 2);
    add("language", "typescript", 2);
    add("language", "javascript", 2);
    add("language", "monaco", 2);
    add("language", "theme", 2);

    add("render", "render", 2);
    add("render", "component", 1);
    add("render", "view", 1);
    add("render", "jsx", 2);

    const familyFallback = (() => {
      if (family === "State") {
        return "state";
      }
      if (family === "Runtime") {
        return "runtime";
      }
      if (family === "Language") {
        return "language";
      }
      if (family === "Diagram") {
        return "diagram";
      }
      if (family === "React") {
        return "render";
      }
      if (family === "Preload") {
        return "transport";
      }
      return fallbackTopicByArchetype(plan.archetype);
    })();

    let bestToken = "";
    let bestScore = 0;
    for (const [token, score] of scoreByToken.entries()) {
      if (score > bestScore) {
        bestScore = score;
        bestToken = token;
      }
    }
    if (bestToken.length > 0 && bestScore >= 2) {
      return bestToken;
    }
    const planToken = planDomainPriorityTokens.find((token) => !targetedHotDomainStopTokens.has(token));
    if (planToken) {
      return planToken;
    }
    return familyFallback;
  };
  const inferBehaviorRoleToken = (
    statementText: string,
    referencedNames: ReadonlySet<string>,
  ): "Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle" => {
    const normalizedText = `${statementText}\n${[...referencedNames].join(" ")}`.toLowerCase();
    const scoreByRole = new Map<"Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle", number>();
    const add = (
      role: "Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle",
      signal: string,
      weight = 1,
    ): void => {
      if (!normalizedText.includes(signal)) {
        return;
      }
      scoreByRole.set(role, (scoreByRole.get(role) ?? 0) + weight);
    };

    add("Parse", "parse", 3);
    add("Parse", "decode", 2);
    add("Parse", "schema", 2);
    add("Parse", "json", 1);
    add("Parse", "token", 1);

    add("Select", "get", 1);
    add("Select", "select", 2);
    add("Select", "query", 2);
    add("Select", "read", 1);
    add("Select", "find", 1);

    add("Mutate", "set", 1);
    add("Mutate", "update", 2);
    add("Mutate", "write", 2);
    add("Mutate", "save", 2);
    add("Mutate", "assign", 2);
    add("Mutate", "dispatch", 2);
    add("Mutate", "reducer", 2);

    add("Emit", "emit", 3);
    add("Emit", "publish", 2);
    add("Emit", "event", 2);
    add("Emit", "notify", 2);
    add("Emit", "channel", 1);

    add("Adapt", "ipc", 2);
    add("Adapt", "rpc", 2);
    add("Adapt", "transport", 2);
    add("Adapt", "adapter", 2);
    add("Adapt", "bridge", 2);
    add("Adapt", "request", 1);
    add("Adapt", "response", 1);

    add("Orchestrate", "await", 2);
    add("Orchestrate", "promise", 1);
    add("Orchestrate", "flow", 2);
    add("Orchestrate", "route", 1);
    add("Orchestrate", "navigate", 1);
    add("Orchestrate", "queue", 1);

    const callMatches = normalizedText.match(/\b[a-z_$][a-z0-9_$]*\s*\(/g);
    if (callMatches && callMatches.length >= 4) {
      scoreByRole.set("Orchestrate", (scoreByRole.get("Orchestrate") ?? 0) + 2);
    }

    let bestRole: "Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle" = "Handle";
    let bestScore = 0;
    for (const role of ["Mutate", "Emit", "Adapt", "Parse", "Select", "Orchestrate", "Handle"] as const) {
      const score = scoreByRole.get(role) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }
    return bestScore >= 2 ? bestRole : "Handle";
  };
  const inferIoSignatureToken = (
    statementText: string,
    referencedNames: ReadonlySet<string>,
  ): "Request" | "Payload" | "Result" | "Stateful" | "None" => {
    const normalizedText = `${statementText}\n${[...referencedNames].join(" ")}`.toLowerCase();
    if (
      normalizedText.includes("request") ||
      normalizedText.includes("response") ||
      normalizedText.includes("endpoint") ||
      normalizedText.includes("url")
    ) {
      return "Request";
    }
    if (
      normalizedText.includes("payload") ||
      normalizedText.includes("body") ||
      normalizedText.includes("params") ||
      normalizedText.includes("options")
    ) {
      return "Payload";
    }
    if (
      normalizedText.includes("return") ||
      normalizedText.includes("result") ||
      normalizedText.includes("resolve")
    ) {
      return "Result";
    }
    if (
      normalizedText.includes("state") ||
      normalizedText.includes("store") ||
      normalizedText.includes("cache") ||
      normalizedText.includes("dispatch")
    ) {
      return "Stateful";
    }
    return "None";
  };
  const applyTargetedHotLocalDomainRenamePass = (content: string): string => {
    if (!targetedHotLocalRenameEnabled || !fullLiftFocusedStoreServiceModule || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const familyLocalPattern = /^(store|service)(Runtime|State|React|Preload|Language|Diagram)Local([A-Za-z0-9]{2,})$/;
    const stackedFamilyLocalPattern =
      /^(store|service)(Runtime|State|React|Preload|Language|Diagram)(Runtime|State|React|Preload|Language|Diagram)Local([A-Za-z0-9]{2,})$/;
    const legacyLocalPattern = /^(store|service)([A-Z][A-Za-z0-9]{3,})Local([A-Za-z0-9]{2,})$/;
    const resolveStackedFamily = (statementText: string, firstFamily: string, secondFamily: string): TargetedCoreFamily => {
      const inferredFamily = inferTargetedCoreLocalFamily(statementText);
      if (inferredFamily !== "Core") {
        return inferredFamily;
      }
      if (firstFamily === "React" || secondFamily === "React") {
        return "React";
      }
      if (secondFamily === "Runtime" || firstFamily === "Runtime") {
        return "Runtime";
      }
      return (secondFamily as TargetedCoreFamily) ?? "Runtime";
    };
    interface TargetedDomainLocalEntry {
      originalName: string;
      prefix: "store" | "service";
      family: TargetedCoreFamily;
      suffix: string;
      statementText: string;
      referencedNames: Set<string>;
    }
    const entries: TargetedDomainLocalEntry[] = [];
    for (const statement of sourceFile.statements) {
      const declaredNames = collectStatementDeclaredNames(statement);
      if (declaredNames.size < 1) {
        continue;
      }
      const statementText = statement.getText(sourceFile);
      const referencedNames = collectStatementReferencedNames(statement);
      for (const declaredName of declaredNames) {
        const stackedMatch = declaredName.match(stackedFamilyLocalPattern);
        if (stackedMatch) {
          const prefix = stackedMatch[1];
          const firstFamily = stackedMatch[2];
          const secondFamily = stackedMatch[3];
          const suffix = stackedMatch[4];
          if (!prefix || !firstFamily || !secondFamily || !suffix) {
            continue;
          }
          const normalizedSuffix = suffix.toLowerCase();
          const shouldRewrite =
            targetedHotStoreG003Module ||
            suffix.length <= 8 ||
            /^[A-Z0-9]{2,10}$/.test(suffix) ||
            /^[A-Za-z]{2,6}$/.test(suffix) ||
            isLikelyObfuscatedAliasToken(normalizedSuffix);
          if (!shouldRewrite) {
            continue;
          }
          entries.push({
            originalName: declaredName,
            prefix: prefix === "service" ? "service" : "store",
            family: resolveStackedFamily(statementText, firstFamily, secondFamily),
            suffix,
            statementText,
            referencedNames,
          });
          continue;
        }
        const match = declaredName.match(familyLocalPattern);
        if (match) {
          const prefix = match[1];
          const family = match[2];
          const suffix = match[3];
          if (!prefix || !family || !suffix) {
            continue;
          }
          const normalizedSuffix = suffix.toLowerCase();
          const shouldRewrite =
            suffix.length <= 4 ||
            /^[A-Z0-9]{2,6}$/.test(suffix) ||
            /^[A-Za-z]{2,4}$/.test(suffix) ||
            isLikelyObfuscatedAliasToken(normalizedSuffix);
          if (!shouldRewrite) {
            continue;
          }
          entries.push({
            originalName: declaredName,
            prefix: prefix === "service" ? "service" : "store",
            family: family as TargetedCoreFamily,
            suffix,
            statementText,
            referencedNames,
          });
          continue;
        }
        const legacyMatch = declaredName.match(legacyLocalPattern);
        if (!legacyMatch) {
          continue;
        }
        const prefix = legacyMatch[1];
        const middle = legacyMatch[2];
        const suffix = legacyMatch[3];
        if (!prefix || !middle || !suffix) {
          continue;
        }
        const middleTokens = sanitizeAliasTokens(splitNameTokens(middle));
        const weakMiddle =
          middleTokens.length < 1 ||
          middleTokens.every(
            (token) =>
              targetedHotWeakTokenSet.has(token) ||
              isLikelyObfuscatedAliasToken(token) ||
              /^(?:node|dep|chunk|index|baseuniq|basepick|angular|hee)$/.test(token),
          );
        const noisyMiddle = /(?:hee|node|dep|chunk|index|baseuniq|basepick|angular|abcdefghijklmnopqrstuvwxyz)/i.test(middle);
        const shouldRewriteLegacy =
          noisyMiddle ||
          weakMiddle ||
          suffix.length <= 4 ||
          /^[A-Z0-9]{2,6}$/.test(suffix) ||
          (targetedHotStoreG003Module && suffix.length <= 10) ||
          isLikelyObfuscatedAliasToken(suffix.toLowerCase());
        if (!shouldRewriteLegacy) {
          continue;
        }
        const inferredFamily = inferTargetedCoreLocalFamily(statementText);
        entries.push({
          originalName: declaredName,
          prefix: prefix === "service" ? "service" : "store",
          family: inferredFamily === "Core" ? "Runtime" : inferredFamily,
          suffix,
          statementText,
          referencedNames,
        });
      }
    }
    if (entries.length < 1) {
      return content;
    }
    const usedNames = new Set<string>(content.match(/\b[$A-Za-z_][$A-Za-z0-9_]*\b/g) ?? []);
    const renameMap = new Map<string, string>();
    for (const entry of entries.sort((left, right) => left.originalName.localeCompare(right.originalName))) {
      let domainToken = inferTargetedHotDomainLocalToken(entry.statementText, entry.referencedNames, entry.family);
      if (entry.family === "React" && (domainToken === "state" || domainToken === "react")) {
        domainToken = "view";
      } else if (entry.family === "Runtime" && (domainToken === "state" || domainToken === "runtime")) {
        domainToken = "core";
      }
      const behaviorRole = inferBehaviorRoleToken(entry.statementText, entry.referencedNames);
      const ioSignature = inferIoSignatureToken(entry.statementText, entry.referencedNames);
      const familyToken = entry.family.toLowerCase();
      const domainStem = domainToken.toLowerCase() === familyToken ? "" : toPascalCase(domainToken);
      const ioStem = ioSignature === "None" ? "" : ioSignature;
      const shortTag = alphabeticStableSuffix(`${plan.moduleId}:${entry.originalName}:${domainToken}`, 2).toUpperCase();
      const candidate = normalizeTargetedAliasBase(
        sanitizeIdentifier(`${entry.prefix}${entry.family}${behaviorRole}${domainStem}${ioStem}Local${shortTag}`),
      );
      const resolved = nextUniqueIdentifier(compactIdentifier(candidate, 40), usedNames);
      if (resolved === entry.originalName) {
        continue;
      }
      renameMap.set(entry.originalName, resolved);
    }
    if (renameMap.size < 1) {
      return content;
    }
    const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let rewritten = content;
    for (const [from, to] of [...renameMap.entries()].sort((left, right) => right[0].length - left[0].length)) {
      rewritten = rewritten.replace(new RegExp(`\\b${escaped(from)}\\b`, "g"), to);
    }
    return rewritten;
  };
  type TargetedCoreFamily = "Core" | "Preload" | "React" | "Runtime" | "State" | "Language" | "Diagram";
  const TARGETED_CORE_FAMILY_ORDER: TargetedCoreFamily[] = [
    "Preload",
    "React",
    "Runtime",
    "State",
    "Language",
    "Diagram",
    "Core",
  ];
  const inferTargetedCoreLocalFamily = (statementText: string): TargetedCoreFamily => {
    const normalized = statementText.toLowerCase();
    const scoreByFamily = new Map<TargetedCoreFamily, number>();
    const add = (family: TargetedCoreFamily, signal: string, weight = 1): void => {
      if (!normalized.includes(signal)) {
        return;
      }
      scoreByFamily.set(family, (scoreByFamily.get(family) ?? 0) + weight);
    };

    add("Preload", "modulepreload", 3);
    add("Preload", "vite:preloaderror", 3);
    add("Preload", "document.", 2);
    add("Preload", "stylesheet", 2);
    add("Preload", "link", 1);
    add("Preload", "new url(", 2);

    add("React", "react", 2);
    add("React", "__client_internals", 3);
    add("React", "jsx", 2);
    add("React", "createcontext", 2);
    add("React", "usestate", 2);
    add("React", "useeffect", 2);
    add("React", "usereducer", 2);
    add("React", "usecontext", 2);
    add("React", "forwardref", 2);
    add("React", "memo", 1);
    add("React", "suspense", 2);
    add("React", "createelement", 2);

    add("Runtime", "__core-js_shared__", 3);
    add("Runtime", "symbol(src)_1", 3);
    add("Runtime", "symbol.for(", 2);
    add("Runtime", "object.prototype", 2);
    add("Runtime", "function.prototype", 2);
    add("Runtime", "hasownproperty", 2);
    add("Runtime", "tostringtag", 2);
    add("Runtime", "typeof globalthis", 2);
    add("Runtime", "__esmodule", 2);
    add("Runtime", "regexp(", 1);

    add("State", "atom", 2);
    add("State", "weakmap", 2);
    add("State", "weakset", 2);
    add("State", "cache", 1);
    add("State", "query", 2);
    add("State", "listener", 2);
    add("State", "subscribe", 2);
    add("State", "dispatch", 2);
    add("State", "set(", 1);
    add("State", "get(", 1);

    add("Language", "json.parse", 2);
    add("Language", "scopename", 3);
    add("Language", "injectionselector", 3);
    add("Language", "embeddedlangs", 2);
    add("Language", "repository", 2);
    add("Language", "patterns", 1);
    add("Language", "template.", 1);
    add("Language", "language", 1);

    add("Diagram", "cytoscape", 3);
    add("Diagram", "treemap", 3);
    add("Diagram", "diagram", 2);
    add("Diagram", "layout", 1);
    add("Diagram", "node", 1);
    add("Diagram", "edge", 1);

    let bestFamily: TargetedCoreFamily = "Core";
    let bestScore = 0;
    for (const family of TARGETED_CORE_FAMILY_ORDER) {
      if (family === "Core") {
        continue;
      }
      const score = scoreByFamily.get(family) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestFamily = family;
      }
    }
    return bestScore >= 2 ? bestFamily : "Core";
  };
  const applyTargetedHotCoreFamilySweep = (content: string): string => {
    if (!targetedHotLocalRenameEnabled || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const coreLocalPattern = /^(store|service)CoreLocal([A-Za-z0-9]{2,})$/;
    interface TargetedCoreEntry {
      declaredCoreNames: string[];
      referencedNames: Set<string>;
      statementText: string;
      resolvedFamily: TargetedCoreFamily;
    }
    const entries: TargetedCoreEntry[] = [];
    for (const statement of sourceFile.statements) {
      const declaredNames = collectStatementDeclaredNames(statement);
      if (declaredNames.size < 1) {
        continue;
      }
      const declaredCoreNames = [...declaredNames].filter((declaredName) => coreLocalPattern.test(declaredName));
      if (declaredCoreNames.length < 1) {
        continue;
      }
      const referencedNames = collectStatementReferencedNames(statement);
      const statementText = statement.getText(sourceFile);
      entries.push({
        declaredCoreNames,
        referencedNames,
        statementText,
        resolvedFamily: inferTargetedCoreLocalFamily(statementText),
      });
    }
    if (entries.length < 1) {
      return content;
    }
    const familyFromOwnershipName = (name: string): TargetedCoreFamily => {
      const match = name.match(/^(?:store|service)(Runtime|State|React|Preload|Language|Diagram)Local/);
      if (!match || !match[1]) {
        return "Core";
      }
      const token = match[1];
      if (token === "Runtime") {
        return "Runtime";
      }
      if (token === "State") {
        return "State";
      }
      if (token === "React") {
        return "React";
      }
      if (token === "Preload") {
        return "Preload";
      }
      if (token === "Language") {
        return "Language";
      }
      if (token === "Diagram") {
        return "Diagram";
      }
      return "Core";
    };
    const addFamilyScore = (scores: Map<TargetedCoreFamily, number>, family: TargetedCoreFamily, weight: number): void => {
      if (family === "Core") {
        return;
      }
      scores.set(family, (scores.get(family) ?? 0) + weight);
    };
    const selectStrongestTargetedCoreFamily = (
      scores: ReadonlyMap<TargetedCoreFamily, number>,
    ): { family: TargetedCoreFamily; score: number } => {
      let bestFamily: TargetedCoreFamily = "Core";
      let bestScore = 0;
      for (const family of TARGETED_CORE_FAMILY_ORDER) {
        if (family === "Core") {
          continue;
        }
        const score = scores.get(family) ?? 0;
        if (score > bestScore) {
          bestScore = score;
          bestFamily = family;
        }
      }
      return { family: bestFamily, score: bestScore };
    };
    const ownerByDeclaredName = new Map<string, number>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      for (const declaredCoreName of entry.declaredCoreNames) {
        if (!ownerByDeclaredName.has(declaredCoreName)) {
          ownerByDeclaredName.set(declaredCoreName, index);
        }
      }
    }
    const referencingIndexesByDeclaredName = new Map<string, Set<number>>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      for (const referencedName of entry.referencedNames) {
        if (!ownerByDeclaredName.has(referencedName)) {
          continue;
        }
        const indexes = referencingIndexesByDeclaredName.get(referencedName) ?? new Set<number>();
        indexes.add(index);
        referencingIndexesByDeclaredName.set(referencedName, indexes);
      }
    }
    for (let iteration = 0; iteration < 4; iteration += 1) {
      let changed = false;
      for (const entry of entries) {
        if (entry.resolvedFamily !== "Core") {
          continue;
        }
        const supportScores = new Map<TargetedCoreFamily, number>();
        for (const referencedName of entry.referencedNames) {
          const ownerIndex = ownerByDeclaredName.get(referencedName);
          if (ownerIndex === undefined) {
            addFamilyScore(supportScores, familyFromOwnershipName(referencedName), 1.5);
          } else {
            const owner = entries[ownerIndex];
            if (owner) {
              addFamilyScore(supportScores, owner.resolvedFamily, 2);
            }
          }
        }
        for (const declaredCoreName of entry.declaredCoreNames) {
          const inboundIndexes = referencingIndexesByDeclaredName.get(declaredCoreName);
          if (!inboundIndexes) {
            continue;
          }
          for (const inboundIndex of inboundIndexes) {
            const inboundEntry = entries[inboundIndex];
            if (!inboundEntry) {
              continue;
            }
            addFamilyScore(supportScores, inboundEntry.resolvedFamily, 1);
          }
        }
        let bestFamily: TargetedCoreFamily = "Core";
        let bestScore = 0;
        for (const family of TARGETED_CORE_FAMILY_ORDER) {
          if (family === "Core") {
            continue;
          }
          const score = supportScores.get(family) ?? 0;
          if (score > bestScore) {
            bestScore = score;
            bestFamily = family;
          }
        }
        if (bestFamily !== "Core" && bestScore >= 2) {
          entry.resolvedFamily = bestFamily;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    for (const entry of entries) {
      if (entry.resolvedFamily !== "Core") {
        continue;
      }
      const supportScores = new Map<TargetedCoreFamily, number>();
      for (const referencedName of entry.referencedNames) {
        const ownerIndex = ownerByDeclaredName.get(referencedName);
        if (ownerIndex === undefined) {
          addFamilyScore(supportScores, familyFromOwnershipName(referencedName), 1);
        } else {
          const owner = entries[ownerIndex];
          if (owner) {
            addFamilyScore(supportScores, owner.resolvedFamily, 1);
          }
        }
      }
      for (const declaredCoreName of entry.declaredCoreNames) {
        const inboundIndexes = referencingIndexesByDeclaredName.get(declaredCoreName);
        if (!inboundIndexes) {
          continue;
        }
        for (const inboundIndex of inboundIndexes) {
          const inboundEntry = entries[inboundIndex];
          if (!inboundEntry) {
            continue;
          }
          addFamilyScore(supportScores, inboundEntry.resolvedFamily, 0.75);
        }
      }
      let bestFamily: TargetedCoreFamily = "Core";
      let bestScore = 0;
      for (const family of TARGETED_CORE_FAMILY_ORDER) {
        if (family === "Core") {
          continue;
        }
        const score = supportScores.get(family) ?? 0;
        if (score > bestScore) {
          bestScore = score;
          bestFamily = family;
        }
      }
      if (bestFamily !== "Core" && bestScore >= 1) {
        entry.resolvedFamily = bestFamily;
        continue;
      }
      const normalized = entry.statementText.toLowerCase();
      const runtimeLikely =
        normalized.includes("object.prototype") ||
        normalized.includes("function.prototype") ||
        normalized.includes("symbol.for(") ||
        normalized.includes("tostringtag") ||
        normalized.includes("__esmodule") ||
        normalized.includes("typeof globalthis") ||
        normalized.includes("regexp(") ||
        normalized.includes("__core-js_shared__");
      if (runtimeLikely) {
        entry.resolvedFamily = "Runtime";
        continue;
      }
      const stateLikely =
        normalized.includes("weakmap") ||
        normalized.includes("weakset") ||
        normalized.includes("atom") ||
        normalized.includes("subscribe") ||
        normalized.includes("listener") ||
        normalized.includes("dispatch") ||
        normalized.includes("query");
      if (stateLikely) {
        entry.resolvedFamily = "State";
      }
    }
    const familyFrequency = new Map<TargetedCoreFamily, number>();
    for (const entry of entries) {
      if (entry.resolvedFamily === "Core") {
        continue;
      }
      familyFrequency.set(entry.resolvedFamily, (familyFrequency.get(entry.resolvedFamily) ?? 0) + entry.declaredCoreNames.length);
    }
    let dominantFamily: TargetedCoreFamily = "Runtime";
    let dominantScore = 0;
    for (const family of TARGETED_CORE_FAMILY_ORDER) {
      if (family === "Core") {
        continue;
      }
      const score = familyFrequency.get(family) ?? 0;
      if (score > dominantScore) {
        dominantScore = score;
        dominantFamily = family;
      }
    }
    for (const entry of entries) {
      if (entry.resolvedFamily !== "Core") {
        continue;
      }
      const ownershipHintScores = new Map<TargetedCoreFamily, number>();
      for (const referencedName of entry.referencedNames) {
        addFamilyScore(ownershipHintScores, familyFromOwnershipName(referencedName), 1);
      }
      let hintedFamily: TargetedCoreFamily = "Core";
      let hintedScore = 0;
      for (const family of TARGETED_CORE_FAMILY_ORDER) {
        if (family === "Core") {
          continue;
        }
        const score = ownershipHintScores.get(family) ?? 0;
        if (score > hintedScore) {
          hintedScore = score;
          hintedFamily = family;
        }
      }
      if (hintedFamily !== "Core" && hintedScore >= 1) {
        entry.resolvedFamily = hintedFamily;
        continue;
      }
      const canUseDominantFallback =
        entry.referencedNames.size > 0 ||
        entry.declaredCoreNames.length <= 3 ||
        entry.statementText.length <= 1400;
      if (canUseDominantFallback) {
        entry.resolvedFamily = dominantFamily;
      }
    }
    const adjacencyByIndex = new Map<number, Set<number>>();
    const connectEntryIndexes = (leftIndex: number, rightIndex: number): void => {
      if (leftIndex === rightIndex) {
        return;
      }
      const leftNeighbors = adjacencyByIndex.get(leftIndex) ?? new Set<number>();
      leftNeighbors.add(rightIndex);
      adjacencyByIndex.set(leftIndex, leftNeighbors);
      const rightNeighbors = adjacencyByIndex.get(rightIndex) ?? new Set<number>();
      rightNeighbors.add(leftIndex);
      adjacencyByIndex.set(rightIndex, rightNeighbors);
    };
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      for (const referencedName of entry.referencedNames) {
        const ownerIndex = ownerByDeclaredName.get(referencedName);
        if (ownerIndex !== undefined) {
          connectEntryIndexes(index, ownerIndex);
        }
      }
      for (const declaredCoreName of entry.declaredCoreNames) {
        const inboundIndexes = referencingIndexesByDeclaredName.get(declaredCoreName);
        if (!inboundIndexes) {
          continue;
        }
        for (const inboundIndex of inboundIndexes) {
          connectEntryIndexes(index, inboundIndex);
        }
      }
    }
    const visitedEntryIndexes = new Set<number>();
    for (let startIndex = 0; startIndex < entries.length; startIndex += 1) {
      if (visitedEntryIndexes.has(startIndex)) {
        continue;
      }
      const componentIndexes: number[] = [];
      const pending = [startIndex];
      while (pending.length > 0) {
        const nextIndex = pending.pop();
        if (nextIndex === undefined || visitedEntryIndexes.has(nextIndex)) {
          continue;
        }
        visitedEntryIndexes.add(nextIndex);
        componentIndexes.push(nextIndex);
        const neighbors = adjacencyByIndex.get(nextIndex);
        if (!neighbors || neighbors.size < 1) {
          continue;
        }
        for (const neighborIndex of neighbors) {
          if (!visitedEntryIndexes.has(neighborIndex)) {
            pending.push(neighborIndex);
          }
        }
      }
      if (componentIndexes.length < 1) {
        continue;
      }
      const componentScores = new Map<TargetedCoreFamily, number>();
      for (const entryIndex of componentIndexes) {
        const entry = entries[entryIndex];
        if (!entry) {
          continue;
        }
        addFamilyScore(componentScores, entry.resolvedFamily, entry.resolvedFamily === "Core" ? 0 : 3);
        addFamilyScore(componentScores, inferTargetedCoreLocalFamily(entry.statementText), 1.5);
        for (const referencedName of entry.referencedNames) {
          addFamilyScore(componentScores, familyFromOwnershipName(referencedName), 1);
          const ownerIndex = ownerByDeclaredName.get(referencedName);
          if (ownerIndex === undefined || ownerIndex === entryIndex) {
            continue;
          }
          const ownerEntry = entries[ownerIndex];
          if (!ownerEntry) {
            continue;
          }
          addFamilyScore(componentScores, ownerEntry.resolvedFamily, 0.75);
        }
      }
      const strongest = selectStrongestTargetedCoreFamily(componentScores);
      const lockedFamily = strongest.family === "Core" ? dominantFamily : strongest.family;
      for (const entryIndex of componentIndexes) {
        const entry = entries[entryIndex];
        if (!entry) {
          continue;
        }
        entry.resolvedFamily = lockedFamily;
      }
    }
    const usedNames = new Set<string>(content.match(/\b[$A-Za-z_][$A-Za-z0-9_]*\b/g) ?? []);
    const renameMap = new Map<string, string>();
    for (const entry of entries) {
      if (entry.resolvedFamily === "Core") {
        continue;
      }
      for (const declaredName of entry.declaredCoreNames) {
        const match = declaredName.match(coreLocalPattern);
        if (!match) {
          continue;
        }
        const prefix = match[1];
        const suffix = match[2];
        if (!prefix || !suffix) {
          continue;
        }
        const candidate = normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${entry.resolvedFamily}Local${suffix}`));
        const resolved = nextUniqueIdentifier(compactIdentifier(candidate, 40), usedNames);
        if (resolved === declaredName) {
          continue;
        }
        renameMap.set(declaredName, resolved);
      }
    }
    const residualCoreNames = new Set<string>(content.match(/\b(?:store|service)CoreLocal[A-Za-z0-9]{2,}\b/g) ?? []);
    for (const residualName of residualCoreNames) {
      if (renameMap.has(residualName)) {
        continue;
      }
      const match = residualName.match(coreLocalPattern);
      if (!match) {
        continue;
      }
      const prefix = match[1];
      const suffix = match[2];
      if (!prefix || !suffix) {
        continue;
      }
      const candidate = normalizeTargetedAliasBase(sanitizeIdentifier(`${prefix}${dominantFamily}Local${suffix}`));
      const resolved = nextUniqueIdentifier(compactIdentifier(candidate, 40), usedNames);
      if (resolved === residualName) {
        continue;
      }
      renameMap.set(residualName, resolved);
    }
    if (renameMap.size < 1) {
      return content;
    }
    const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let rewritten = content;
    for (const [from, to] of [...renameMap.entries()].sort((left, right) => right[0].length - left[0].length)) {
      rewritten = rewritten.replace(new RegExp(`\\b${escaped(from)}\\b`, "g"), to);
    }
    return rewritten;
  };
  const applyCriticalLocalAstInlinePlanner = (content: string): string => {
    if (!fullLiftFocusedStoreServiceModule || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    interface ForwardingWrapperCandidate {
      name: string;
      targetName: string;
      statement: ts.Statement;
    }
    const extractParameterNames = (parameters: readonly ts.ParameterDeclaration[]): string[] | undefined => {
      const parameterNames: string[] = [];
      for (const parameter of parameters) {
        if (parameter.dotDotDotToken || parameter.questionToken || parameter.initializer || !ts.isIdentifier(parameter.name)) {
          return undefined;
        }
        parameterNames.push(parameter.name.text);
      }
      return parameterNames;
    };
    const extractForwardingTarget = (
      body: ts.ConciseBody | undefined,
      parameterNames: readonly string[],
    ): string | undefined => {
      if (!body) {
        return undefined;
      }
      let callExpression: ts.CallExpression | undefined;
      if (ts.isBlock(body)) {
        if (body.statements.length !== 1) {
          return undefined;
        }
        const statement = body.statements[0];
        if (!statement || !ts.isReturnStatement(statement) || !statement.expression || !ts.isCallExpression(statement.expression)) {
          return undefined;
        }
        callExpression = statement.expression;
      } else if (ts.isCallExpression(body)) {
        callExpression = body;
      } else {
        return undefined;
      }
      if (!callExpression || !ts.isIdentifier(callExpression.expression)) {
        return undefined;
      }
      if (callExpression.arguments.length !== parameterNames.length) {
        return undefined;
      }
      for (let index = 0; index < parameterNames.length; index += 1) {
        const argument = callExpression.arguments[index];
        const parameterName = parameterNames[index];
        if (!argument || !parameterName || !ts.isIdentifier(argument) || argument.text !== parameterName) {
          return undefined;
        }
      }
      return callExpression.expression.text;
    };
    const candidateByName = new Map<string, ForwardingWrapperCandidate>();
    for (const statement of sourceFile.statements) {
      if (hasExportModifier(statement)) {
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const parameterNames = extractParameterNames(statement.parameters);
        if (!parameterNames) {
          continue;
        }
        const targetName = extractForwardingTarget(statement.body, parameterNames);
        if (!targetName || targetName === statement.name.text) {
          continue;
        }
        candidateByName.set(statement.name.text, {
          name: statement.name.text,
          targetName,
          statement,
        });
        continue;
      }
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
        continue;
      }
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
        continue;
      }
      const declaration = statement.declarationList.declarations[0];
      if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const initializer = declaration.initializer;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
        continue;
      }
      const parameterNames = extractParameterNames(initializer.parameters);
      if (!parameterNames) {
        continue;
      }
      const targetName = extractForwardingTarget(initializer.body, parameterNames);
      if (!targetName || targetName === declaration.name.text) {
        continue;
      }
      candidateByName.set(declaration.name.text, {
        name: declaration.name.text,
        targetName,
        statement,
      });
    }
    if (candidateByName.size < 1) {
      return content;
    }

    interface WrapperUsage {
      callCount: number;
      invalidReference: boolean;
    }
    const usageByName = new Map<string, WrapperUsage>();
    for (const candidateName of candidateByName.keys()) {
      usageByName.set(candidateName, {
        callCount: 0,
        invalidReference: false,
      });
    }
    const visitUsage = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isIdentifierReference(node)) {
        const usage = usageByName.get(node.text);
        if (usage) {
          const parent = node.parent;
          const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
          if (isDirectCall) {
            usage.callCount += 1;
          } else {
            usage.invalidReference = true;
          }
        }
      }
      ts.forEachChild(node, visitUsage);
    };
    visitUsage(sourceFile);

    const scoredCandidates: Array<{ candidate: ForwardingWrapperCandidate; callCount: number }> = [];
    for (const [candidateName, candidate] of candidateByName.entries()) {
      const usage = usageByName.get(candidateName);
      if (!usage || usage.invalidReference || usage.callCount < 1) {
        continue;
      }
      if (candidateByName.has(candidate.targetName)) {
        continue;
      }
      scoredCandidates.push({
        candidate,
        callCount: usage.callCount,
      });
    }
    if (scoredCandidates.length < 1) {
      return content;
    }
    const selectedCandidates = scoredCandidates
      .sort((left, right) => {
        if (right.callCount !== left.callCount) {
          return right.callCount - left.callCount;
        }
        return left.candidate.name.localeCompare(right.candidate.name);
      })
      .slice(0, HOT_INLINE_WRAPPER_MAX_PER_MODULE);
    if (selectedCandidates.length < 1) {
      return content;
    }
    const activeCandidateByName = new Map<string, ForwardingWrapperCandidate>();
    const removableStatements = new Set<ts.Statement>();
    for (const { candidate } of selectedCandidates) {
      activeCandidateByName.set(candidate.name, candidate);
      removableStatements.add(candidate.statement);
    }
    const filteredStatements = sourceFile.statements.filter((statement) => !removableStatements.has(statement));
    const filteredSource = ts.factory.updateSourceFile(sourceFile, filteredStatements);
    const transformedResult = ts.transform(filteredSource, [
      (context) => {
        const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const candidate = activeCandidateByName.get(node.expression.text);
            if (candidate) {
              return ts.factory.updateCallExpression(
                node,
                ts.factory.createIdentifier(candidate.targetName),
                node.typeArguments,
                node.arguments,
              );
            }
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (file) => ts.visitNode(file, visit) as ts.SourceFile;
      },
    ]);
    const transformedSource = transformedResult.transformed[0];
    if (!transformedSource) {
      transformedResult.dispose();
      throw new Error("buildQualityModuleContent: missing transformed source in critical local AST inline planner");
    }
    const transformedContent = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformedSource);
    transformedResult.dispose();
    return transformedContent;
  };
  type TypeHintTag = "array" | "boolean" | "function" | "number" | "object" | "string";
  const inferTypeHintTagFromTypeNode = (typeNode: ts.TypeNode): TypeHintTag | undefined => {
    if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
      return "boolean";
    }
    if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
      return "number";
    }
    if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
      return "string";
    }
    if (ts.isArrayTypeNode(typeNode)) {
      return "array";
    }
    if (ts.isFunctionTypeNode(typeNode)) {
      return "function";
    }
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      const typeName = typeNode.typeName.text.toLowerCase();
      if (typeName === "record" || typeName === "object") {
        return "object";
      }
      if (typeName === "array") {
        return "array";
      }
      if (typeName === "function") {
        return "function";
      }
      if (typeName === "string") {
        return "string";
      }
      if (typeName === "number") {
        return "number";
      }
      if (typeName === "boolean") {
        return "boolean";
      }
    }
    return undefined;
  };
  const inferTypeHintTagFromInitializer = (
    initializer: ts.Expression,
    hintByIdentifier: ReadonlyMap<string, TypeHintTag>,
  ): TypeHintTag | undefined => {
    if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return "boolean";
    }
    if (
      ts.isNumericLiteral(initializer) ||
      (ts.isPrefixUnaryExpression(initializer) && ts.isNumericLiteral(initializer.operand))
    ) {
      return "number";
    }
    if (ts.isStringLiteralLike(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
      return "string";
    }
    if (ts.isArrayLiteralExpression(initializer)) {
      return "array";
    }
    if (ts.isObjectLiteralExpression(initializer)) {
      return "object";
    }
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return "function";
    }
    if (ts.isIdentifier(initializer)) {
      return hintByIdentifier.get(initializer.text);
    }
    return undefined;
  };
  const createTypeNodeFromTypeHint = (tag: TypeHintTag): ts.TypeNode => {
    if (tag === "boolean") {
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    }
    if (tag === "number") {
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    }
    if (tag === "string") {
      return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    }
    if (tag === "array") {
      return ts.factory.createArrayTypeNode(ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
    }
    if (tag === "object") {
      return ts.factory.createTypeReferenceNode("Record", [
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ]);
    }
    return ts.factory.createTypeReferenceNode("Function", undefined);
  };
  const applyCriticalTypeHintPropagation = (content: string): string => {
    if (!fullLiftFocusedStoreServiceModule || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const hintByIdentifier = new Map<string, TypeHintTag>();
    for (let iteration = 0; iteration < 3; iteration += 1) {
      let changed = false;
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) {
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue;
          }
          let hint = declaration.type ? inferTypeHintTagFromTypeNode(declaration.type) : undefined;
          if (!hint && declaration.initializer) {
            hint = inferTypeHintTagFromInitializer(declaration.initializer, hintByIdentifier);
          }
          if (!hint) {
            continue;
          }
          const current = hintByIdentifier.get(declaration.name.text);
          if (current === hint) {
            continue;
          }
          hintByIdentifier.set(declaration.name.text, hint);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    if (hintByIdentifier.size < 1) {
      return content;
    }
    let annotationApplied = false;
    const nextStatements = sourceFile.statements.map((statement) => {
      if (!ts.isVariableStatement(statement)) {
        return statement;
      }
      const nextDeclarations = statement.declarationList.declarations.map((declaration) => {
        if (declaration.type || !ts.isIdentifier(declaration.name)) {
          return declaration;
        }
        let hint: TypeHintTag | undefined;
        if (declaration.initializer) {
          hint = inferTypeHintTagFromInitializer(declaration.initializer, hintByIdentifier);
        }
        if (!hint) {
          hint = hintByIdentifier.get(declaration.name.text);
        }
        if (!hint) {
          return declaration;
        }
        annotationApplied = true;
        return ts.factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          createTypeNodeFromTypeHint(hint),
          declaration.initializer,
        );
      });
      return ts.factory.updateVariableStatement(
        statement,
        statement.modifiers,
        ts.factory.updateVariableDeclarationList(statement.declarationList, nextDeclarations),
      );
    });
    if (!annotationApplied) {
      return content;
    }
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
      ts.factory.updateSourceFile(sourceFile, nextStatements),
    );
  };
  const applyCriticalBehaviorClusterFunctionExtraction = (content: string): string => {
    if (!fullLiftFocusedStoreServiceModule || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const exportedNames = collectTopLevelExportedNames(sourceFile);
    const collectAssignedIdentifierNames = (source: ts.SourceFile): Set<string> => {
      const assigned = new Set<string>();
      const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
        kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind)) {
          if (ts.isIdentifier(node.left)) {
            assigned.add(node.left.text);
          }
        } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
          if (
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
            ts.isIdentifier(node.operand)
          ) {
            assigned.add(node.operand.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return assigned;
    };
    const assignedNames = collectAssignedIdentifierNames(sourceFile);
    const usesLexicalCaptureRestrictedForArrow = (node: ts.Node): boolean => {
      let restricted = false;
      const visit = (child: ts.Node): void => {
        if (restricted) {
          return;
        }
        if (
          child.kind === ts.SyntaxKind.ThisKeyword ||
          child.kind === ts.SyntaxKind.SuperKeyword ||
          child.kind === ts.SyntaxKind.NewKeyword
        ) {
          restricted = true;
          return;
        }
        if (ts.isIdentifier(child) && child.text === "arguments" && isIdentifierReference(child)) {
          restricted = true;
          return;
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return restricted;
    };
    interface BehaviorClusterDescriptor {
      role: "Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle";
      domain: string;
      family: TargetedCoreFamily;
      name: string;
    }
    interface ConvertibleFunctionCandidate {
      sourceIndex: number;
      sourceStatement: ts.VariableStatement;
      declaration: ts.VariableDeclaration;
      functionLike: ts.ArrowFunction | ts.FunctionExpression;
      quality: number;
      descriptor: BehaviorClusterDescriptor;
    }
    const describeBehaviorCluster = (name: string, statementText: string, referencedNames: ReadonlySet<string>): BehaviorClusterDescriptor => {
      const family = inferTargetedCoreLocalFamily(statementText);
      const role = inferBehaviorRoleToken(statementText, referencedNames);
      const inferredDomain = inferTargetedHotDomainLocalToken(statementText, referencedNames, family);
      const normalizedDomain =
        inferredDomain.length < 3 || targetedHotWeakTokenSet.has(inferredDomain.toLowerCase())
          ? pickPlanDomainToken(`${name}:cluster-domain`)
          : inferredDomain.toLowerCase();
      return {
        role,
        domain: normalizedDomain,
        family,
        name,
      };
    };
    const isSafeFunctionVariableCandidate = (statement: ts.VariableStatement): ConvertibleFunctionCandidate | undefined => {
      if (hasExportModifier(statement)) {
        return undefined;
      }
      if (!(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) {
        return undefined;
      }
      const declaration = statement.declarationList.declarations[0];
      if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
        return undefined;
      }
      const localName = declaration.name.text;
      if (exportedNames.has(localName) || assignedNames.has(localName) || RESERVED_IDENTIFIERS.has(localName)) {
        return undefined;
      }
      const initializer = declaration.initializer;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
        return undefined;
      }
      if (ts.isFunctionExpression(initializer) && initializer.name && initializer.name.text !== localName) {
        return undefined;
      }
      if (ts.isArrowFunction(initializer) && usesLexicalCaptureRestrictedForArrow(initializer.body)) {
        return undefined;
      }
      const statementText = statement.getText(sourceFile);
      const referencedNames = collectStatementReferencedNames(statement);
      return {
        sourceIndex: sourceFile.statements.indexOf(statement),
        sourceStatement: statement,
        declaration,
        functionLike: initializer,
        quality: scoreNameQuality(localName),
        descriptor: describeBehaviorCluster(localName, statementText, referencedNames),
      };
    };
    const functionVariableCandidates: ConvertibleFunctionCandidate[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      const candidate = isSafeFunctionVariableCandidate(statement);
      if (candidate) {
        functionVariableCandidates.push(candidate);
      }
    }
    const selectedVariableCandidates = functionVariableCandidates
      .sort((left, right) => {
        if (left.quality !== right.quality) {
          return left.quality - right.quality;
        }
        return left.descriptor.name.localeCompare(right.descriptor.name);
      })
      .slice(0, HOT_BEHAVIOR_CLUSTER_MAX_EXTRACTED);
    const selectedVariableStatementSet = new Set<ts.Statement>(selectedVariableCandidates.map((candidate) => candidate.sourceStatement));
    const candidateByStatement = new Map<ts.Statement, ConvertibleFunctionCandidate>();
    for (const candidate of selectedVariableCandidates) {
      candidateByStatement.set(candidate.sourceStatement, candidate);
    }

    const toFunctionDeclaration = (candidate: ConvertibleFunctionCandidate): ts.FunctionDeclaration | undefined => {
      const functionLike = candidate.functionLike;
      const localName = candidate.declaration.name;
      if (!ts.isIdentifier(localName)) {
        return undefined;
      }
      const body = ts.isBlock(functionLike.body)
        ? functionLike.body
        : ts.factory.createBlock([ts.factory.createReturnStatement(functionLike.body)], true);
      const asteriskToken = ts.isFunctionExpression(functionLike) ? functionLike.asteriskToken : undefined;
      return ts.factory.createFunctionDeclaration(
        undefined,
        asteriskToken,
        ts.factory.createIdentifier(localName.text),
        functionLike.typeParameters,
        functionLike.parameters,
        functionLike.type,
        body,
      );
    };

    const roleOrder = new Map<BehaviorClusterDescriptor["role"], number>([
      ["Orchestrate", 0],
      ["Mutate", 1],
      ["Adapt", 2],
      ["Parse", 3],
      ["Select", 4],
      ["Emit", 5],
      ["Handle", 6],
    ]);
    interface ClusteredFunctionEntry {
      statement: ts.FunctionDeclaration;
      descriptor: BehaviorClusterDescriptor;
    }
    const importStatements: ts.Statement[] = [];
    const otherStatements: ts.Statement[] = [];
    const clusteredFunctions: ClusteredFunctionEntry[] = [];
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        importStatements.push(statement);
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && !hasExportModifier(statement)) {
        const descriptor = describeBehaviorCluster(
          statement.name.text,
          statement.getText(sourceFile),
          collectStatementReferencedNames(statement),
        );
        clusteredFunctions.push({
          statement,
          descriptor,
        });
        continue;
      }
      if (selectedVariableStatementSet.has(statement)) {
        const candidate = candidateByStatement.get(statement);
        if (!candidate) {
          otherStatements.push(statement);
          continue;
        }
        const extracted = toFunctionDeclaration(candidate);
        if (!extracted) {
          otherStatements.push(statement);
          continue;
        }
        clusteredFunctions.push({
          statement: extracted,
          descriptor: candidate.descriptor,
        });
        continue;
      }
      otherStatements.push(statement);
    }
    if (clusteredFunctions.length < 1) {
      return content;
    }
    const sortedFunctions = clusteredFunctions.sort((left, right) => {
      const leftRole = roleOrder.get(left.descriptor.role) ?? 99;
      const rightRole = roleOrder.get(right.descriptor.role) ?? 99;
      if (leftRole !== rightRole) {
        return leftRole - rightRole;
      }
      if (left.descriptor.domain !== right.descriptor.domain) {
        return left.descriptor.domain.localeCompare(right.descriptor.domain);
      }
      if (left.descriptor.family !== right.descriptor.family) {
        return left.descriptor.family.localeCompare(right.descriptor.family);
      }
      return left.descriptor.name.localeCompare(right.descriptor.name);
    });
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
      ts.factory.updateSourceFile(sourceFile, [
        ...importStatements,
        ...sortedFunctions.map((entry) => entry.statement),
        ...otherStatements,
      ]),
    );
  };
  const applyCriticalFunctionBodyNamingPass = (content: string): string => {
    if (!fullLiftFocusedStoreServiceModule || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const exportedNames = collectTopLevelExportedNames(sourceFile);
    const usedNames = new Set<string>(content.match(/\b[$A-Za-z_][$A-Za-z0-9_]*\b/g) ?? []);
    const renameMap = new Map<string, string>();
    const shouldRenameFunctionName = (name: string): boolean => {
      if (exportedNames.has(name) || RESERVED_IDENTIFIERS.has(name)) {
        return false;
      }
      const normalizedName = name.toLowerCase();
      const lowQuality = scoreNameQuality(name) < HOT_FUNCTION_BODY_NAME_QUALITY_THRESHOLD;
      const noisyPattern =
        isLikelyObfuscatedAliasToken(normalizedName) ||
        targetedHotLocalNoiseIdentifierPattern.test(name) ||
        /^(?:store|service)(?:core|runtime|state|react|preload|language|diagram)local[a-z0-9]{2,}$/i.test(name) ||
        /^[$a-z]{1,4}\d{0,2}$/i.test(name);
      return lowQuality || noisyPattern;
    };
    const buildFunctionName = (
      originalName: string,
      statementText: string,
      referencedNames: ReadonlySet<string>,
    ): string => {
      const family = inferTargetedCoreLocalFamily(statementText);
      const role = inferBehaviorRoleToken(statementText, referencedNames);
      const ioSignature = inferIoSignatureToken(statementText, referencedNames);
      const inferredDomain = inferTargetedHotDomainLocalToken(statementText, referencedNames, family);
      const normalizedDomain =
        targetedHotWeakTokenSet.has(inferredDomain.toLowerCase()) || inferredDomain.length < 3
          ? pickPlanDomainToken(`${originalName}:domain`)
          : inferredDomain;
      const prefix = targetedHotServiceModule ? "service" : "store";
      const familyStem = family === "Core" ? "" : family;
      const ioStem = ioSignature === "None" ? "" : ioSignature;
      const baseName = normalizeTargetedAliasBase(
        sanitizeIdentifier(`${prefix}${role}${toPascalCase(normalizedDomain)}${familyStem}${ioStem}`),
      );
      return nextUniqueIdentifier(compactIdentifier(baseName, 42), usedNames);
    };
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        const originalName = statement.name.text;
        if (!shouldRenameFunctionName(originalName)) {
          continue;
        }
        const referencedNames = collectStatementReferencedNames(statement);
        const nextName = buildFunctionName(originalName, statement.getText(sourceFile), referencedNames);
        if (nextName === originalName) {
          continue;
        }
        renameMap.set(originalName, nextName);
        continue;
      }
      if (!ts.isVariableStatement(statement) || hasExportModifier(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
          continue;
        }
        const originalName = declaration.name.text;
        if (!shouldRenameFunctionName(originalName)) {
          continue;
        }
        const referencedNames = collectStatementReferencedNames(statement);
        const nextName = buildFunctionName(originalName, statement.getText(sourceFile), referencedNames);
        if (nextName === originalName) {
          continue;
        }
        renameMap.set(originalName, nextName);
      }
    }
    if (renameMap.size < 1) {
      return content;
    }
    const renamedStatements = applyScopedIdentifierRenames([...sourceFile.statements], renameMap);
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
      ts.factory.updateSourceFile(sourceFile, renamedStatements),
    );
  };
  interface StoreShardBehaviorCluster {
    role: "Orchestrate" | "Parse" | "Select" | "Mutate" | "Emit" | "Adapt" | "Handle";
    domain: string;
    family: TargetedCoreFamily;
    key: string;
  }
  const describeStoreShardBehaviorCluster = (
    symbolName: string,
    statementText: string,
    referencedNames: ReadonlySet<string>,
  ): StoreShardBehaviorCluster => {
    const family = inferTargetedCoreLocalFamily(statementText);
    const role = inferBehaviorRoleToken(statementText, referencedNames);
    const inferredDomain = inferTargetedHotDomainLocalToken(statementText, referencedNames, family);
    const domain =
      inferredDomain.length < 3 || targetedHotWeakTokenSet.has(inferredDomain.toLowerCase())
        ? pickPlanDomainToken(`${symbolName}:behavior-cluster`)
        : inferredDomain.toLowerCase();
    const key = sanitizeSegment(`${role}-${domain}-${family}`, `${role.toLowerCase()}-cluster`);
    return {
      role,
      domain,
      family,
      key,
    };
  };
  const countNodeLines = (node: ts.Node, sourceFile: ts.SourceFile): number => {
    const text = node.getText(sourceFile);
    return text.length < 1 ? 0 : text.split(/\r?\n/).length;
  };
  const enforceTargetedStoreShardFunctionLengthCap = (content: string): string => {
    if (!targetedQualityShardModule || plan.archetype !== "store" || content.length < 1) {
      return content;
    }
    const source = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const violations: string[] = [];
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        const lineCount = countNodeLines(statement, source);
        if (lineCount > HOT_STORE_SHARD_FUNCTION_MAX_LINES) {
          violations.push(`${statement.name.text}:${lineCount}`);
        }
        continue;
      }
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
          continue;
        }
        const lineCount = countNodeLines(declaration.initializer, source);
        if (lineCount > HOT_STORE_SHARD_FUNCTION_MAX_LINES) {
          violations.push(`${declaration.name.text}:${lineCount}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `buildQualityModuleContent: function-length cap failed for ${plan.moduleId} (${violations.slice(0, 8).join(", ")})`,
      );
    }
    return content;
  };
  const applyTargetedStoreShardLongFunctionClusterSplit = (content: string): string => {
    if (!targetedQualityShardModule || plan.archetype !== "store" || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    interface LongFunctionCandidate {
      statement: ts.FunctionDeclaration;
      lineCount: number;
      cluster: StoreShardBehaviorCluster;
    }
    const candidates: LongFunctionCandidate[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || hasExportModifier(statement)) {
        continue;
      }
      const lineCount = countNodeLines(statement, sourceFile);
      if (lineCount < HOT_STORE_SHARD_LONG_FUNCTION_LINES) {
        continue;
      }
      if (!isSelfContainedHelperFunction(statement)) {
        continue;
      }
      const cluster = describeStoreShardBehaviorCluster(
        statement.name.text,
        statement.getText(sourceFile),
        collectStatementReferencedNames(statement),
      );
      candidates.push({
        statement,
        lineCount,
        cluster,
      });
    }
    if (candidates.length < 1) {
      return content;
    }
    const selectedCandidates = candidates
      .sort((left, right) => {
        if (right.lineCount !== left.lineCount) {
          return right.lineCount - left.lineCount;
        }
        return left.statement.name!.text.localeCompare(right.statement.name!.text);
      })
      .slice(0, HOT_STORE_SHARD_MAX_MOVED_LONG_FUNCTIONS);
    if (selectedCandidates.length < 1) {
      return content;
    }
    const groupByCluster = new Map<string, LongFunctionCandidate[]>();
    for (const candidate of selectedCandidates) {
      const bucket = groupByCluster.get(candidate.cluster.key) ?? [];
      bucket.push(candidate);
      groupByCluster.set(candidate.cluster.key, bucket);
    }
    const selectedGroups = [...groupByCluster.entries()]
      .sort((left, right) => {
        const leftLines = left[1].reduce((sum, entry) => sum + entry.lineCount, 0);
        const rightLines = right[1].reduce((sum, entry) => sum + entry.lineCount, 0);
        if (rightLines !== leftLines) {
          return rightLines - leftLines;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, HOT_STORE_SHARD_MAX_CLUSTER_MODULES);
    const selectedStatementSet = new Set<ts.Statement>();
    const helperImportDeclarations: ts.ImportDeclaration[] = [];
    const shardBaseStem = sanitizeSegment(path.basename(normalizedHotFilePath, ".ts"), "store-shard");
    const helperPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    for (let groupIndex = 0; groupIndex < selectedGroups.length; groupIndex += 1) {
      const group = selectedGroups[groupIndex];
      if (!group) {
        continue;
      }
      const [clusterKey, entries] = group;
      const sortedEntries = [...entries].sort((left, right) => left.statement.name!.text.localeCompare(right.statement.name!.text));
      for (const entry of sortedEntries) {
        selectedStatementSet.add(entry.statement);
      }
      const helperStem = sanitizeSegment(
        `${shardBaseStem}-${clusterKey}-cluster`,
        `${shardBaseStem}-cluster-${String(groupIndex + 1).padStart(2, "0")}`,
      );
      const helperAbsolutePath = path.join(
        outputProjectDirectory,
        "src",
        "services",
        "store",
        "helpers",
        `${helperStem}.ts`,
      );
      const helperImportPath = toJsImportPath(moduleAbsolutePath, helperAbsolutePath);
      const helperStatements = sortedEntries.map((entry) =>
        ts.factory.updateFunctionDeclaration(
          entry.statement,
          [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
          entry.statement.asteriskToken,
          entry.statement.name,
          entry.statement.typeParameters,
          entry.statement.parameters,
          entry.statement.type,
          entry.statement.body,
        ),
      );
      const helperSource = ts.factory.updateSourceFile(sourceFile, helperStatements);
      const helperContent = [
        "// @ts-nocheck",
        "// Targeted store-shard long-function cluster split.",
        "",
        helperPrinter.printFile(helperSource),
      ].join("\n");
      const existingHelperContent = assetFilesByPath.get(helperAbsolutePath);
      if (existingHelperContent && existingHelperContent !== helperContent) {
        throw new Error(`buildQualityModuleContent: helper cluster collision at ${helperAbsolutePath}`);
      }
      assetFilesByPath.set(helperAbsolutePath, helperContent);
      helperImportDeclarations.push(
        ts.factory.createImportDeclaration(
          undefined,
          ts.factory.createImportClause(
            false,
            undefined,
            ts.factory.createNamedImports(
              sortedEntries.map((entry) =>
                ts.factory.createImportSpecifier(
                  false,
                  undefined,
                  ts.factory.createIdentifier(entry.statement.name!.text),
                ),
              ),
            ),
          ),
          ts.factory.createStringLiteral(helperImportPath),
          undefined,
        ),
      );
    }
    if (helperImportDeclarations.length < 1 || selectedStatementSet.size < 1) {
      return content;
    }
    const lastImportIndex = sourceFile.statements.reduce((lastIndex, statement, index) => {
      if (ts.isImportDeclaration(statement)) {
        return index;
      }
      return lastIndex;
    }, -1);
    const sortedHelperImports = [...helperImportDeclarations].sort((left, right) => {
      const leftPath = ts.isStringLiteralLike(left.moduleSpecifier) ? left.moduleSpecifier.text : "";
      const rightPath = ts.isStringLiteralLike(right.moduleSpecifier) ? right.moduleSpecifier.text : "";
      return leftPath.localeCompare(rightPath);
    });
    const nextStatements: ts.Statement[] = [];
    let importsInserted = false;
    for (let index = 0; index < sourceFile.statements.length; index += 1) {
      const statement = sourceFile.statements[index];
      if (!statement) {
        continue;
      }
      if (!importsInserted && index > lastImportIndex) {
        nextStatements.push(...sortedHelperImports);
        importsInserted = true;
      }
      if (selectedStatementSet.has(statement)) {
        continue;
      }
      nextStatements.push(statement);
    }
    if (!importsInserted) {
      nextStatements.unshift(...sortedHelperImports);
    }
    const rewritten = helperPrinter.printFile(ts.factory.updateSourceFile(sourceFile, nextStatements));
    return rewritten;
  };
  const applyTargetedStoreShardDomainHelperHoist = (content: string): string => {
    if (!targetedQualityShardModule || plan.archetype !== "store" || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const helperCandidates: ts.FunctionDeclaration[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || hasExportModifier(statement)) {
        continue;
      }
      const lineCount = countNodeLines(statement, sourceFile);
      if (lineCount < 8) {
        continue;
      }
      if (!isSelfContainedHelperFunction(statement)) {
        continue;
      }
      const name = statement.name.text;
      const runtimeLike =
        /^(?:store)(?:Runtime|Core|Architecture|Agent|Page|Arc|Apl|Angular|Base|Clone|Cytoscape|Treemap)/.test(name) ||
        scoreNameQuality(name) < HOT_FUNCTION_BODY_NAME_QUALITY_THRESHOLD;
      if (!runtimeLike) {
        continue;
      }
      helperCandidates.push(statement);
    }
    if (helperCandidates.length < 2) {
      return content;
    }
    const selectedHelpers = helperCandidates
      .sort((left, right) => {
        const leftLines = countNodeLines(left, sourceFile);
        const rightLines = countNodeLines(right, sourceFile);
        if (rightLines !== leftLines) {
          return rightLines - leftLines;
        }
        return left.name!.text.localeCompare(right.name!.text);
      })
      .slice(0, HOT_STORE_SHARD_MAX_DOMAIN_HELPERS);
    if (selectedHelpers.length < 2) {
      return content;
    }
    const selectedSet = new Set<ts.Statement>(selectedHelpers);
    const shardBaseStem = sanitizeSegment(path.basename(normalizedHotFilePath, ".ts"), "store-shard");
    const helperStem = sanitizeSegment(`${shardBaseStem}-domain-helpers`, `${shardBaseStem}-helpers`);
    const helperAbsolutePath = path.join(outputProjectDirectory, "src", "services", "store", "helpers", `${helperStem}.ts`);
    const helperImportPath = toJsImportPath(moduleAbsolutePath, helperAbsolutePath);
    const helperPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const helperStatements = selectedHelpers
      .sort((left, right) => left.name!.text.localeCompare(right.name!.text))
      .map((statement) =>
        ts.factory.updateFunctionDeclaration(
          statement,
          [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
          statement.asteriskToken,
          statement.name,
          statement.typeParameters,
          statement.parameters,
          statement.type,
          statement.body,
        ),
      );
    const helperSource = ts.factory.updateSourceFile(sourceFile, helperStatements);
    const helperContent = [
      "// @ts-nocheck",
      "// Targeted store-shard domain helper hoist.",
      "",
      helperPrinter.printFile(helperSource),
    ].join("\n");
    const existingHelperContent = assetFilesByPath.get(helperAbsolutePath);
    if (existingHelperContent && existingHelperContent !== helperContent) {
      throw new Error(`buildQualityModuleContent: domain helper collision at ${helperAbsolutePath}`);
    }
    assetFilesByPath.set(helperAbsolutePath, helperContent);
    const helperImport = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(
        false,
        undefined,
        ts.factory.createNamedImports(
          helperStatements.map((statement) =>
            ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(statement.name!.text)),
          ),
        ),
      ),
      ts.factory.createStringLiteral(helperImportPath),
      undefined,
    );
    const lastImportIndex = sourceFile.statements.reduce((lastIndex, statement, index) => {
      if (ts.isImportDeclaration(statement)) {
        return index;
      }
      return lastIndex;
    }, -1);
    const nextStatements: ts.Statement[] = [];
    let helperImportInserted = false;
    for (let index = 0; index < sourceFile.statements.length; index += 1) {
      const statement = sourceFile.statements[index];
      if (!statement) {
        continue;
      }
      if (!helperImportInserted && index > lastImportIndex) {
        nextStatements.push(helperImport);
        helperImportInserted = true;
      }
      if (selectedSet.has(statement)) {
        continue;
      }
      nextStatements.push(statement);
    }
    if (!helperImportInserted) {
      nextStatements.unshift(helperImport);
    }
    return helperPrinter.printFile(ts.factory.updateSourceFile(sourceFile, nextStatements));
  };
  const collectTopLevelDeclaredNamesShallow = (statement: ts.Statement): Set<string> => {
    const names = new Set<string>();
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
      return names;
    }
    if (!ts.isVariableStatement(statement)) {
      return names;
    }
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    return names;
  };
  const collectImportDeclaredNames = (statement: ts.ImportDeclaration): Set<string> => {
    const names = new Set<string>();
    const clause = statement.importClause;
    if (!clause) {
      return names;
    }
    if (clause.name) {
      names.add(clause.name.text);
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings) {
      return names;
    }
    if (ts.isNamespaceImport(namedBindings)) {
      names.add(namedBindings.name.text);
      return names;
    }
    for (const element of namedBindings.elements) {
      names.add(element.name.text);
    }
    return names;
  };
  const isStoreShardRuntimeLikeName = (name: string): boolean => {
    const normalized = name.toLowerCase();
    if (/^(?:store)(?:runtime|core|architecture|agent|page|arc|apl|angular|base|clone|cytoscape|treemap)/.test(name)) {
      return true;
    }
    if (
      normalized.includes("runtime") ||
      normalized.includes("polyfill") ||
      normalized.includes("core") ||
      normalized.includes("vendor") ||
      normalized.includes("modulepreload")
    ) {
      return true;
    }
    return false;
  };
  const hasStoreShardRuntimeSignal = (statementText: string): boolean => {
    const normalized = statementText.toLowerCase();
    return (
      normalized.includes("__core-js_shared__") ||
      normalized.includes("symbol.for(") ||
      normalized.includes("object.freeze(json.parse") ||
      normalized.includes("modulepreload") ||
      normalized.includes("vite:preloaderror") ||
      normalized.includes("object.prototype") ||
      normalized.includes("function.prototype") ||
      normalized.includes("object.defineproperty(") ||
      normalized.includes("__esmodule") ||
      normalized.includes("globalthis") ||
      normalized.includes("weakmap") ||
      normalized.includes("weakset") ||
      normalized.includes("promise.resolve") ||
      normalized.includes("process.env") ||
      normalized.includes("[statsig]")
    );
  };
  const isMovableTopLevelStatementForStoreShard = (statement: ts.Statement): boolean => {
    if (hasExportModifier(statement)) {
      return false;
    }
    if (ts.isFunctionDeclaration(statement)) {
      return Boolean(statement.name && statement.body);
    }
    if (ts.isClassDeclaration(statement)) {
      return Boolean(statement.name);
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.length > 0;
    }
    return false;
  };
  const asExportedTopLevelStatement = (statement: ts.Statement): ts.Statement => {
    const exportModifier = ts.factory.createModifier(ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement)) {
      return ts.factory.updateFunctionDeclaration(
        statement,
        [exportModifier],
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
        [exportModifier],
        statement.name,
        statement.typeParameters,
        statement.heritageClauses,
        statement.members,
      );
    }
    if (ts.isVariableStatement(statement)) {
      return ts.factory.updateVariableStatement(statement, [exportModifier], statement.declarationList);
    }
    return statement;
  };
  interface StoreShardClosureResult {
    closureStatements: Set<ts.Statement>;
    unresolvedLocalRefs: Set<string>;
  }
  const buildStoreShardDependencyClosure = (
    rootStatement: ts.Statement,
    refsByStatement: ReadonlyMap<ts.Statement, ReadonlySet<string>>,
    movableStatementByName: ReadonlyMap<string, ts.Statement>,
    topLevelStatementByName: ReadonlyMap<string, ts.Statement>,
  ): StoreShardClosureResult => {
    const closureStatements = new Set<ts.Statement>();
    const unresolvedLocalRefs = new Set<string>();
    const pendingStatements: ts.Statement[] = [rootStatement];
    while (pendingStatements.length > 0) {
      const statement = pendingStatements.pop();
      if (!statement || closureStatements.has(statement)) {
        continue;
      }
      closureStatements.add(statement);
      const references = refsByStatement.get(statement) ?? new Set<string>();
      for (const reference of references) {
        const movableDependency = movableStatementByName.get(reference);
        if (movableDependency) {
          if (!closureStatements.has(movableDependency)) {
            pendingStatements.push(movableDependency);
          }
          continue;
        }
        const localDependency = topLevelStatementByName.get(reference);
        if (localDependency && !closureStatements.has(localDependency)) {
          unresolvedLocalRefs.add(reference);
        }
      }
    }
    return {
      closureStatements,
      unresolvedLocalRefs,
    };
  };
  interface StoreShardClusterSelection {
    clusterKey: string;
    clusterDescriptor: StoreShardBehaviorCluster;
    statements: Set<ts.Statement>;
  }
  const applyStoreShardClusterExtraction = (
    content: string,
    mode: "dependency-closure" | "runtime-quarantine",
    passTag: string,
  ): string => {
    if (!targetedQualityShardModule || plan.archetype !== "store" || content.length < 1) {
      return content;
    }
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const statementOrderIndex = new Map<ts.Statement, number>();
    sourceFile.statements.forEach((statement, index) => {
      statementOrderIndex.set(statement, index);
    });
    const importStatements: ts.ImportDeclaration[] = [];
    const importDeclaredNamesByStatement = new Map<ts.ImportDeclaration, Set<string>>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      importStatements.push(statement);
      importDeclaredNamesByStatement.set(statement, collectImportDeclaredNames(statement));
    }
    const topLevelStatementByName = new Map<string, ts.Statement>();
    const movableStatementByName = new Map<string, ts.Statement>();
    const refsByStatement = new Map<ts.Statement, ReadonlySet<string>>();
    for (const statement of sourceFile.statements) {
      const declaredNames = collectTopLevelDeclaredNamesShallow(statement);
      if (declaredNames.size > 0) {
        for (const name of declaredNames) {
          if (!topLevelStatementByName.has(name)) {
            topLevelStatementByName.set(name, statement);
          }
          if (isMovableTopLevelStatementForStoreShard(statement) && !movableStatementByName.has(name)) {
            movableStatementByName.set(name, statement);
          }
        }
      }
      refsByStatement.set(statement, collectStatementReferencedNames(statement));
    }
    interface ClusterRootCandidate {
      statement: ts.Statement;
      rootName: string;
      lineCount: number;
      descriptor: StoreShardBehaviorCluster;
    }
    const dependencyMinLines = strictTargetedQualityShardModule
      ? HOT_STORE_SHARD_DEPENDENCY_STRICT_MIN_LINES
      : HOT_STORE_SHARD_LONG_FUNCTION_LINES;
    const runtimeMinLines = strictTargetedQualityShardModule
      ? HOT_STORE_SHARD_RUNTIME_STRICT_MIN_LINES
      : HOT_STORE_SHARD_RUNTIME_CLUSTER_MIN_LINES;
    const maxClusters =
      mode === "dependency-closure"
        ? strictTargetedQualityShardModule
          ? HOT_STORE_SHARD_DEPENDENCY_STRICT_MAX_MODULES
          : HOT_STORE_SHARD_DEPENDENCY_CLUSTER_MAX_MODULES
        : strictTargetedQualityShardModule
          ? HOT_STORE_SHARD_RUNTIME_STRICT_MAX_MODULES
          : HOT_STORE_SHARD_RUNTIME_CLUSTER_MAX_MODULES;
    const maxClosureStatements =
      mode === "dependency-closure"
        ? strictTargetedQualityShardModule
          ? HOT_STORE_SHARD_DEPENDENCY_STRICT_MAX_STATEMENTS
          : HOT_STORE_SHARD_DEPENDENCY_CLOSURE_MAX_STATEMENTS
        : strictTargetedQualityShardModule
          ? HOT_STORE_SHARD_RUNTIME_STRICT_MAX_STATEMENTS
          : HOT_STORE_SHARD_RUNTIME_CLUSTER_MAX_STATEMENTS;
    const rootCandidates: ClusterRootCandidate[] = [];
    const pushRootCandidate = (
      statement: ts.Statement,
      rootName: string,
      lineCount: number,
      statementText: string,
      skipIfSelfContained: boolean,
    ): void => {
      if (mode === "dependency-closure") {
        if (lineCount < dependencyMinLines) {
          return;
        }
        if (skipIfSelfContained && ts.isFunctionDeclaration(statement) && isSelfContainedHelperFunction(statement)) {
          return;
        }
      } else {
        if (lineCount < runtimeMinLines) {
          return;
        }
        if (!isStoreShardRuntimeLikeName(rootName) && !hasStoreShardRuntimeSignal(statementText)) {
          return;
        }
      }
      const descriptor = describeStoreShardBehaviorCluster(
        rootName,
        statementText,
        refsByStatement.get(statement) ?? new Set<string>(),
      );
      rootCandidates.push({
        statement,
        rootName,
        lineCount,
        descriptor,
      });
    };
    for (const statement of sourceFile.statements) {
      if (!isMovableTopLevelStatementForStoreShard(statement)) {
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        const lineCount = countNodeLines(statement, sourceFile);
        const rootName = statement.name.text;
        pushRootCandidate(statement, rootName, lineCount, statement.getText(sourceFile), true);
        continue;
      }
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
        const declaration = statement.declarationList.declarations[0];
        if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
          continue;
        }
        const lineCount = declaration.initializer.getText(sourceFile).split(/\r?\n/).length;
        if (lineCount < 1) {
          continue;
        }
        const rootName = declaration.name.text;
        pushRootCandidate(statement, rootName, lineCount, statement.getText(sourceFile), false);
        continue;
      }
      if (mode === "runtime-quarantine" && ts.isClassDeclaration(statement) && statement.name) {
        const lineCount = countNodeLines(statement, sourceFile);
        const rootName = statement.name.text;
        pushRootCandidate(statement, rootName, lineCount, statement.getText(sourceFile), false);
      }
    }
    if (rootCandidates.length < 1) {
      return content;
    }
    const selectedByCluster = new Map<string, StoreShardClusterSelection>();
    const globallySelectedStatements = new Set<ts.Statement>();
    const orderedCandidates = [...rootCandidates].sort((left, right) => {
      if (right.lineCount !== left.lineCount) {
        return right.lineCount - left.lineCount;
      }
      return left.rootName.localeCompare(right.rootName);
    });
    for (const candidate of orderedCandidates) {
      const closure = buildStoreShardDependencyClosure(
        candidate.statement,
        refsByStatement,
        movableStatementByName,
        topLevelStatementByName,
      );
      if (closure.unresolvedLocalRefs.size > 0) {
        continue;
      }
      if (closure.closureStatements.size < 1 || closure.closureStatements.size > maxClosureStatements) {
        continue;
      }
      let overlaps = false;
      for (const statement of closure.closureStatements) {
        if (globallySelectedStatements.has(statement)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        continue;
      }
      const clusterKey = candidate.descriptor.key;
      const existingCluster = selectedByCluster.get(clusterKey);
      if (!existingCluster && selectedByCluster.size >= maxClusters) {
        continue;
      }
      const cluster = existingCluster ?? {
        clusterKey,
        clusterDescriptor: candidate.descriptor,
        statements: new Set<ts.Statement>(),
      };
      for (const statement of closure.closureStatements) {
        cluster.statements.add(statement);
        globallySelectedStatements.add(statement);
      }
      selectedByCluster.set(clusterKey, cluster);
    }
    if (selectedByCluster.size < 1 || globallySelectedStatements.size < 1) {
      return content;
    }
    const remainingStatements = sourceFile.statements.filter((statement) => !globallySelectedStatements.has(statement));
    const remainingRefs = new Set<string>();
    for (const statement of remainingStatements) {
      const refs = refsByStatement.get(statement) ?? new Set<string>();
      for (const ref of refs) {
        remainingRefs.add(ref);
      }
    }
    const selectedClusters = [...selectedByCluster.values()].sort((left, right) => left.clusterKey.localeCompare(right.clusterKey));
    const shardBaseStem = sanitizeSegment(path.basename(normalizedHotFilePath, ".ts"), "store-shard");
    const helperPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const newImports: ts.ImportDeclaration[] = [];
    for (let clusterIndex = 0; clusterIndex < selectedClusters.length; clusterIndex += 1) {
      const cluster = selectedClusters[clusterIndex];
      if (!cluster) {
        continue;
      }
      const orderedClusterStatements = [...cluster.statements].sort((left, right) => {
        const leftIndex = statementOrderIndex.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = statementOrderIndex.get(right) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
      const movedDeclaredNames = new Set<string>();
      const helperRefs = new Set<string>();
      for (const statement of orderedClusterStatements) {
        const names = collectTopLevelDeclaredNamesShallow(statement);
        for (const name of names) {
          movedDeclaredNames.add(name);
        }
        const refs = refsByStatement.get(statement) ?? new Set<string>();
        for (const ref of refs) {
          helperRefs.add(ref);
        }
      }
      for (const name of movedDeclaredNames) {
        helperRefs.delete(name);
      }
      const helperImportStatements: ts.ImportDeclaration[] = [];
      for (const importStatement of importStatements) {
        const declaredNames = importDeclaredNamesByStatement.get(importStatement) ?? new Set<string>();
        const needed = [...declaredNames].some((name) => helperRefs.has(name));
        if (needed) {
          helperImportStatements.push(importStatement);
        }
      }
      const exportedClusterStatements = orderedClusterStatements.map((statement) => asExportedTopLevelStatement(statement));
      if (exportedClusterStatements.length < 1) {
        continue;
      }
      const helperSuffixBase = mode === "dependency-closure" ? "closure" : "runtime";
      const helperSuffix = sanitizeSegment(`${helperSuffixBase}-${passTag}`, helperSuffixBase);
      const helperStem = sanitizeSegment(
        `${shardBaseStem}-${cluster.clusterKey}-${helperSuffix}`,
        `${shardBaseStem}-${helperSuffix}-${String(clusterIndex + 1).padStart(2, "0")}`,
      );
      const helperAbsolutePath = path.join(
        outputProjectDirectory,
        "src",
        "services",
        "store",
        "runtime",
        `${helperStem}.ts`,
      );
      const helperImportPath = toJsImportPath(moduleAbsolutePath, helperAbsolutePath);
      const helperSource = ts.factory.updateSourceFile(sourceFile, [...helperImportStatements, ...exportedClusterStatements]);
      const helperContent = [
        "// @ts-nocheck",
        mode === "dependency-closure"
          ? "// Targeted store-shard dependency-closure extraction."
          : "// Targeted store-shard runtime cluster quarantine.",
        "",
        helperPrinter.printFile(helperSource),
      ].join("\n");
      const existingHelperContent = assetFilesByPath.get(helperAbsolutePath);
      if (existingHelperContent && existingHelperContent !== helperContent) {
        throw new Error(`buildQualityModuleContent: runtime helper collision at ${helperAbsolutePath}`);
      }
      assetFilesByPath.set(helperAbsolutePath, helperContent);

      const importNames = [...movedDeclaredNames]
        .filter((name) => remainingRefs.has(name))
        .sort((left, right) => left.localeCompare(right));
      if (importNames.length < 1) {
        continue;
      }
      newImports.push(
        ts.factory.createImportDeclaration(
          undefined,
          ts.factory.createImportClause(
            false,
            undefined,
            ts.factory.createNamedImports(
              importNames.map((name) =>
                ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name)),
              ),
            ),
          ),
          ts.factory.createStringLiteral(helperImportPath),
          undefined,
        ),
      );
    }
    if (newImports.length < 1) {
      return content;
    }
    const lastImportIndex = sourceFile.statements.reduce((lastIndex, statement, index) => {
      if (ts.isImportDeclaration(statement)) {
        return index;
      }
      return lastIndex;
    }, -1);
    const sortedNewImports = [...newImports].sort((left, right) => {
      const leftPath = ts.isStringLiteralLike(left.moduleSpecifier) ? left.moduleSpecifier.text : "";
      const rightPath = ts.isStringLiteralLike(right.moduleSpecifier) ? right.moduleSpecifier.text : "";
      return leftPath.localeCompare(rightPath);
    });
    const nextStatements: ts.Statement[] = [];
    let importsInserted = false;
    for (let index = 0; index < sourceFile.statements.length; index += 1) {
      const statement = sourceFile.statements[index];
      if (!statement) {
        continue;
      }
      if (!importsInserted && index > lastImportIndex) {
        nextStatements.push(...sortedNewImports);
        importsInserted = true;
      }
      if (globallySelectedStatements.has(statement)) {
        continue;
      }
      nextStatements.push(statement);
    }
    if (!importsInserted) {
      nextStatements.unshift(...sortedNewImports);
    }
    return helperPrinter.printFile(ts.factory.updateSourceFile(sourceFile, nextStatements));
  };
  const applyTargetedStoreShardDependencyClosureExtraction = (content: string): string => {
    let next = content;
    for (let passIndex = 0; passIndex < HOT_STORE_SHARD_CLUSTER_EXTRACTION_PASSES; passIndex += 1) {
      const rewritten = applyStoreShardClusterExtraction(next, "dependency-closure", `p${String(passIndex + 1).padStart(2, "0")}`);
      if (rewritten === next) {
        break;
      }
      next = rewritten;
    }
    return next;
  };
  const applyTargetedStoreShardRuntimeClusterQuarantine = (content: string): string => {
    let next = content;
    for (let passIndex = 0; passIndex < HOT_STORE_SHARD_CLUSTER_EXTRACTION_PASSES; passIndex += 1) {
      const rewritten = applyStoreShardClusterExtraction(next, "runtime-quarantine", `p${String(passIndex + 1).padStart(2, "0")}`);
      if (rewritten === next) {
        break;
      }
      next = rewritten;
    }
    return next;
  };
  const applyImportHygienePass = (content: string): string => {
    const collectIdentifierReferenceCounts = (sourceFile: ts.SourceFile): Map<string, number> => {
      const counts = new Map<string, number>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && isIdentifierReference(node)) {
          counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return counts;
    };
    const isValidIdentifierImportName = (name: string): boolean => /^[$A-Za-z_][$A-Za-z0-9_]*$/.test(name);
    const collectAssignedIdentifierNames = (source: ts.SourceFile): Set<string> => {
      const assigned = new Set<string>();
      const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
        kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind)) {
          if (ts.isIdentifier(node.left)) {
            assigned.add(node.left.text);
          }
        } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
          if (
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
            ts.isIdentifier(node.operand)
          ) {
            assigned.add(node.operand.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return assigned;
    };
    const demoteAssignedConstDeclarations = (contentText: string): string => {
      if (contentText.length < 1) {
        return contentText;
      }
      const source = ts.createSourceFile(
        `${plan.moduleId}.ts`,
        contentText,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      const assigned = collectAssignedIdentifierNames(source);
      if (assigned.size < 1) {
        return contentText;
      }
      let changed = false;
      const nextStatements = source.statements.map((statement) => {
        if (!ts.isVariableStatement(statement)) {
          return statement;
        }
        const declarationList = statement.declarationList;
        if (!(declarationList.flags & ts.NodeFlags.Const)) {
          return statement;
        }
        let shouldDemote = false;
        for (const declaration of declarationList.declarations) {
          const names = new Set<string>();
          collectBindingNames(declaration.name, names);
          for (const name of names) {
            if (assigned.has(name)) {
              shouldDemote = true;
              break;
            }
          }
          if (shouldDemote) {
            break;
          }
        }
        if (!shouldDemote) {
          return statement;
        }
        changed = true;
        return ts.factory.updateVariableStatement(
          statement,
          statement.modifiers,
          ts.factory.createVariableDeclarationList(declarationList.declarations, ts.NodeFlags.Let),
        );
      });
      if (!changed) {
        return contentText;
      }
      return printer.printFile(ts.factory.updateSourceFile(source, nextStatements));
    };
    const splitLongNamedImportDeclarations = (contentText: string): string => {
      if (contentText.length < 1) {
        return contentText;
      }
      const source = ts.createSourceFile(
        `${plan.moduleId}.ts`,
        contentText,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      const maxSpecifiersPerImport = 24;
      let changed = false;
      const nextStatements: ts.Statement[] = [];
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
          nextStatements.push(statement);
          continue;
        }
        const importClause = statement.importClause;
        const namedBindings = importClause.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings) || namedBindings.elements.length <= maxSpecifiersPerImport) {
          nextStatements.push(statement);
          continue;
        }
        changed = true;
        const specifiers = [...namedBindings.elements];
        const defaultImportName = importClause.name?.text;
        for (let offset = 0; offset < specifiers.length; offset += maxSpecifiersPerImport) {
          const slice = specifiers.slice(offset, offset + maxSpecifiersPerImport);
          const splitImportClause = ts.factory.createImportClause(
            importClause.isTypeOnly,
            offset === 0 && defaultImportName ? ts.factory.createIdentifier(defaultImportName) : undefined,
            ts.factory.createNamedImports(slice),
          );
          nextStatements.push(
            ts.factory.createImportDeclaration(
              statement.modifiers,
              splitImportClause,
              statement.moduleSpecifier,
              statement.attributes,
            ),
          );
        }
      }
      if (!changed) {
        return contentText;
      }
      return printer.printFile(ts.factory.updateSourceFile(source, nextStatements));
    };
    interface NamespaceBindingEntry {
      localName: string;
      importedName: string;
    }
    interface NamespaceAliasMetadata {
      alias: string;
      modulePath: string;
      bindings: NamespaceBindingEntry[];
      statement: ts.VariableStatement;
      declaration: ts.VariableDeclaration;
    }
    const collectNamespaceAliasMetadata = (source: ts.SourceFile): Map<string, NamespaceAliasMetadata> => {
      const namespaceImportByAlias = new Map<string, string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
          continue;
        }
        const namedBindings = statement.importClause.namedBindings;
        if (!namedBindings || !ts.isNamespaceImport(namedBindings)) {
          continue;
        }
        const moduleSpecifier = statement.moduleSpecifier;
        if (!ts.isStringLiteralLike(moduleSpecifier)) {
          continue;
        }
        namespaceImportByAlias.set(namedBindings.name.text, moduleSpecifier.text);
      }
      const metadataByAlias = new Map<string, NamespaceAliasMetadata>();
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
          continue;
        }
        const declaration = statement.declarationList.declarations[0];
        if (!declaration) {
          continue;
        }
        if (
          !ts.isObjectBindingPattern(declaration.name) ||
          !declaration.initializer ||
          !ts.isIdentifier(declaration.initializer)
        ) {
          continue;
        }
        const alias = declaration.initializer.text;
        const modulePath = namespaceImportByAlias.get(alias);
        if (!modulePath) {
          continue;
        }
        const bindings: NamespaceBindingEntry[] = [];
        for (const element of declaration.name.elements) {
          if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
            continue;
          }
          const localName = element.name.text;
          const importedName = extractBindingImportedName(element, localName);
          bindings.push({ localName, importedName });
        }
        if (bindings.length < 1) {
          continue;
        }
        metadataByAlias.set(alias, {
          alias,
          modulePath,
          bindings,
          statement,
          declaration,
        });
      }
      return metadataByAlias;
    };
    const canRewriteNamespaceAliasReferences = (
      source: ts.SourceFile,
      alias: string,
      shapingDeclaration: ts.VariableDeclaration,
      bindingByImportedName: ReadonlyMap<string, string>,
    ): boolean => {
      let onlyAllowed = true;
      const visit = (node: ts.Node): void => {
        if (!onlyAllowed) {
          return;
        }
        if (ts.isIdentifier(node) && isIdentifierReference(node) && node.text === alias) {
          const parent = node.parent;
          const allowed = ts.isVariableDeclaration(parent) && parent === shapingDeclaration && parent.initializer === node;
          if (allowed) {
            ts.forEachChild(node, visit);
            return;
          }
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            if (bindingByImportedName.has(parent.name.text)) {
              ts.forEachChild(node, visit);
              return;
            }
          }
          if (ts.isElementAccessExpression(parent) && parent.expression === node && parent.argumentExpression) {
            const argument = parent.argumentExpression;
            const importedName = ts.isStringLiteralLike(argument)
              ? argument.text
              : ts.isIdentifier(argument)
                ? argument.text
                : "";
            if (importedName.length > 0 && bindingByImportedName.has(importedName)) {
              ts.forEachChild(node, visit);
              return;
            }
          }
          onlyAllowed = false;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return onlyAllowed;
    };
    const scoreNamespaceAliasForDirectImport = (metadata: NamespaceAliasMetadata): number => {
      const familyToken = resolveTargetedImportFamilyToken(metadata.modulePath);
      const familyPriorityScore: Record<string, number> = {
        runtime: 6,
        channel: 5,
        core: 4,
        language: 3,
        diagram: 2,
      };
      let score = familyPriorityScore[familyToken] ?? 1;
      if (metadata.modulePath.includes("/chunk-index-") || metadata.modulePath.includes("/chunk-chunk-")) {
        score += 2;
      }
      if (metadata.modulePath.includes("/chunks-ts/")) {
        score += 1;
      }
      if (metadata.bindings.length <= 4) {
        score += 3;
      } else if (metadata.bindings.length <= 8) {
        score += 1.5;
      } else {
        score -= 2;
      }
      let safeImportedCount = 0;
      for (const binding of metadata.bindings) {
        const importedName = binding.importedName;
        const safeIdentifier = importedName === "default" || isValidIdentifierImportName(importedName);
        if (!safeIdentifier) {
          score -= 3;
          continue;
        }
        const looksObfuscated =
          importedName !== "default" &&
          (OBFUSCATED_ALIAS_STYLE_PATTERN.test(importedName) ||
            importedName.length <= 3 ||
            importedName.includes("$") ||
            isLikelyObfuscatedAliasToken(importedName));
        if (!looksObfuscated) {
          safeImportedCount += 1;
        }
      }
      if (safeImportedCount > 0) {
        score += Math.min(3, safeImportedCount * 0.5);
      }
      for (const token of planDomainPriorityTokens) {
        if (metadata.modulePath.toLowerCase().includes(token.toLowerCase())) {
          score += 0.5;
        }
      }
      return score;
    };
    const buildPreferredDirectImportAliasSet = (source: ts.SourceFile): Set<string> => {
      if (!fullLiftFocusedStoreServiceModule) {
        return new Set<string>();
      }
      const metadataByAlias = collectNamespaceAliasMetadata(source);
      if (metadataByAlias.size < 1) {
        return new Set<string>();
      }
      const currentNamespaceCount = metadataByAlias.size;
      const targetNamespaceCount = targetedHotServiceModule ? 8 : targetedHotStoreG003Module ? 9 : 10;
      if (currentNamespaceCount <= targetNamespaceCount) {
        return new Set<string>();
      }
      const candidates: Array<{ alias: string; score: number }> = [];
      for (const metadata of metadataByAlias.values()) {
        const allBindingsImportable = metadata.bindings.every((binding) => {
          const importedName = binding.importedName;
          return importedName === "default" || isValidIdentifierImportName(importedName);
        });
        if (!allBindingsImportable) {
          continue;
        }
        const bindingByImportedName = new Map<string, string>();
        for (const binding of metadata.bindings) {
          if (binding.importedName === "default") {
            continue;
          }
          if (!bindingByImportedName.has(binding.importedName)) {
            bindingByImportedName.set(binding.importedName, binding.localName);
          }
        }
        if (!canRewriteNamespaceAliasReferences(source, metadata.alias, metadata.declaration, bindingByImportedName)) {
          continue;
        }
        const score = scoreNamespaceAliasForDirectImport(metadata);
        candidates.push({ alias: metadata.alias, score });
      }
      if (candidates.length < 1) {
        return new Set<string>();
      }
      const needed = Math.max(0, currentNamespaceCount - targetNamespaceCount);
      if (needed < 1) {
        return new Set<string>();
      }
      const selected = candidates
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return left.alias.localeCompare(right.alias);
        })
        .slice(0, needed)
        .map((entry) => entry.alias);
      return new Set<string>(selected);
    };
    const applyPreferredDirectImportConversion = (
      source: ts.SourceFile,
      preferredAliases: ReadonlySet<string>,
    ): string => {
      if (preferredAliases.size < 1) {
        return printer.printFile(source);
      }
      const metadataByAlias = collectNamespaceAliasMetadata(source);
      if (metadataByAlias.size < 1) {
        return printer.printFile(source);
      }
      const replacementImportByAlias = new Map<string, ts.ImportDeclaration>();
      const replacementAliasStatementsByAlias = new Map<string, ts.Statement[]>();
      const skippedAliases = new Set<string>();
      for (const alias of preferredAliases) {
        const metadata = metadataByAlias.get(alias);
        if (!metadata) {
          continue;
        }
        let defaultBindingLocalName = "";
        const duplicateDefaultAliasLocalNames: string[] = [];
        const namedLocalNameByImportedName = new Map<string, string>();
        const duplicateNamedAliasPairs: Array<{ aliasLocalName: string; sourceLocalName: string }> = [];
        const namedSpecifiers: ts.ImportSpecifier[] = [];
        for (const binding of metadata.bindings) {
          if (binding.importedName === "default") {
            if (defaultBindingLocalName.length < 1) {
              defaultBindingLocalName = binding.localName;
              continue;
            }
            if (binding.localName !== defaultBindingLocalName) {
              duplicateDefaultAliasLocalNames.push(binding.localName);
            }
            continue;
          }
          if (!isValidIdentifierImportName(binding.importedName)) {
            skippedAliases.add(alias);
            defaultBindingLocalName = "";
            break;
          }
          const existingNamedLocal = namedLocalNameByImportedName.get(binding.importedName);
          if (existingNamedLocal) {
            if (existingNamedLocal !== binding.localName) {
              duplicateNamedAliasPairs.push({
                aliasLocalName: binding.localName,
                sourceLocalName: existingNamedLocal,
              });
            }
            continue;
          }
          namedLocalNameByImportedName.set(binding.importedName, binding.localName);
          namedSpecifiers.push(
            binding.importedName === binding.localName
              ? ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(binding.localName))
              : ts.factory.createImportSpecifier(
                  false,
                  ts.factory.createIdentifier(binding.importedName),
                  ts.factory.createIdentifier(binding.localName),
                ),
          );
        }
        if (skippedAliases.has(alias)) {
          continue;
        }
        if (defaultBindingLocalName.length < 1 && namedSpecifiers.length < 1) {
          continue;
        }
        const aliasStatements: ts.Statement[] = [];
        for (const duplicateDefaultAliasLocalName of duplicateDefaultAliasLocalNames) {
          aliasStatements.push(
            ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [
                  ts.factory.createVariableDeclaration(
                    ts.factory.createIdentifier(duplicateDefaultAliasLocalName),
                    undefined,
                    undefined,
                    ts.factory.createIdentifier(defaultBindingLocalName),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            ),
          );
        }
        for (const duplicateNamedAliasPair of duplicateNamedAliasPairs) {
          aliasStatements.push(
            ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [
                  ts.factory.createVariableDeclaration(
                    ts.factory.createIdentifier(duplicateNamedAliasPair.aliasLocalName),
                    undefined,
                    undefined,
                    ts.factory.createIdentifier(duplicateNamedAliasPair.sourceLocalName),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            ),
          );
        }
        replacementAliasStatementsByAlias.set(alias, aliasStatements);
        const importClause = ts.factory.createImportClause(
          false,
          defaultBindingLocalName.length > 0 ? ts.factory.createIdentifier(defaultBindingLocalName) : undefined,
          namedSpecifiers.length > 0 ? ts.factory.createNamedImports(namedSpecifiers) : undefined,
        );
        replacementImportByAlias.set(
          alias,
          ts.factory.createImportDeclaration(
            undefined,
            importClause,
            ts.factory.createStringLiteral(metadata.modulePath),
            undefined,
          ),
        );
      }
      if (replacementImportByAlias.size < 1) {
        return printer.printFile(source);
      }
      const bindingByAlias = new Map<string, Map<string, string>>();
      for (const [alias, metadata] of metadataByAlias.entries()) {
        if (!replacementImportByAlias.has(alias)) {
          continue;
        }
        const bindingByImportedName = new Map<string, string>();
        for (const binding of metadata.bindings) {
          if (binding.importedName === "default") {
            continue;
          }
          if (!bindingByImportedName.has(binding.importedName)) {
            bindingByImportedName.set(binding.importedName, binding.localName);
          }
        }
        bindingByAlias.set(alias, bindingByImportedName);
      }
      const rewrittenResult = ts.transform(source, [
        (context) => {
          const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression) {
              const alias = node.expression.text;
              const bindingByImportedName = bindingByAlias.get(alias);
              if (bindingByImportedName) {
                const argument = node.argumentExpression;
                const importedName = ts.isStringLiteralLike(argument)
                  ? argument.text
                  : ts.isIdentifier(argument)
                    ? argument.text
                    : "";
                const localName = importedName.length > 0 ? bindingByImportedName.get(importedName) : undefined;
                if (localName && isValidIdentifierImportName(localName)) {
                  return ts.factory.createIdentifier(localName);
                }
              }
            }
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
              const alias = node.expression.text;
              const bindingByImportedName = bindingByAlias.get(alias);
              if (bindingByImportedName) {
                const localName = bindingByImportedName.get(node.name.text);
                if (localName && isValidIdentifierImportName(localName)) {
                  return ts.factory.createIdentifier(localName);
                }
              }
            }
            return ts.visitEachChild(node, visit, context);
          };
          return (file) => ts.visitNode(file, visit) as ts.SourceFile;
        },
      ]);
      const rewrittenSource = rewrittenResult.transformed[0];
      if (!rewrittenSource) {
        rewrittenResult.dispose();
        throw new Error(`buildQualityModuleContent: missing transformed source in preferred direct import conversion for ${plan.moduleId}`);
      }
      const nextStatements: ts.Statement[] = [];
      for (const statement of rewrittenSource.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const namedBindings = statement.importClause.namedBindings;
          if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            const alias = namedBindings.name.text;
            const replacement = replacementImportByAlias.get(alias);
            if (replacement) {
              nextStatements.push(replacement);
              const aliasStatements = replacementAliasStatementsByAlias.get(alias) ?? [];
              nextStatements.push(...aliasStatements);
              continue;
            }
          }
        }
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
          const declaration = statement.declarationList.declarations[0];
          if (
            declaration &&
            ts.isObjectBindingPattern(declaration.name) &&
            declaration.initializer &&
            ts.isIdentifier(declaration.initializer) &&
            replacementImportByAlias.has(declaration.initializer.text)
          ) {
            continue;
          }
        }
        nextStatements.push(statement);
      }
      const convertedSource = ts.factory.updateSourceFile(rewrittenSource, nextStatements);
      rewrittenResult.dispose();
      return printer.printFile(convertedSource);
    };
    const applySingleUseNamespaceAliasFallbackConversion = (contentText: string): string => {
      if (!fullLiftFocusedStoreServiceModule || contentText.length < 1) {
        return contentText;
      }
      const source = ts.createSourceFile(
        `${plan.moduleId}.ts`,
        contentText,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      const namespaceImports = new Map<string, { modulePath: string; statement: ts.ImportDeclaration }>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
          continue;
        }
        const namedBindings = statement.importClause.namedBindings;
        if (!namedBindings || !ts.isNamespaceImport(namedBindings)) {
          continue;
        }
        const moduleSpecifier = statement.moduleSpecifier;
        if (!ts.isStringLiteralLike(moduleSpecifier)) {
          continue;
        }
        namespaceImports.set(namedBindings.name.text, { modulePath: moduleSpecifier.text, statement });
      }
      const targetNamespaceCount = targetedHotServiceModule ? 8 : targetedHotStoreG003Module ? 9 : 10;
      if (namespaceImports.size <= targetNamespaceCount) {
        return contentText;
      }
      const aliasUsedByShaping = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
          continue;
        }
        const declaration = statement.declarationList.declarations[0];
        if (
          !declaration ||
          !ts.isObjectBindingPattern(declaration.name) ||
          !declaration.initializer ||
          !ts.isIdentifier(declaration.initializer)
        ) {
          continue;
        }
        aliasUsedByShaping.add(declaration.initializer.text);
      }
      interface AliasUseInfo {
        importedNames: Set<string>;
        unsupported: boolean;
      }
      const useInfoByAlias = new Map<string, AliasUseInfo>();
      for (const alias of namespaceImports.keys()) {
        useInfoByAlias.set(alias, { importedNames: new Set<string>(), unsupported: false });
      }
      const markUnsupported = (alias: string): void => {
        const entry = useInfoByAlias.get(alias);
        if (entry) {
          entry.unsupported = true;
        }
      };
      const recordImportedName = (alias: string, importedName: string): void => {
        const entry = useInfoByAlias.get(alias);
        if (!entry) {
          return;
        }
        if (!isValidIdentifierImportName(importedName)) {
          entry.unsupported = true;
          return;
        }
        entry.importedNames.add(importedName);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const alias = node.expression.text;
          if (useInfoByAlias.has(alias)) {
            recordImportedName(alias, node.name.text);
          }
        } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression) {
          const alias = node.expression.text;
          if (useInfoByAlias.has(alias)) {
            const argument = node.argumentExpression;
            const importedName = ts.isStringLiteralLike(argument)
              ? argument.text
              : ts.isIdentifier(argument)
                ? argument.text
                : "";
            if (importedName.length < 1) {
              markUnsupported(alias);
            } else {
              recordImportedName(alias, importedName);
            }
          }
        } else if (ts.isIdentifier(node) && isIdentifierReference(node)) {
          const alias = node.text;
          if (useInfoByAlias.has(alias)) {
            const parent = node.parent;
            const supported =
              (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
              (ts.isElementAccessExpression(parent) && parent.expression === node);
            if (!supported) {
              markUnsupported(alias);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      const candidates: Array<{ alias: string; importedName: string; modulePath: string; score: number }> = [];
      for (const [alias, importEntry] of namespaceImports.entries()) {
        if (aliasUsedByShaping.has(alias)) {
          continue;
        }
        const useInfo = useInfoByAlias.get(alias);
        if (!useInfo || useInfo.unsupported || useInfo.importedNames.size !== 1) {
          continue;
        }
        const importedName = [...useInfo.importedNames][0];
        if (!importedName || !isValidIdentifierImportName(importedName)) {
          continue;
        }
        const family = resolveTargetedImportFamilyToken(importEntry.modulePath);
        const familyPriority: Record<string, number> = {
          runtime: 5,
          channel: 4,
          core: 3,
          language: 2,
          diagram: 1,
        };
        let score = familyPriority[family] ?? 0;
        if (importEntry.modulePath.includes("/chunk-index-")) {
          score += 2;
        }
        if (!OBFUSCATED_ALIAS_STYLE_PATTERN.test(importedName) && !isLikelyObfuscatedAliasToken(importedName)) {
          score += 1.5;
        }
        candidates.push({ alias, importedName, modulePath: importEntry.modulePath, score });
      }
      if (candidates.length < 1) {
        return contentText;
      }
      const needed = Math.max(0, namespaceImports.size - targetNamespaceCount);
      if (needed < 1) {
        return contentText;
      }
      const selectedCandidates = candidates
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return left.alias.localeCompare(right.alias);
        })
        .slice(0, needed);
      if (selectedCandidates.length < 1) {
        return contentText;
      }
      const selectedByAlias = new Map<string, { importedName: string; modulePath: string; localName: string }>();
      const usedNames = new Set<string>(contentText.match(/\b[$A-Za-z_][$A-Za-z0-9_]*\b/g) ?? []);
      for (const candidate of selectedCandidates) {
        const baseLocalName = buildTargetedImportFamilyAliasBase(
          candidate.importedName,
          candidate.modulePath,
          candidate.importedName,
        );
        const localName = nextUniqueIdentifier(compactIdentifier(baseLocalName, 34), usedNames);
        selectedByAlias.set(candidate.alias, {
          importedName: candidate.importedName,
          modulePath: candidate.modulePath,
          localName,
        });
      }
      const transformedResult = ts.transform(source, [
        (context) => {
          const visitNode = (node: ts.Node): ts.VisitResult<ts.Node> => {
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
              const selected = selectedByAlias.get(node.expression.text);
              if (selected && node.name.text === selected.importedName) {
                return ts.factory.createIdentifier(selected.localName);
              }
            }
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression) {
              const selected = selectedByAlias.get(node.expression.text);
              if (selected) {
                const argument = node.argumentExpression;
                const importedName = ts.isStringLiteralLike(argument)
                  ? argument.text
                  : ts.isIdentifier(argument)
                    ? argument.text
                    : "";
                if (importedName === selected.importedName) {
                  return ts.factory.createIdentifier(selected.localName);
                }
              }
            }
            return ts.visitEachChild(node, visitNode, context);
          };
          return (file) => ts.visitNode(file, visitNode) as ts.SourceFile;
        },
      ]);
      const transformedSource = transformedResult.transformed[0];
      if (!transformedSource) {
        transformedResult.dispose();
        throw new Error(`buildQualityModuleContent: missing transformed source in single-use namespace fallback for ${plan.moduleId}`);
      }
      const nextStatements: ts.Statement[] = [];
      for (const statement of transformedSource.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const namedBindings = statement.importClause.namedBindings;
          if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            const alias = namedBindings.name.text;
            const selected = selectedByAlias.get(alias);
            if (selected) {
              nextStatements.push(
                ts.factory.createImportDeclaration(
                  undefined,
                  ts.factory.createImportClause(
                    false,
                    undefined,
                    ts.factory.createNamedImports([
                      ts.factory.createImportSpecifier(
                        false,
                        ts.factory.createIdentifier(selected.importedName),
                        ts.factory.createIdentifier(selected.localName),
                      ),
                    ]),
                  ),
                  ts.factory.createStringLiteral(selected.modulePath),
                  undefined,
                ),
              );
              continue;
            }
          }
        }
        nextStatements.push(statement);
      }
      const convertedSource = ts.factory.updateSourceFile(transformedSource, nextStatements);
      transformedResult.dispose();
      return printer.printFile(convertedSource);
    };
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const sourceFile = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      content,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const extractBindingImportedName = (element: ts.BindingElement, localName: string): string => {
      if (!element.propertyName) {
        return localName;
      }
      if (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)) {
        return element.propertyName.text;
      }
      return localName;
    };
    const preferredDirectImportAliases = buildPreferredDirectImportAliasSet(sourceFile);
    let sourceForCleanup = sourceFile;
    let contentForCleanup = content;
    if (fullLiftFocusedStoreServiceModule) {
      const initialReferenceCounts = collectIdentifierReferenceCounts(sourceFile);
      const inlineCandidatesByLocal = new Map<string, { namespaceAlias: string; importedName: string }>();
      const inlineUsageCeiling = targetedHotStoreG003Module ? 3 : 2;
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
          continue;
        }
        const declaration = statement.declarationList.declarations[0];
        if (!declaration) {
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer || !ts.isIdentifier(declaration.initializer)) {
          continue;
        }
        const namespaceAlias = declaration.initializer.text;
        if (preferredDirectImportAliases.has(namespaceAlias)) {
          continue;
        }
        for (const element of declaration.name.elements) {
          if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) {
            continue;
          }
          const localName = element.name.text;
          const usageCount = initialReferenceCounts.get(localName) ?? 0;
          const importedName = extractBindingImportedName(element, localName);
          const shouldInlineSingleUse = usageCount === 1;
          const shouldInlineMultiUseObfuscated =
            usageCount > 1 &&
            usageCount <= inlineUsageCeiling &&
            (OBFUSCATED_ALIAS_STYLE_PATTERN.test(importedName) ||
              importedName.length <= 4 ||
              importedName.includes("$"));
          if (!shouldInlineSingleUse && !shouldInlineMultiUseObfuscated) {
            continue;
          }
          if (importedName.length < 1 || importedName.length > 64) {
            continue;
          }
          inlineCandidatesByLocal.set(localName, { namespaceAlias, importedName });
        }
      }
      if (inlineCandidatesByLocal.size > 0) {
        const inlineTransformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
          const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
            if (ts.isIdentifier(node) && isIdentifierReference(node)) {
              const candidate = inlineCandidatesByLocal.get(node.text);
              if (candidate) {
                return ts.factory.createElementAccessExpression(
                  ts.factory.createIdentifier(candidate.namespaceAlias),
                  ts.factory.createStringLiteral(candidate.importedName),
                );
              }
            }
            return ts.visitEachChild(node, visit, context);
          };
          return (file) => ts.visitNode(file, visit) as ts.SourceFile;
        };
        const transformedResult = ts.transform(sourceFile, [inlineTransformer]);
        const transformedSourceFile = transformedResult.transformed[0];
        if (!transformedSourceFile) {
          transformedResult.dispose();
          throw new Error(`buildQualityModuleContent: missing transformed source in import-hygiene inline pass for ${plan.moduleId}`);
        }
        contentForCleanup = printer.printFile(transformedSourceFile);
        sourceForCleanup = ts.createSourceFile(
          `${plan.moduleId}.ts`,
          contentForCleanup,
          ts.ScriptTarget.ESNext,
          true,
          ts.ScriptKind.TS,
        );
        transformedResult.dispose();
      }
    }
    const namespaceImportAliases = new Set<string>();
    for (const statement of sourceForCleanup.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        continue;
      }
      const bindings = statement.importClause.namedBindings;
      if (!bindings || !ts.isNamespaceImport(bindings)) {
        continue;
      }
      namespaceImportAliases.add(bindings.name.text);
    }
    if (namespaceImportAliases.size < 1) {
      return contentForCleanup;
    }

    const referenceCounts = collectIdentifierReferenceCounts(sourceForCleanup);
    let shapingChanged = false;
    const shapedStatements: ts.Statement[] = [];
    for (const statement of sourceForCleanup.statements) {
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) {
        shapedStatements.push(statement);
        continue;
      }
      const declaration = statement.declarationList.declarations[0];
      if (!declaration) {
        shapedStatements.push(statement);
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer || !ts.isIdentifier(declaration.initializer)) {
        shapedStatements.push(statement);
        continue;
      }
      if (!namespaceImportAliases.has(declaration.initializer.text)) {
        shapedStatements.push(statement);
        continue;
      }
      const keptElements: ts.BindingElement[] = [];
      for (const element of declaration.name.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        if (!ts.isIdentifier(element.name)) {
          keptElements.push(element);
          continue;
        }
        const localName = element.name.text;
        const usageCount = referenceCounts.get(localName) ?? 0;
        if (usageCount > 0) {
          keptElements.push(element);
          continue;
        }
        shapingChanged = true;
      }
      if (keptElements.length < 1) {
        shapingChanged = true;
        continue;
      }
      if (keptElements.length === declaration.name.elements.length) {
        shapedStatements.push(statement);
        continue;
      }
      const updatedPattern = ts.factory.updateObjectBindingPattern(declaration.name, keptElements);
      const updatedDeclaration = ts.factory.updateVariableDeclaration(
        declaration,
        updatedPattern,
        declaration.exclamationToken,
        declaration.type,
        declaration.initializer,
      );
      const updatedDeclarationList = ts.factory.updateVariableDeclarationList(statement.declarationList, [updatedDeclaration]);
      shapedStatements.push(ts.factory.updateVariableStatement(statement, statement.modifiers, updatedDeclarationList));
    }
    const shapedContent = shapingChanged
      ? printer.printFile(ts.factory.updateSourceFile(sourceForCleanup, shapedStatements))
      : contentForCleanup;
    const importSource = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      shapedContent,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const importReferenceCounts = collectIdentifierReferenceCounts(importSource);
    let importChanged = false;
    const importFilteredStatements: ts.Statement[] = [];
    for (const statement of importSource.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        importFilteredStatements.push(statement);
        continue;
      }
      const bindings = statement.importClause.namedBindings;
      if (!bindings || !ts.isNamespaceImport(bindings)) {
        importFilteredStatements.push(statement);
        continue;
      }
      const alias = bindings.name.text;
      const usageCount = importReferenceCounts.get(alias) ?? 0;
      if (usageCount > 0) {
        importFilteredStatements.push(statement);
        continue;
      }
      importChanged = true;
    }
    if (!importChanged) {
      const directConverted = applyPreferredDirectImportConversion(importSource, preferredDirectImportAliases);
      return splitLongNamedImportDeclarations(
        demoteAssignedConstDeclarations(applySingleUseNamespaceAliasFallbackConversion(directConverted)),
      );
    }
    const importFilteredSource = ts.factory.updateSourceFile(importSource, importFilteredStatements);
    const directConverted = applyPreferredDirectImportConversion(importFilteredSource, preferredDirectImportAliases);
    return splitLongNamedImportDeclarations(
      demoteAssignedConstDeclarations(applySingleUseNamespaceAliasFallbackConversion(directConverted)),
    );
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

  const selectChunkStatementsByRoots = (
    metadata: LiftedChunkMetadata,
    chunkId: string,
    rootIdentifiers: string[],
  ): { selectedStatements: ts.Statement[]; requiredImportLocals: Set<string> } => {
    const selectedStatements = new Set<ts.Statement>();
    const requiredImportLocals = new Set<string>();
    const pending = [...new Set(rootIdentifiers)].sort((left, right) => left.localeCompare(right));
    while (pending.length > 0) {
      const identifier = pending.shift();
      if (!identifier) {
        continue;
      }
      const declarationStatement = metadata.statementByDeclaredName.get(identifier);
      if (!declarationStatement) {
        if (metadata.importBindings.has(identifier)) {
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
        if (metadata.statementByDeclaredName.has(ref) || metadata.importBindings.has(ref)) {
          pending.push(ref);
        }
      }
    }
    const orderedStatements = metadata.sourceFile.statements.filter((statement) => selectedStatements.has(statement));
    return {
      selectedStatements: orderedStatements,
      requiredImportLocals,
    };
  };

  const stripExportModifiers = (statement: ts.Statement): ts.Statement | undefined => {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      return undefined;
    }
    const hasExportLikeModifier = (node: ts.Node): boolean => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      if (!modifiers || modifiers.length < 1) {
        return false;
      }
      return modifiers.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
    };
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
      if (!hasExportLikeModifier(statement)) {
        return statement;
      }
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
      if (!hasExportLikeModifier(statement)) {
        return statement;
      }
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
      if (!hasExportLikeModifier(statement)) {
        return statement;
      }
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
    const usedAliases = new Set<string>([...dependencyAliasNames, ...assetImportsByPath.values()]);
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
      const defaultMinLength = isThemeOrGrammarIdentifier(declaration.name.text)
        ? STATIC_PAYLOAD_THEME_GRAMMAR_MIN_LENGTH
        : STATIC_PAYLOAD_LITERAL_MIN_LENGTH;
      const targetedG003JsonPayload =
        targetedHotStoreG003Module &&
        (initializerText.includes("JSON.parse(") || initializerText.includes("Object.freeze("));
      const minLength = targetedG003JsonPayload ? Math.min(defaultMinLength, 700) : defaultMinLength;
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

  const buildChunkLocalAliasBase = (
    chunkId: string,
    sourceIdentifier: string,
    preferredName: string,
  ): string => {
    const preferredTokens = sanitizeAliasTokens(splitNameTokens(preferredName));
    const sourceTokens = sanitizeAliasTokens(splitNameTokens(sourceIdentifier));
    const chunkTokens = chunkTopicTokensById.get(chunkId) ?? chunkTokensFromChunkId(chunkId);
    const semanticTokens = dedupeNameTokens([
      ...preferredTokens,
      ...sourceTokens,
      ...sanitizeAliasTokens(chunkTokens),
      ...planAliasDomainTokens,
    ]).slice(0, 3);
    const stem = semanticTokens.length > 0 ? semanticTokens.map((token) => toPascalCase(token)).join("") : "Domain";
    const sourceTokenTag = buildStableAliasTag(sourceIdentifier, "node");
    const shouldTagSource =
      sourceTokens.length < 1 ||
      preferredTokens.length < 1 ||
      sourceIdentifier.length <= 2 ||
      OBFUSCATED_ALIAS_STYLE_PATTERN.test(sourceIdentifier) ||
      isWeakAliasStem(semanticTokens);
    const baseStem = shouldTagSource ? `${stem}${sourceTokenTag}` : stem;
    const base = compactIdentifier(sanitizeIdentifier(`${plan.archetype}${baseStem}Node`), 42);
    if (!isNoisyIdentifier(base) && !OBFUSCATED_ALIAS_STYLE_PATTERN.test(base)) {
      return base;
    }
    const fallbackTokens = sanitizeAliasTokens([plan.topic, ...chunkTokens]);
    const fallbackChunk = toPascalCase(fallbackTokens[0] ?? fallbackTopicByArchetype(plan.archetype));
    return compactIdentifier(sanitizeIdentifier(`${plan.archetype}${fallbackChunk}Member`), 36);
  };

  const buildChunkImportAliasBase = (
    chunkId: string,
    modulePath: string,
    importedName: string,
  ): string => {
    const moduleTokens = isChunkIndexModulePath(modulePath)
      ? []
      : sanitizeImportAliasTokens(splitNameTokens(path.basename(modulePath)));
    const importedTokens = sanitizeImportAliasTokens(splitNameTokens(importedName));
    const importedTokenTag = buildStableAliasTag(importedName, "dep");
    const chunkTokens = chunkTopicTokensById.get(chunkId) ?? chunkTokensFromChunkId(chunkId);
    const semanticTokens = dedupeNameTokens([
      ...moduleTokens,
      ...importedTokens,
      ...sanitizeImportAliasTokens(chunkTokens),
      ...sanitizeImportAliasTokens(planAliasDomainTokens),
    ]).slice(0, 2);
    const stem = semanticTokens.length > 0 ? semanticTokens.map((token) => toPascalCase(token)).join("") : "Dependency";
    const prefix = IMPORT_ALIAS_PREFIX_BY_ARCHETYPE[plan.archetype];
    const shouldTagImportedName =
      isChunkIndexModulePath(modulePath) ||
      importedTokens.length < 1 ||
      importedName.length <= 2 ||
      OBFUSCATED_ALIAS_STYLE_PATTERN.test(importedName) ||
      isWeakAliasStem(semanticTokens);
    const baseStem = shouldTagImportedName ? `${stem}${importedTokenTag}` : stem;
    const normalizedStem = baseStem.endsWith("Dep") ? baseStem : `${baseStem}Dep`;
    const base = compactIdentifier(sanitizeIdentifier(`${prefix}${normalizedStem}`), 34);
    if (!isNoisyIdentifier(base) && !OBFUSCATED_ALIAS_STYLE_PATTERN.test(base)) {
      return base;
    }
    return compactIdentifier(sanitizeIdentifier(`${prefix}Dependency`), 24);
  };

  const resolveModuleNamespaceAlias = (modulePath: string): string => {
    const existingAlias = moduleNamespaceAliasByModulePath.get(modulePath);
    if (existingAlias) {
      return existingAlias;
    }
    const basename = path.basename(modulePath).replace(/\.[cm]?[jt]sx?$/i, "");
    const tokens = splitNameTokens(basename)
      .filter((token) => token.length >= 3)
      .filter((token) => !IMPORT_CHAIN_NOISE_TOKENS.has(token))
      .filter((token) => !DOMAIN_ALIAS_WEAK_TOKENS.has(token))
      .filter((token) => !/^[a-f0-9]{6,}$/i.test(token))
      .filter((token) => !/^[a-z]{18,}$/.test(token))
      .filter((token) => !token.includes("abcdefghijklmnopqrstuvwxyz"))
      .filter((token) => !/\d/.test(token))
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token))
      .slice(0, 2);
    const prefix = IMPORT_ALIAS_PREFIX_BY_ARCHETYPE[plan.archetype];
    const suffix = tokens.length > 0 ? tokens.map((token) => toPascalCase(token)).join("") : "ChunkIndex";
    const aliasBase = compactIdentifier(sanitizeIdentifier(`${prefix}${suffix}Chunk`), 32);
    const usedAliases = new Set<string>([
      ...dependencyAliasNames,
      ...assetImportsByPath.values(),
      ...moduleNamespaceAliasByModulePath.values(),
    ]);
    const resolvedAlias = nextUniqueIdentifier(aliasBase, usedAliases);
    moduleNamespaceAliasByModulePath.set(modulePath, resolvedAlias);
    dependencyAliasNames.add(resolvedAlias);
    dependencyImportLines.add(`import * as ${resolvedAlias} from ${quote(modulePath)};`);
    return resolvedAlias;
  };

  const isChunkTsModulePath = (modulePath: string): boolean => modulePath.includes("/chunks-ts/");
  const shouldUseNamespaceImportShaping = (modulePath: string, importedName: string): boolean => {
    const chunkTsModulePath = isChunkTsModulePath(modulePath);
    const chunkIndexModulePath = isChunkIndexModulePath(modulePath);
    if (!chunkTsModulePath && !chunkIndexModulePath) {
      return false;
    }
    if (!plan.hotPriority) {
      return false;
    }
    if (OBFUSCATED_ALIAS_STYLE_PATTERN.test(importedName)) {
      return true;
    }
    if (importedName.includes("$")) {
      return true;
    }
    if (/^[a-z][A-Z]$/.test(importedName)) {
      return true;
    }
    return chunkIndexModulePath || chunkTsModulePath;
  };

  const registerDependencyImportNeed = (need: ChunkImportNeed): void => {
    const moduleSpecifier = quote(need.modulePath);
    if (need.kind === "namespace") {
      dependencyAliasNames.add(need.localName);
      dependencyImportLines.add(`import * as ${need.localName} from ${moduleSpecifier};`);
      return;
    }
    if (need.kind === "default") {
      if (isChunkTsModulePath(need.modulePath)) {
        const namespaceAlias = resolveModuleNamespaceAlias(need.modulePath);
        dependencyAliasNames.add(need.localName);
        const bindings = moduleNamespaceBindingsByAlias.get(namespaceAlias) ?? new Map<string, string>();
        bindings.set(need.localName, "default");
        moduleNamespaceBindingsByAlias.set(namespaceAlias, bindings);
        return;
      }
      dependencyAliasNames.add(need.localName);
      dependencyImportLines.add(`import ${need.localName} from ${moduleSpecifier};`);
      return;
    }
    if (shouldUseNamespaceImportShaping(need.modulePath, need.importedName)) {
      const namespaceAlias = resolveModuleNamespaceAlias(need.modulePath);
      dependencyAliasNames.add(need.localName);
      const bindings = moduleNamespaceBindingsByAlias.get(namespaceAlias) ?? new Map<string, string>();
      bindings.set(need.localName, need.importedName);
      moduleNamespaceBindingsByAlias.set(namespaceAlias, bindings);
      return;
    }
    if (need.importedName === need.localName) {
      dependencyAliasNames.add(need.localName);
      dependencyImportLines.add(`import { ${need.importedName} } from ${moduleSpecifier};`);
      return;
    }
    dependencyAliasNames.add(need.localName);
    dependencyImportLines.add(`import { ${need.importedName} as ${need.localName} } from ${moduleSpecifier};`);
  };

  const createChunkLiftedDeclarations = (
    chunkId: string,
    requiredSourceIdentifiers: string[],
    preferredLocalNameBySourceIdentifier: ReadonlyMap<string, string>,
  ): {
    declarationText: string;
    sourceIdentifierByOriginal: Map<string, string>;
    importNeeds: ChunkImportNeed[];
  } => {
    const sourceChunkMetadata = resolveLiftedChunkMetadata(chunkId);
    const selection = selectChunkStatementsByRoots(sourceChunkMetadata, chunkId, requiredSourceIdentifiers);
    const selectedStatements = new Set<ts.Statement>(selection.selectedStatements);
    const requiredImportLocals = new Set<string>(selection.requiredImportLocals);
    const extremeChunkSelection =
      selection.selectedStatements.length >= HEAVY_CHUNK_IMPORT_FALLBACK_STATEMENT_THRESHOLD ||
      requiredImportLocals.size >= HEAVY_CHUNK_IMPORT_FALLBACK_IDENTIFIER_THRESHOLD;
    const targetedHotFullLiftEnabled = fullLiftFocusedStoreServiceModule;
    const targetedHotAggressiveFullLift = fullLiftFocusedStoreServiceModule;
    const targetedHotUltraFullLift = fullLiftFocusedStoreServiceModule;
    const targetedHotServiceSafeLift = targetedHotServiceModule;
    const disableBulkChunkIndexInline = targetedHotStoreModule;
    const strictFullLiftDeclarationsOnly = true;
    const preferChunkImportFallback =
      !strictFullLiftDeclarationsOnly &&
      (plan.archetype === "service" || plan.archetype === "store") &&
      extremeChunkSelection &&
      !targetedHotFullLiftEnabled;
    const allowChunkIndexInline = targetedHotFullLiftEnabled;
    const chunkIndexInlineImportThreshold = targetedHotUltraFullLift
      ? 1
      : targetedHotAggressiveFullLift
        ? 2
        : CHUNK_INDEX_INLINE_IMPORT_THRESHOLD;
    const chunkIndexInlineMaxNeedsPerModule = targetedHotFullLiftEnabled
      ? Math.max(CHUNK_INDEX_INLINE_MAX_NEEDS_PER_MODULE, targetedHotUltraFullLift ? 144 : targetedHotAggressiveFullLift ? 104 : 72)
      : CHUNK_INDEX_INLINE_MAX_NEEDS_PER_MODULE;
    const chunkIndexInlineMaxNeedsPerChunk = targetedHotFullLiftEnabled
      ? Math.max(CHUNK_INDEX_INLINE_MAX_NEEDS_PER_CHUNK, targetedHotUltraFullLift ? 40 : targetedHotAggressiveFullLift ? 24 : 16)
      : CHUNK_INDEX_INLINE_MAX_NEEDS_PER_CHUNK;
    const targetedInlineMaxNeedsPerModule = targetedHotFullLiftEnabled
      ? targetedHotUltraFullLift
        ? 128
        : targetedHotAggressiveFullLift
          ? 76
          : 48
      : TARGETED_CHUNK_INDEX_INLINE_MAX_NEEDS_PER_MODULE;
    const targetedInlineMaxNeedsPerChunk = targetedHotFullLiftEnabled
      ? targetedHotUltraFullLift
        ? 40
        : targetedHotAggressiveFullLift
          ? 24
          : 16
      : TARGETED_CHUNK_INDEX_INLINE_MAX_NEEDS_PER_TARGET_CHUNK;
    const targetedInlineMaxSelectedStatements = targetedHotFullLiftEnabled
      ? targetedHotUltraFullLift
        ? 84
        : targetedHotAggressiveFullLift
          ? 56
          : 36
      : TARGETED_CHUNK_INDEX_INLINE_MAX_SELECTED_STATEMENTS;
    const targetedInlineMaxDeclarationChars = targetedHotFullLiftEnabled
      ? targetedHotUltraFullLift
        ? 96000
        : targetedHotAggressiveFullLift
          ? 64000
          : 42000
      : TARGETED_CHUNK_INDEX_INLINE_MAX_DECLARATION_CHARS;
    const targetedInlineMaxRequiredImports = targetedHotFullLiftEnabled
      ? targetedHotUltraFullLift
        ? 104
        : targetedHotAggressiveFullLift
          ? 64
          : 40
      : TARGETED_CHUNK_INDEX_INLINE_MAX_REQUIRED_IMPORTS;
    const plannerPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

    const inlineDependencyStatements: ts.Statement[] = [];
    const inlineDependencyStatementSources: ts.SourceFile[] = [];
    const pushInlineDependencyStatement = (statement: ts.Statement, sourceFile: ts.SourceFile): void => {
      inlineDependencyStatements.push(statement);
      inlineDependencyStatementSources.push(sourceFile);
    };
    const pushInlineDependencyStatements = (statements: readonly ts.Statement[], sourceFile: ts.SourceFile): void => {
      for (const statement of statements) {
        pushInlineDependencyStatement(statement, sourceFile);
      }
    };
    const inlinedTargetStatementKeys = new Set<string>();
    const hasUnsafeStaticPayloadStatement = (statement: ts.Statement, sourceFile: ts.SourceFile): boolean => {
      if (!ts.isVariableStatement(statement)) {
        return false;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          continue;
        }
        const initializer = unwrapLiteralExpression(declaration.initializer);
        if (!isStaticLiteralExpression(initializer)) {
          continue;
        }
        const initializerText = plannerPrinter.printNode(ts.EmitHint.Unspecified, initializer, sourceFile).trim();
        if (initializerText.length >= STATIC_PAYLOAD_THEME_GRAMMAR_MIN_LENGTH) {
          return true;
        }
      }
      return false;
    };
    const hasChunkRuntimeBootstrapPattern = (statement: ts.Statement, sourceFile: ts.SourceFile): boolean => {
      const rendered = plannerPrinter.printNode(ts.EmitHint.Unspecified, statement, sourceFile);
      return rendered.includes("__vite__mapDeps") || rendered.includes("modulepreload");
    };
    const hasFunctionAssignmentConflict = (statements: readonly ts.Statement[]): boolean => {
      const functionNames = new Set<string>();
      for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          functionNames.add(statement.name.text);
        }
      }
      if (functionNames.size < 1) {
        return false;
      }
      const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
        kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      const containsConflict = (node: ts.Node): boolean => {
        if (
          ts.isBinaryExpression(node) &&
          isAssignmentOperatorKind(node.operatorToken.kind) &&
          ts.isIdentifier(node.left) &&
          functionNames.has(node.left.text)
        ) {
          return true;
        }
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          ts.isIdentifier(node.operand) &&
          functionNames.has(node.operand.text)
        ) {
          return true;
        }
        let found = false;
        ts.forEachChild(node, (child) => {
          if (!found && containsConflict(child)) {
            found = true;
          }
        });
        return found;
      };
      for (const statement of statements) {
        if (containsConflict(statement)) {
          return true;
        }
      }
      return false;
    };
    const countIdentifierReferencesInStatement = (statement: ts.Statement, identifier: string): number => {
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && isIdentifierReference(node) && node.text === identifier) {
          count += 1;
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
      return count;
    };
    const selectedSourceStatements = [...selection.selectedStatements];
    const localUsageCountByImportName = new Map<string, number>();
    for (const importLocal of requiredImportLocals) {
      let usageCount = 0;
      for (const statement of selectedSourceStatements) {
        usageCount += countIdentifierReferencesInStatement(statement, importLocal);
      }
      localUsageCountByImportName.set(importLocal, usageCount);
    }
    const chunkIndexImportLocals = [...requiredImportLocals]
      .map((localName) => {
        const binding = sourceChunkMetadata.importBindings.get(localName);
        if (!binding || binding.kind !== "named") {
          return undefined;
        }
        const modulePath = normalizeChunkImportPath(chunkId, binding.moduleSpecifier);
        if (!isChunkIndexModulePath(modulePath)) {
          return undefined;
        }
        return {
          localName,
          modulePath,
          importedName: binding.importedName,
        };
      })
      .filter((entry): entry is { localName: string; modulePath: string; importedName: string } => Boolean(entry));
    if (
      allowChunkIndexInline &&
      !disableBulkChunkIndexInline &&
      !preferChunkImportFallback &&
      chunkIndexImportLocals.length >= chunkIndexInlineImportThreshold
    ) {
      const selectedChunkIndexImportLocals = chunkIndexImportLocals
        .sort((left, right) => {
          const leftUsage = localUsageCountByImportName.get(left.localName) ?? 0;
          const rightUsage = localUsageCountByImportName.get(right.localName) ?? 0;
          const leftScore =
            (OBFUSCATED_ALIAS_STYLE_PATTERN.test(left.importedName) ? 2 : 0) +
            (left.importedName.length <= 2 ? 1 : 0) +
            Math.min(8, leftUsage) * 0.2;
          const rightScore =
            (OBFUSCATED_ALIAS_STYLE_PATTERN.test(right.importedName) ? 2 : 0) +
            (right.importedName.length <= 2 ? 1 : 0) +
            Math.min(8, rightUsage) * 0.2;
          if (leftScore !== rightScore) {
            return rightScore - leftScore;
          }
          return left.localName.localeCompare(right.localName);
        })
        .slice(0, chunkIndexInlineMaxNeedsPerModule);
      const needsByTargetChunkId = new Map<string, Array<{ localName: string; importedName: string }>>();
      for (const candidate of selectedChunkIndexImportLocals) {
        const targetChunkId = chunkIdFromChunkModulePath(candidate.modulePath);
        const bucket = needsByTargetChunkId.get(targetChunkId) ?? [];
        bucket.push({
          localName: candidate.localName,
          importedName: candidate.importedName,
        });
        needsByTargetChunkId.set(targetChunkId, bucket);
      }

      for (const [targetChunkId, rawNeeds] of needsByTargetChunkId.entries()) {
        const needs = rawNeeds.slice(0, chunkIndexInlineMaxNeedsPerChunk);
        const targetChunkMetadata = resolveLiftedChunkMetadata(targetChunkId);
        const localNameByRootIdentifier = new Map<string, string>();
        for (const need of needs) {
          const rootIdentifier =
            targetChunkMetadata.exportLocalByExportedName.get(need.importedName) ??
            (targetChunkMetadata.statementByDeclaredName.has(need.importedName) ? need.importedName : undefined);
          if (!rootIdentifier) {
            continue;
          }
          if (!localNameByRootIdentifier.has(rootIdentifier)) {
            localNameByRootIdentifier.set(rootIdentifier, need.localName);
          }
        }
        if (localNameByRootIdentifier.size < 1) {
          continue;
        }
        const targetSelection = selectChunkStatementsByRoots(
          targetChunkMetadata,
          targetChunkId,
          [...localNameByRootIdentifier.keys()],
        );
        const normalizedTargetStatements = targetSelection.selectedStatements
          .map((statement) => stripExportModifiers(statement))
          .filter((statement): statement is ts.Statement => Boolean(statement));
        const hasUnsafeInlinePayloadOrBootstrap = normalizedTargetStatements.some(
          (statement) =>
            hasUnsafeStaticPayloadStatement(statement, targetChunkMetadata.sourceFile) ||
            hasChunkRuntimeBootstrapPattern(statement, targetChunkMetadata.sourceFile),
        );
        if (hasUnsafeInlinePayloadOrBootstrap) {
          continue;
        }
        if (targetedHotServiceSafeLift && normalizedTargetStatements.some((statement) => ts.isFunctionDeclaration(statement))) {
          continue;
        }
        if (hasFunctionAssignmentConflict(normalizedTargetStatements)) {
          continue;
        }
        pushInlineDependencyStatements(normalizedTargetStatements, targetChunkMetadata.sourceFile);
        for (const [rootIdentifier, localName] of localNameByRootIdentifier.entries()) {
          if (rootIdentifier === localName) {
            continue;
          }
          pushInlineDependencyStatement(
            ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [
                  ts.factory.createVariableDeclaration(
                    ts.factory.createIdentifier(localName),
                    undefined,
                    undefined,
                    ts.factory.createIdentifier(rootIdentifier),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            ),
            sourceChunkMetadata.sourceFile,
          );
        }
        for (const requiredImportLocal of targetSelection.requiredImportLocals) {
          requiredImportLocals.add(requiredImportLocal);
        }
        for (const need of needs) {
          requiredImportLocals.delete(need.localName);
        }
      }
    }

    const remainingChunkIndexImportLocals = [...requiredImportLocals]
      .map((localName) => {
        const binding = sourceChunkMetadata.importBindings.get(localName);
        if (!binding || binding.kind !== "named") {
          return undefined;
        }
        const modulePath = normalizeChunkImportPath(chunkId, binding.moduleSpecifier);
        if (!isChunkIndexModulePath(modulePath)) {
          return undefined;
        }
        return {
          localName,
          modulePath,
          importedName: binding.importedName,
        };
      })
      .filter((entry): entry is { localName: string; modulePath: string; importedName: string } => Boolean(entry));

    const targetedChunkIndexCandidates = new Map<
      string,
      Array<{ localName: string; importedName: string }>
    >();
    for (const need of remainingChunkIndexImportLocals) {
      const targetChunkId = chunkIdFromChunkModulePath(need.modulePath);
      const bucket = targetedChunkIndexCandidates.get(targetChunkId) ?? [];
      bucket.push({
        localName: need.localName,
        importedName: need.importedName,
      });
      targetedChunkIndexCandidates.set(targetChunkId, bucket);
    }
    if (allowChunkIndexInline && targetedChunkIndexCandidates.size > 0) {
      const selectedTargetedInlines: Array<{
        targetChunkId: string;
        localName: string;
        rootIdentifier: string;
        statements: ts.Statement[];
        requiredImportLocals: Set<string>;
        sourceFile: ts.SourceFile;
        score: number;
      }> = [];
      for (const [targetChunkId, rawNeeds] of targetedChunkIndexCandidates.entries()) {
        const targetChunkMetadata = resolveLiftedChunkMetadata(targetChunkId);
        const needs = [...rawNeeds]
          .sort((left, right) => {
            const leftUsage = localUsageCountByImportName.get(left.localName) ?? 0;
            const rightUsage = localUsageCountByImportName.get(right.localName) ?? 0;
            if (leftUsage !== rightUsage) {
              return rightUsage - leftUsage;
            }
            return left.localName.localeCompare(right.localName);
          })
          .slice(0, targetedInlineMaxNeedsPerChunk);
        for (const need of needs) {
          const rootIdentifier =
            targetChunkMetadata.exportLocalByExportedName.get(need.importedName) ??
            (targetChunkMetadata.statementByDeclaredName.has(need.importedName) ? need.importedName : undefined);
          if (!rootIdentifier) {
            continue;
          }
          const targetedSelection = selectChunkStatementsByRoots(targetChunkMetadata, targetChunkId, [rootIdentifier]);
          if (targetedSelection.selectedStatements.length < 1) {
            continue;
          }
          if (targetedSelection.selectedStatements.length > targetedInlineMaxSelectedStatements) {
            continue;
          }
          if (targetedSelection.requiredImportLocals.size > targetedInlineMaxRequiredImports) {
            continue;
          }
          const normalizedTargetStatements = targetedSelection.selectedStatements
            .map((statement) => stripExportModifiers(statement))
            .filter((statement): statement is ts.Statement => Boolean(statement));
          if (normalizedTargetStatements.length < 1) {
            continue;
          }
          if (targetedHotServiceSafeLift && normalizedTargetStatements.some((statement) => ts.isFunctionDeclaration(statement))) {
            continue;
          }
          if (hasFunctionAssignmentConflict(normalizedTargetStatements)) {
            continue;
          }
          let declarationChars = 0;
          let unsafePayload = false;
          let runtimeBootstrap = false;
          const declaredNames = new Set<string>();
          for (const statement of normalizedTargetStatements) {
            declarationChars += plannerPrinter.printNode(ts.EmitHint.Unspecified, statement, targetChunkMetadata.sourceFile).length;
            if (hasUnsafeStaticPayloadStatement(statement, targetChunkMetadata.sourceFile)) {
              unsafePayload = true;
              break;
            }
            if (hasChunkRuntimeBootstrapPattern(statement, targetChunkMetadata.sourceFile)) {
              runtimeBootstrap = true;
              break;
            }
            const names = collectStatementDeclaredNames(statement);
            for (const name of names) {
              declaredNames.add(name);
            }
          }
          if (unsafePayload || runtimeBootstrap) {
            continue;
          }
          if (declarationChars > targetedInlineMaxDeclarationChars) {
            continue;
          }
          let hasCollision = false;
          for (const declaredName of declaredNames) {
            if (sourceChunkMetadata.statementByDeclaredName.has(declaredName)) {
              hasCollision = true;
              break;
            }
          }
          if (hasCollision) {
            continue;
          }
          const score =
            (OBFUSCATED_ALIAS_STYLE_PATTERN.test(need.importedName) ? 0.4 : 0) +
            (need.importedName.length <= 2 ? 0.2 : 0) +
            Math.min(8, localUsageCountByImportName.get(need.localName) ?? 0) * 0.08 +
            Math.max(0, 1 - declarationChars / targetedInlineMaxDeclarationChars);
          selectedTargetedInlines.push({
            targetChunkId,
            localName: need.localName,
            rootIdentifier,
            statements: normalizedTargetStatements,
            requiredImportLocals: targetedSelection.requiredImportLocals,
            sourceFile: targetChunkMetadata.sourceFile,
            score,
          });
        }
      }
      selectedTargetedInlines
        .sort((left, right) => {
          if (left.score !== right.score) {
            return right.score - left.score;
          }
          if (left.targetChunkId !== right.targetChunkId) {
            return left.targetChunkId.localeCompare(right.targetChunkId);
          }
          return left.localName.localeCompare(right.localName);
        })
        .slice(0, targetedInlineMaxNeedsPerModule)
        .forEach((candidate) => {
          for (const statement of candidate.statements) {
            const statementKey = plannerPrinter.printNode(
              ts.EmitHint.Unspecified,
              statement,
              candidate.sourceFile,
            );
            if (inlinedTargetStatementKeys.has(statementKey)) {
              continue;
            }
            inlinedTargetStatementKeys.add(statementKey);
            pushInlineDependencyStatement(statement, candidate.sourceFile);
          }
          if (candidate.rootIdentifier !== candidate.localName) {
            pushInlineDependencyStatement(
              ts.factory.createVariableStatement(
                undefined,
                ts.factory.createVariableDeclarationList(
                  [
                    ts.factory.createVariableDeclaration(
                      ts.factory.createIdentifier(candidate.localName),
                      undefined,
                      undefined,
                      ts.factory.createIdentifier(candidate.rootIdentifier),
                    ),
                  ],
                  ts.NodeFlags.Const,
                ),
              ),
              sourceChunkMetadata.sourceFile,
            );
          }
          for (const requiredImportLocal of candidate.requiredImportLocals) {
            requiredImportLocals.add(requiredImportLocal);
          }
          requiredImportLocals.delete(candidate.localName);
        });
    }

    const sourceIdentifierByOriginal = new Map<string, string>();
    const requiredSourceIdentifierSet = new Set<string>(requiredSourceIdentifiers);
    const chunkUsedNames = new Set<string>(usedTopLevelNames);
    const renameMap = new Map<string, string>();
    const sortedRequiredSourceIdentifiers = [...new Set(requiredSourceIdentifiers)].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const sourceIdentifier of sortedRequiredSourceIdentifiers) {
      const preferredName = preferredLocalNameBySourceIdentifier.get(sourceIdentifier) ?? sourceIdentifier;
      const base = buildChunkLocalAliasBase(chunkId, sourceIdentifier, preferredName);
      const resolved = nextUniqueIdentifier(base, chunkUsedNames);
      renameMap.set(sourceIdentifier, resolved);
      sourceIdentifierByOriginal.set(sourceIdentifier, resolved);
    }
    for (const localName of [...requiredImportLocals].sort((left, right) => left.localeCompare(right))) {
      if (renameMap.has(localName)) {
        continue;
      }
      const binding = sourceChunkMetadata.importBindings.get(localName);
      if (!binding) {
        throw new Error(`buildQualityModuleContent: missing import binding "${localName}" in chunk ${chunkId}`);
      }
      const modulePath = normalizeChunkImportPath(chunkId, binding.moduleSpecifier);
      const base = buildChunkImportAliasBase(chunkId, modulePath, binding.importedName);
      const resolved = nextUniqueIdentifier(base, chunkUsedNames);
      renameMap.set(localName, resolved);
    }
    for (const statement of selectedStatements) {
      const declaredNames = collectStatementDeclaredNames(statement);
      for (const declaredName of [...declaredNames].sort((left, right) => left.localeCompare(right))) {
        if (renameMap.has(declaredName)) {
          continue;
        }
        const base = buildChunkLocalAliasBase(chunkId, declaredName, declaredName);
        const resolved = nextUniqueIdentifier(base, chunkUsedNames);
        renameMap.set(declaredName, resolved);
      }
    }
    for (const statement of inlineDependencyStatements) {
      const declaredNames = collectStatementDeclaredNames(statement);
      for (const declaredName of [...declaredNames].sort((left, right) => left.localeCompare(right))) {
        if (renameMap.has(declaredName)) {
          continue;
        }
        const base = targetedHotLocalRenameEnabled
          ? buildTargetedHotLocalAliasBase(declaredName, declaredName, chunkId, "local")
          : buildChunkLocalAliasBase(chunkId, declaredName, declaredName);
        const resolved = nextUniqueIdentifier(base, chunkUsedNames);
        renameMap.set(declaredName, resolved);
      }
    }

    let finalRenameMap = renameMap;
    if (targetedHotLocalRenameEnabled) {
      const remapped = new Map<string, string>();
      const remapUsedNames = new Set<string>(usedTopLevelNames);
      for (const originalName of [...renameMap.keys()].sort((left, right) => left.localeCompare(right))) {
        const currentName = renameMap.get(originalName) ?? originalName;
        const binding = sourceChunkMetadata.importBindings.get(originalName);
        const aliasKind: "import" | "local" = binding ? "import" : "local";
        const base = binding
          ? buildTargetedImportFamilyAliasBase(
              buildTargetedHotImportAliasBase(
                currentName,
                originalName,
                chunkId,
                normalizeChunkImportPath(chunkId, binding.moduleSpecifier),
                binding.importedName,
              ),
              normalizeChunkImportPath(chunkId, binding.moduleSpecifier),
              binding.importedName,
            )
          : buildTargetedHotLocalAliasBase(currentName, originalName, chunkId, aliasKind);
        const normalizedBase = normalizeTargetedAliasBase(base);
        const stabilizedBase = stabilizeTargetedAliasEntropy(normalizedBase, `${chunkId}:${originalName}`);
        const resolved = nextUniqueIdentifier(compactIdentifier(stabilizedBase, 34), remapUsedNames);
        remapped.set(originalName, resolved);
      }
      finalRenameMap = remapped;
    }
    for (const sourceIdentifier of sortedRequiredSourceIdentifiers) {
      const resolved = finalRenameMap.get(sourceIdentifier) ?? sourceIdentifier;
      sourceIdentifierByOriginal.set(sourceIdentifier, resolved);
    }
    for (const name of finalRenameMap.values()) {
      usedTopLevelNames.add(name);
    }

    const importNeeds: ChunkImportNeed[] = [...requiredImportLocals]
      .sort((left, right) => left.localeCompare(right))
      .map((localName) => {
        const binding = sourceChunkMetadata.importBindings.get(localName);
        if (!binding) {
          throw new Error(`buildQualityModuleContent: missing import binding "${localName}" in chunk ${chunkId}`);
        }
        const resolvedLocalName = finalRenameMap.get(localName) ?? localName;
        return {
          modulePath: normalizeChunkImportPath(chunkId, binding.moduleSpecifier),
          localName: resolvedLocalName,
          kind: binding.kind,
          importedName: binding.importedName,
        };
      });

    const sourceBodyStatements: ts.Statement[] = [];
    for (const statement of sourceChunkMetadata.sourceFile.statements) {
      if (!selectedStatements.has(statement)) {
        continue;
      }
      const declaredNames = collectStatementDeclaredNames(statement);
      let containsRequiredRoot = false;
      for (const declaredName of declaredNames) {
        if (requiredSourceIdentifierSet.has(declaredName)) {
          containsRequiredRoot = true;
          break;
        }
      }
      if (!containsRequiredRoot && hasChunkRuntimeBootstrapPattern(statement, sourceChunkMetadata.sourceFile)) {
        continue;
      }
      if (
        !containsRequiredRoot &&
        (plan.archetype === "service" || plan.archetype === "store") &&
        hasUnsafeStaticPayloadStatement(statement, sourceChunkMetadata.sourceFile)
      ) {
        continue;
      }
      const withExtractedPayload = extractStaticPayloadFromStatement(
        statement,
        chunkId,
        sourceChunkMetadata.sourceFile,
        plannerPrinter,
      );
      const stripped = stripExportModifiers(withExtractedPayload);
      if (!stripped) {
        continue;
      }
      sourceBodyStatements.push(stripped);
    }
    let renamedInlineStatements = applyScopedIdentifierRenames(inlineDependencyStatements, finalRenameMap);
    let renamedSourceStatements = applyScopedIdentifierRenames(sourceBodyStatements, finalRenameMap);
    const targetedHotRenamedInline = applyTargetedHotLocalIdentifierPass(renamedInlineStatements);
    const targetedHotRenamedSource = applyTargetedHotLocalIdentifierPass(renamedSourceStatements);
    renamedInlineStatements = targetedHotRenamedInline.statements;
    renamedSourceStatements = targetedHotRenamedSource.statements;
    const targetedHotPostRenameMap = new Map<string, string>([
      ...targetedHotRenamedInline.renameMap.entries(),
      ...targetedHotRenamedSource.renameMap.entries(),
    ]);
    if (targetedHotPostRenameMap.size > 0) {
      for (const [sourceIdentifier, localIdentifier] of sourceIdentifierByOriginal.entries()) {
        const remappedLocal = targetedHotPostRenameMap.get(localIdentifier);
        if (remappedLocal) {
          sourceIdentifierByOriginal.set(sourceIdentifier, remappedLocal);
        }
      }
    }
    const declarationLines: string[] = [];
    for (let statementIndex = 0; statementIndex < renamedInlineStatements.length; statementIndex += 1) {
      const statement = renamedInlineStatements[statementIndex];
      if (!statement) {
        continue;
      }
      const statementSource = inlineDependencyStatementSources[statementIndex] ?? sourceChunkMetadata.sourceFile;
      const withExtractedPayload = extractStaticPayloadFromStatement(statement, chunkId, statementSource, plannerPrinter);
      const rendered = plannerPrinter.printNode(ts.EmitHint.Unspecified, withExtractedPayload, statementSource).trim();
      if (rendered.length < 1) {
        continue;
      }
      declarationLines.push(rendered);
    }
    for (const statement of renamedSourceStatements) {
      const withExtractedPayload = extractStaticPayloadFromStatement(
        statement,
        chunkId,
        sourceChunkMetadata.sourceFile,
        plannerPrinter,
      );
      const rendered = plannerPrinter.printNode(ts.EmitHint.Unspecified, withExtractedPayload, sourceChunkMetadata.sourceFile).trim();
      if (rendered.length < 1) {
        continue;
      }
      declarationLines.push(rendered);
    }

    return {
      declarationText: declarationLines.join("\n\n"),
      sourceIdentifierByOriginal,
      importNeeds,
    };
  };

  const exportEntryScore = (entry: ExportEntry): number => {
    const quality = scoreNameQuality(entry.exportName);
    const genericPenalty = isGenericName(entry.exportName) ? 0.22 : 0;
    const noisyPenalty = isNoisyIdentifier(entry.exportName) || OBFUSCATED_ALIAS_STYLE_PATTERN.test(entry.exportName) ? 0.18 : 0;
    const numericSuffixPenalty = /\d{2,}$/.test(entry.exportName) ? 0.12 : 0;
    const chainPenalty = entry.exportName.toLowerCase().includes("channeldispatch") ? 0.16 : 0;
    return clamp(quality - genericPenalty - noisyPenalty - numericSuffixPenalty - chainPenalty);
  };

  const dedupeExportEntriesByLiftedSource = (entries: ExportEntry[]): ExportEntry[] => {
    const bestBySourceKey = new Map<string, { entry: ExportEntry; score: number }>();
    for (const entry of entries) {
      const sourceKey = `${entry.chunkId}::${entry.sourceIdentifier}`;
      const score = exportEntryScore(entry);
      const existing = bestBySourceKey.get(sourceKey);
      if (!existing || score > existing.score) {
        bestBySourceKey.set(sourceKey, { entry, score });
      }
    }
    const deduped = [...bestBySourceKey.values()]
      .map((record) => record.entry)
      .sort((left, right) => {
        if (left.chunkId !== right.chunkId) {
          return left.chunkId.localeCompare(right.chunkId);
        }
        if (left.exportName !== right.exportName) {
          return left.exportName.localeCompare(right.exportName);
        }
        return left.sourceIdentifier.localeCompare(right.sourceIdentifier);
      });
    if (deduped.length < 1) {
      throw new Error(`buildQualityModuleContent: module ${plan.moduleId} lost all exports after dedupe`);
    }
    return deduped;
  };

  const exportCanonicalizerStopTokens = new Set<string>([
    ...SIGNAL_TOKEN_STOPWORDS,
    ...GENERIC_SEGMENTS,
    ...DOMAIN_ALIAS_WEAK_TOKENS,
    "node",
    "nodes",
    "event",
    "events",
    "state",
    "states",
    "store",
    "stores",
    "service",
    "services",
    "module",
    "modules",
    "chunk",
    "chunks",
    "part",
    "parts",
    "domain",
    "navigate",
    "page",
    "index",
    "default",
    "value",
    "values",
  ]);
  const isLikelyNoiseExportToken = (token: string): boolean => {
    if (/^[a-f0-9]{6,}$/i.test(token)) {
      return true;
    }
    if (/^[a-z]{1,2}\d+$/i.test(token)) {
      return true;
    }
    if (/^\d+$/.test(token)) {
      return true;
    }
    if (token.length >= 8) {
      let vowels = 0;
      for (const char of token) {
        if ("aeiou".includes(char)) {
          vowels += 1;
        }
      }
      if (vowels <= 1) {
        return true;
      }
    }
    return false;
  };
  const normalizeExportToken = (token: string): string => {
    let normalized = canonicalToken(token);
    normalized = normalized.replace(/node$/i, "");
    normalized = normalized.replace(/state$/i, "");
    normalized = normalized.replace(/\d+$/g, "");
    return normalized;
  };
  const roleSuffix = archetypeRoleSuffix(plan.archetype);
  const buildEntryDisambiguator = (entry: ExportEntry): string => {
    const localTokens = splitNameTokens(entry.localIdentifier).map((token) => canonicalToken(token));
    const exportTokens = splitNameTokens(entry.exportName).map((token) => canonicalToken(token));
    const sourceTokens = splitNameTokens(entry.sourceIdentifier).map((token) => canonicalToken(token));
    const planSignalTokens = planAliasDomainTokens
      .map((token) => canonicalToken(token))
      .map((token) => token.replace(/\d+$/g, ""))
      .filter((token) => token.length >= 3)
      .filter((token) => !token.includes("node"))
      .filter((token) => !token.startsWith("ref"))
      .filter((token) => !exportCanonicalizerStopTokens.has(token));
    const allTokens = [...localTokens, ...exportTokens, ...sourceTokens]
      .map((token) => token.replace(/node$/i, ""))
      .map((token) => token.replace(/state$/i, ""))
      .map((token) => token.replace(/\d+$/g, ""))
      .filter((token) => token.length > 0)
      .filter((token) => !token.includes("node"))
      .filter((token) => !token.startsWith("ref"))
      .filter((token) => !exportCanonicalizerStopTokens.has(token))
      .filter((token) => token !== plan.archetype);
    const tailTokenCandidate = allTokens.length > 0 ? allTokens[allTokens.length - 1] : "";
    const tailToken = typeof tailTokenCandidate === "string" ? tailTokenCandidate : "";
    if (tailToken.length >= 3) {
      return toPascalCase(tailToken);
    }
    if (tailToken.length > 0) {
      return tailToken.toUpperCase();
    }
    if (planSignalTokens.length > 0) {
      const hash = shortStableHash(`${entry.chunkId}:${entry.sourceIdentifier}`);
      const index = Number.parseInt(hash.slice(0, 6), 16) % planSignalTokens.length;
      const signalToken = planSignalTokens[index];
      if (signalToken && signalToken.length >= 3) {
        return toPascalCase(signalToken);
      }
    }
    return toPascalCase(alphabeticStableSuffix(`${entry.chunkId}:${entry.sourceIdentifier}`, 3));
  };
  const withRoleSuffix = (baseStem: string): string => sanitizeIdentifier(`${baseStem}${roleSuffix}`);
  const stripRoleSuffix = (name: string): string => {
    if (name.endsWith(roleSuffix) && name.length > roleSuffix.length) {
      return name.slice(0, name.length - roleSuffix.length);
    }
    return name;
  };
  const shouldCanonicalizeExportName = (entry: ExportEntry): boolean => {
    if (plan.archetype !== "store" && plan.archetype !== "service") {
      return false;
    }
    const name = entry.exportName;
    if (/^storeStateState\d+$/i.test(name)) {
      return true;
    }
    if (/(?:State|Event)[A-Za-z]{0,4}\d+$/.test(name)) {
      return true;
    }
    if (/storeAgentSettings?/i.test(name)) {
      return true;
    }
    if (/EventRef/i.test(name)) {
      return true;
    }
    if (/Node[A-Za-z]{2,6}(?:State|Service)$/i.test(name)) {
      return true;
    }
    if (/(?:Event|State)Node[A-Za-z]{2,6}/i.test(name)) {
      return true;
    }
    if (/\d{2,}$/.test(name)) {
      return true;
    }
    return false;
  };
  const buildCanonicalExportBase = (entry: ExportEntry): string => {
    const chunkTokens = chunkTopicTokensById.get(entry.chunkId) ?? chunkTokensFromChunkId(entry.chunkId);
    const roleToken = archetypeRoleSuffix(plan.archetype).toLowerCase();
    const semanticTokens = dedupeNameTokens([
      ...planAliasDomainTokens,
      ...splitNameTokens(entry.localIdentifier),
      ...splitNameTokens(entry.exportName),
      ...splitNameTokens(topic),
      ...chunkTokens,
    ])
      .map((token) => normalizeExportToken(token))
      .filter((token) => token.length >= 3)
      .filter((token) => !/\d/.test(token))
      .filter((token) => !token.includes("node"))
      .filter((token) => !token.startsWith("state"))
      .filter((token) => !token.startsWith("event"))
      .filter((token) => !exportCanonicalizerStopTokens.has(token))
      .filter((token) => token !== plan.archetype)
      .filter((token) => token !== roleToken)
      .filter((token) => !isLikelyNoiseExportToken(token))
      .slice(0, 3);
    const stem = semanticTokens.map((token) => toPascalCase(token)).join("");
    if (plan.archetype === "hook") {
      const hookStem = stem.length > 0 ? stem : toPascalCase(topic);
      return sanitizeIdentifier(`use${hookStem}${roleSuffix}`);
    }
    const prefix = plan.archetype;
    const fallbackTopic = toPascalCase(topic).replace(/[^A-Za-z0-9]+/g, "");
    const fallbackStem = fallbackTopic.length > 0 ? fallbackTopic : "Domain";
    const candidate = withRoleSuffix(`${prefix}${stem.length > 0 ? stem : fallbackStem}`);
    if (isNoisyIdentifier(candidate) || OBFUSCATED_ALIAS_STYLE_PATTERN.test(candidate)) {
      return withRoleSuffix(`${prefix}${fallbackStem}`);
    }
    return candidate;
  };
  const canonicalizeExportEntries = (entries: ExportEntry[]): ExportEntry[] => {
    const usedNames = new Set<string>();
    const canonicalized: ExportEntry[] = [];
    for (const entry of entries) {
      const preferredName = shouldCanonicalizeExportName(entry)
        ? buildCanonicalExportBase(entry)
        : entry.exportName;
      let uniqueName = preferredName;
      if (usedNames.has(uniqueName)) {
        const disambiguator = buildEntryDisambiguator(entry);
        const disambiguatedStem = stripRoleSuffix(uniqueName);
        uniqueName = withRoleSuffix(`${disambiguatedStem}${disambiguator}`);
      }
      uniqueName = nextUniqueIdentifier(uniqueName, usedNames);
      canonicalized.push({
        ...entry,
        exportName: uniqueName,
      });
    }
    return canonicalized;
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
      localIdentifier: "",
    });
    usedTopLevelNames.add(exportName);
  }

  const dedupedExportEntries = dedupeExportEntriesByLiftedSource(exportEntries);
  const shouldSkipBootstrapPayloadChunks = plan.archetype === "service" || plan.archetype === "store";
  const skipPayloadDecisionByChunkId = new Map<string, boolean>();
  const shouldSkipChunkForQualityModule = (chunkId: string): boolean => {
    const existing = skipPayloadDecisionByChunkId.get(chunkId);
    if (typeof existing === "boolean") {
      return existing;
    }
    const metadata = resolveLiftedChunkMetadata(chunkId);
    const skip =
      shouldSkipBootstrapPayloadChunks && (isBootstrapPayloadChunk(metadata) || isStaticPayloadOnlyChunk(metadata));
    skipPayloadDecisionByChunkId.set(chunkId, skip);
    return skip;
  };
  const activeExportEntries = dedupedExportEntries.filter((entry) => !shouldSkipChunkForQualityModule(entry.chunkId));
  if (activeExportEntries.length < 1) {
    throw new Error(`buildQualityModuleContent: module ${plan.moduleId} lost all exports after payload-chunk filtering`);
  }

  const sourceIdsByChunk = new Map<string, Set<string>>();
  const preferredLocalNameByChunk = new Map<string, Map<string, string>>();
  for (const entry of activeExportEntries) {
    const existing = sourceIdsByChunk.get(entry.chunkId) ?? new Set<string>();
    existing.add(entry.sourceIdentifier);
    sourceIdsByChunk.set(entry.chunkId, existing);
    const bySource = preferredLocalNameByChunk.get(entry.chunkId) ?? new Map<string, string>();
    if (!bySource.has(entry.sourceIdentifier)) {
      bySource.set(entry.sourceIdentifier, entry.exportName);
    }
    preferredLocalNameByChunk.set(entry.chunkId, bySource);
  }

  const sortedChunkIds = [...sourceIdsByChunk.keys()].sort((left, right) => left.localeCompare(right));
  for (const chunkId of sortedChunkIds) {
    if (!chunkId) {
      continue;
    }
    const identifiers = [...(sourceIdsByChunk.get(chunkId) ?? new Set<string>())].sort((left, right) =>
      left.localeCompare(right),
    );
    const preferredLocalNameBySourceIdentifier = preferredLocalNameByChunk.get(chunkId) ?? new Map<string, string>();
    const liftedDeclarations = createChunkLiftedDeclarations(chunkId, identifiers, preferredLocalNameBySourceIdentifier);
    for (const importNeed of liftedDeclarations.importNeeds) {
      registerDependencyImportNeed(importNeed);
    }
    if (liftedDeclarations.declarationText.length > 0) {
      chunkDeclarationBlocks.push(`// chunk: ${chunkId}\n${liftedDeclarations.declarationText}`);
    }
    for (const entry of activeExportEntries) {
      if (entry.chunkId !== chunkId) {
        continue;
      }
      const localIdentifier = liftedDeclarations.sourceIdentifierByOriginal.get(entry.sourceIdentifier);
      if (!localIdentifier) {
        throw new Error(
          `buildQualityModuleContent: missing lifted identifier "${entry.sourceIdentifier}" in chunk ${chunkId}`,
        );
      }
      entry.localIdentifier = localIdentifier;
    }
  }

  if (chunkDeclarationBlocks.length < 1) {
    throw new Error(`buildQualityModuleContent: module ${plan.moduleId} produced no lifted declarations`);
  }
  const canonicalizedExportEntries = canonicalizeExportEntries(activeExportEntries);

  const lines: string[] = [
    "// @ts-nocheck",
    "// Quality contour module: AST-lift declarations only.",
  ];
  const sortedDependencies = [...dependencyImportLines].sort((left, right) => left.localeCompare(right));
  const sortedAssetImports = [...assetImportsByPath.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (sortedDependencies.length > 0 || sortedAssetImports.length > 0) {
    lines.push("");
    lines.push("// imports");
    for (const importLine of sortedDependencies) {
      lines.push(importLine);
    }
    for (const [importPath, alias] of sortedAssetImports) {
      lines.push(`import ${alias} from ${quote(importPath)};`);
    }
  }
  const sortedNamespaceAliases = [...moduleNamespaceBindingsByAlias.keys()].sort((left, right) => left.localeCompare(right));
  if (sortedNamespaceAliases.length > 0) {
    lines.push("");
    lines.push("// import shaping");
    for (const namespaceAlias of sortedNamespaceAliases) {
      const bindings = moduleNamespaceBindingsByAlias.get(namespaceAlias);
      if (!bindings || bindings.size < 1) {
        continue;
      }
      const entries = [...bindings.entries()].sort((left, right) => left[0].localeCompare(right[0]));
      lines.push("const {");
      for (const [localName, importedName] of entries) {
        lines.push(`  ${quote(importedName)}: ${localName},`);
      }
      lines.push(`} = ${namespaceAlias};`);
    }
  }

  lines.push("");
  lines.push("// lifted declarations");
  for (const declarationBlock of chunkDeclarationBlocks) {
    lines.push(declarationBlock);
    lines.push("");
  }

  lines.push("// exports");
  for (const entry of canonicalizedExportEntries) {
    if (entry.localIdentifier.length < 1) {
      throw new Error(`buildQualityModuleContent: unresolved local identifier for ${entry.exportName}`);
    }
    if (entry.localIdentifier === entry.exportName) {
      lines.push(`export { ${entry.localIdentifier} };`);
      continue;
    }
    lines.push(`export { ${entry.localIdentifier} as ${entry.exportName} };`);
  }
  lines.push("");
  const applyTargetedG003VendorSplit = (
    contentText: string,
  ): { content: string; vendorAssetFile?: EmittedAssetFile } => {
    if (!targetedHotStoreG003Module || contentText.length < 1) {
      return { content: contentText };
    }
    const source = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      contentText,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    interface ImportBindingEntry {
      statementIndex: number;
      modulePath: string;
      kind: "namespace" | "default" | "named";
      importedName: string;
      localName: string;
    }
    const importBindingByLocalName = new Map<string, ImportBindingEntry>();
    const importDeclarationByIndex = new Map<number, ts.ImportDeclaration>();
    const localDeclarationStatementIndexByName = new Map<string, number>();
    for (let statementIndex = 0; statementIndex < source.statements.length; statementIndex += 1) {
      const statement = source.statements[statementIndex];
      if (!statement) {
        continue;
      }
      if (ts.isImportDeclaration(statement)) {
        importDeclarationByIndex.set(statementIndex, statement);
        if (!statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
          continue;
        }
        const modulePath = statement.moduleSpecifier.text;
        if (statement.importClause.name) {
          importBindingByLocalName.set(statement.importClause.name.text, {
            statementIndex,
            modulePath,
            kind: "default",
            importedName: "default",
            localName: statement.importClause.name.text,
          });
        }
        const namedBindings = statement.importClause.namedBindings;
        if (!namedBindings) {
          continue;
        }
        if (ts.isNamespaceImport(namedBindings)) {
          importBindingByLocalName.set(namedBindings.name.text, {
            statementIndex,
            modulePath,
            kind: "namespace",
            importedName: "*",
            localName: namedBindings.name.text,
          });
          continue;
        }
        for (const specifier of namedBindings.elements) {
          const localName = specifier.name.text;
          const importedName = specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
          importBindingByLocalName.set(localName, {
            statementIndex,
            modulePath,
            kind: "named",
            importedName,
            localName,
          });
        }
        continue;
      }
      if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
        continue;
      }
      const declaredNames = collectStatementDeclaredNames(statement);
      for (const declaredName of declaredNames) {
        if (!localDeclarationStatementIndexByName.has(declaredName)) {
          localDeclarationStatementIndexByName.set(declaredName, statementIndex);
        }
      }
    }

    const vendorSeedNamePattern = /^(?:storeReact|storeReactLocal|storeRuntime(?:Core)?Local)/;
    const vendorSeedTextPattern =
      /react-jsx-runtime\.production\.js|react\.production\.js|react\.transitional\.element|__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE/i;
    const candidateStatementIndices: number[] = [];
    for (let statementIndex = 0; statementIndex < source.statements.length; statementIndex += 1) {
      if (importDeclarationByIndex.has(statementIndex)) {
        continue;
      }
      const statement = source.statements[statementIndex];
      if (!statement) {
        continue;
      }
      if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
        continue;
      }
      candidateStatementIndices.push(statementIndex);
    }
    const includedStatementIndices = new Set<number>();
    for (const statementIndex of candidateStatementIndices) {
      const statement = source.statements[statementIndex];
      if (!statement) {
        continue;
      }
      const declaredNames = collectStatementDeclaredNames(statement);
      const hasSeedName = [...declaredNames].some((name) => vendorSeedNamePattern.test(name));
      const statementText = statement.getText(source);
      const hasSeedText = vendorSeedTextPattern.test(statementText);
      if (hasSeedName || hasSeedText) {
        includedStatementIndices.add(statementIndex);
      }
    }
    if (includedStatementIndices.size < 6) {
      return { content: contentText };
    }

    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const statementIndex of [...includedStatementIndices]) {
        const statement = source.statements[statementIndex];
        if (!statement) {
          continue;
        }
        const referencedNames = collectStatementReferencedNames(statement);
        for (const referencedName of referencedNames) {
          const dependencyStatementIndex = localDeclarationStatementIndexByName.get(referencedName);
          if (dependencyStatementIndex === undefined || includedStatementIndices.has(dependencyStatementIndex)) {
            continue;
          }
          if (importDeclarationByIndex.has(dependencyStatementIndex)) {
            continue;
          }
          includedStatementIndices.add(dependencyStatementIndex);
          expanded = true;
        }
      }
    }

    if (includedStatementIndices.size < 6) {
      return { content: contentText };
    }
    const extractedDeclaredNames = new Set<string>();
    const extractedReferencedNames = new Set<string>();
    for (const statementIndex of includedStatementIndices) {
      const statement = source.statements[statementIndex];
      if (!statement) {
        continue;
      }
      const declaredNames = collectStatementDeclaredNames(statement);
      const referencedNames = collectStatementReferencedNames(statement);
      for (const declaredName of declaredNames) {
        extractedDeclaredNames.add(declaredName);
      }
      for (const referencedName of referencedNames) {
        extractedReferencedNames.add(referencedName);
      }
    }
    if (extractedDeclaredNames.size < 4) {
      return { content: contentText };
    }

    const unresolvedLocalReferences: string[] = [];
    const neededImportBindingsByStatementIndex = new Map<number, Set<string>>();
    for (const referencedName of extractedReferencedNames) {
      if (extractedDeclaredNames.has(referencedName)) {
        continue;
      }
      const localDeclarationStatementIndex = localDeclarationStatementIndexByName.get(referencedName);
      if (localDeclarationStatementIndex !== undefined && !includedStatementIndices.has(localDeclarationStatementIndex)) {
        unresolvedLocalReferences.push(referencedName);
        continue;
      }
      const importBinding = importBindingByLocalName.get(referencedName);
      if (!importBinding) {
        continue;
      }
      const bucket = neededImportBindingsByStatementIndex.get(importBinding.statementIndex) ?? new Set<string>();
      bucket.add(referencedName);
      neededImportBindingsByStatementIndex.set(importBinding.statementIndex, bucket);
    }
    if (unresolvedLocalReferences.length > 0) {
      return { content: contentText };
    }

    const buildVendorImportDeclaration = (
      importDeclaration: ts.ImportDeclaration,
      neededLocalNames: ReadonlySet<string>,
    ): ts.ImportDeclaration | undefined => {
      if (!importDeclaration.importClause || !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) {
        return undefined;
      }
      const importClause = importDeclaration.importClause;
      const defaultImportName = importClause.name?.text;
      const includeDefault = defaultImportName ? neededLocalNames.has(defaultImportName) : false;
      const namedBindings = importClause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        if (!neededLocalNames.has(namedBindings.name.text)) {
          return undefined;
        }
        return importDeclaration;
      }
      const keptNamedSpecifiers: ts.ImportSpecifier[] = [];
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const localName = element.name.text;
          if (!neededLocalNames.has(localName)) {
            continue;
          }
          keptNamedSpecifiers.push(element);
        }
      }
      if (!includeDefault && keptNamedSpecifiers.length < 1) {
        return undefined;
      }
      return ts.factory.createImportDeclaration(
        importDeclaration.modifiers,
        ts.factory.createImportClause(
          importClause.isTypeOnly,
          includeDefault && defaultImportName ? ts.factory.createIdentifier(defaultImportName) : undefined,
          keptNamedSpecifiers.length > 0 ? ts.factory.createNamedImports(keptNamedSpecifiers) : undefined,
        ),
        importDeclaration.moduleSpecifier,
        importDeclaration.attributes,
      );
    };

    const vendorImportStatements: ts.Statement[] = [];
    for (const [statementIndex, neededLocalNames] of [...neededImportBindingsByStatementIndex.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      const importDeclaration = importDeclarationByIndex.get(statementIndex);
      if (!importDeclaration) {
        continue;
      }
      const vendorImportDeclaration = buildVendorImportDeclaration(importDeclaration, neededLocalNames);
      if (vendorImportDeclaration) {
        vendorImportStatements.push(vendorImportDeclaration);
      }
    }

    const extractedStatements = [...includedStatementIndices]
      .sort((left, right) => left - right)
      .map((statementIndex) => source.statements[statementIndex])
      .filter((statement): statement is ts.Statement => Boolean(statement));
    const exportedNames = [...extractedDeclaredNames].sort((left, right) => left.localeCompare(right));
    const remainingStatements = source.statements.filter((_, statementIndex) => !includedStatementIndices.has(statementIndex));
    const referencedNamesInMain = new Set<string>();
    for (const statement of remainingStatements) {
      if (!statement || ts.isImportDeclaration(statement)) {
        continue;
      }
      const referencedNames = collectStatementReferencedNames(statement);
      for (const referencedName of referencedNames) {
        referencedNamesInMain.add(referencedName);
      }
    }
    const importedVendorNames = exportedNames.filter((name) => referencedNamesInMain.has(name));
    if (importedVendorNames.length < 1) {
      return { content: contentText };
    }
    const importedVendorNameSet = new Set<string>(importedVendorNames);
    const topLevelDeclaredNamesInMain = new Set<string>();
    for (const statement of remainingStatements) {
      if (!statement || ts.isImportDeclaration(statement)) {
        continue;
      }
      const declaredNames = collectStatementDeclaredNames(statement);
      for (const declaredName of declaredNames) {
        topLevelDeclaredNamesInMain.add(declaredName);
      }
    }
    const collectAssignedIdentifiers = (statement: ts.Statement): Set<string> => {
      const assigned = new Set<string>();
      const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
        kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
          assigned.add(node.left.text);
        } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
          if (
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
            ts.isIdentifier(node.operand)
          ) {
            assigned.add(node.operand.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
      return assigned;
    };
    const reassignedVendorExportNames = new Set<string>();
    for (const statement of remainingStatements) {
      if (!statement || ts.isImportDeclaration(statement)) {
        continue;
      }
      const assignedInStatement = collectAssignedIdentifiers(statement);
      for (const assignedName of assignedInStatement) {
        if (!importedVendorNameSet.has(assignedName)) {
          continue;
        }
        if (topLevelDeclaredNamesInMain.has(assignedName)) {
          continue;
        }
        reassignedVendorExportNames.add(assignedName);
      }
    }
    const usedVendorAliasNames = new Set<string>([...topLevelDeclaredNamesInMain, ...importedVendorNames]);
    const vendorImportAliasByExportName = new Map<string, string>();
    for (const reassignedName of [...reassignedVendorExportNames].sort((left, right) => left.localeCompare(right))) {
      const aliasName = nextUniqueIdentifier(`${reassignedName}Vendor`, usedVendorAliasNames);
      usedVendorAliasNames.add(aliasName);
      vendorImportAliasByExportName.set(reassignedName, aliasName);
    }
    const vendorExportDeclaration = ts.factory.createExportDeclaration(
      undefined,
      false,
      ts.factory.createNamedExports(
        exportedNames.map((name) =>
          ts.factory.createExportSpecifier(false, undefined, ts.factory.createIdentifier(name)),
        ),
      ),
      undefined,
      undefined,
    );
    const vendorMutableAliasStatements: ts.Statement[] = [...vendorImportAliasByExportName.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([exportName, aliasName]) =>
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                ts.factory.createIdentifier(exportName),
                undefined,
                undefined,
                ts.factory.createIdentifier(aliasName),
              ),
            ],
            ts.NodeFlags.Let,
          ),
        ),
      );
    const vendorFileStatements: ts.Statement[] = [
      ...vendorImportStatements,
      ...extractedStatements,
      vendorExportDeclaration,
    ];
    const vendorSourceFile = ts.factory.updateSourceFile(source, vendorFileStatements);
    const vendorPrelude = [
      "// @ts-nocheck",
      "// Targeted vendor split: React/runtime block extracted from store-state-g003 quality module.",
      "",
    ].join("\n");
    const vendorContent = `${vendorPrelude}${printer.printFile(vendorSourceFile)}`;
    const vendorRelativeImportPath = "./vendor/store-state-g003-react-runtime.js";
    const vendorAbsolutePath = path.join(
      outputProjectDirectory,
      "src",
      "services",
      "store",
      "vendor",
      "store-state-g003-react-runtime.ts",
    );

    const vendorImportDeclaration = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(
        false,
        undefined,
        ts.factory.createNamedImports(
          importedVendorNames.map((name) =>
            ts.factory.createImportSpecifier(
              false,
              ts.factory.createIdentifier(name),
              ts.factory.createIdentifier(vendorImportAliasByExportName.get(name) ?? name),
            ),
          ),
        ),
      ),
      ts.factory.createStringLiteral(vendorRelativeImportPath),
      undefined,
    );

    let nextMainStatements: ts.Statement[] = [];
    const importStatementIndices = [...importDeclarationByIndex.keys()].sort((left, right) => left - right);
    const lastImportStatementIndex = importStatementIndices.length > 0 ? (importStatementIndices[importStatementIndices.length - 1] ?? -1) : -1;
    let vendorImportInserted = false;
    for (let statementIndex = 0; statementIndex < source.statements.length; statementIndex += 1) {
      if (!vendorImportInserted && statementIndex > lastImportStatementIndex) {
        nextMainStatements.push(vendorImportDeclaration);
        nextMainStatements.push(...vendorMutableAliasStatements);
        vendorImportInserted = true;
      }
      if (includedStatementIndices.has(statementIndex)) {
        continue;
      }
      const statement = source.statements[statementIndex];
      if (!statement) {
        continue;
      }
      nextMainStatements.push(statement);
    }
    if (!vendorImportInserted) {
      nextMainStatements = [vendorImportDeclaration, ...vendorMutableAliasStatements, ...nextMainStatements];
    }

    const nextMainSource = ts.factory.updateSourceFile(source, nextMainStatements);
    const rewrittenMainContent = printer.printFile(nextMainSource);
    return {
      content: rewrittenMainContent,
      vendorAssetFile: {
        absolutePath: vendorAbsolutePath,
        content: vendorContent,
      },
    };
  };
  const splitLongNamedImportsFinalPass = (contentText: string): string => {
    if (contentText.length < 1) {
      return contentText;
    }
    const source = ts.createSourceFile(
      `${plan.moduleId}.ts`,
      contentText,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const finalImportPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const maxSpecifiersPerImport = 24;
    let changed = false;
    const nextStatements: ts.Statement[] = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        nextStatements.push(statement);
        continue;
      }
      const importClause = statement.importClause;
      const namedBindings = importClause.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings) || namedBindings.elements.length <= maxSpecifiersPerImport) {
        nextStatements.push(statement);
        continue;
      }
      changed = true;
      const specifiers = [...namedBindings.elements];
      const defaultImportName = importClause.name?.text;
      for (let offset = 0; offset < specifiers.length; offset += maxSpecifiersPerImport) {
        const slice = specifiers.slice(offset, offset + maxSpecifiersPerImport);
        nextStatements.push(
          ts.factory.createImportDeclaration(
            statement.modifiers,
            ts.factory.createImportClause(
              importClause.isTypeOnly,
              offset === 0 && defaultImportName ? ts.factory.createIdentifier(defaultImportName) : undefined,
              ts.factory.createNamedImports(slice),
            ),
            statement.moduleSpecifier,
            statement.attributes,
          ),
        );
      }
    }
    if (!changed) {
      return contentText;
    }
    return finalImportPrinter.printFile(ts.factory.updateSourceFile(source, nextStatements));
  };
  const ensureTsNoCheckHeader = (contentText: string): string => {
    const normalized = contentText.replace(/^\uFEFF/, "");
    if (normalized.startsWith("// @ts-nocheck")) {
      return normalized;
    }
    return `// @ts-nocheck\n${normalized}`;
  };

  const qualityPassContent = enforceTargetedStoreShardFunctionLengthCap(
    applyImportHygienePass(
      applyTargetedStoreShardDomainHelperHoist(
        applyTargetedStoreShardRuntimeClusterQuarantine(
          applyTargetedStoreShardDependencyClosureExtraction(
            applyTargetedStoreShardLongFunctionClusterSplit(
              applyCriticalFunctionBodyNamingPass(
                applyCriticalTypeHintPropagation(
                  applyCriticalBehaviorClusterFunctionExtraction(
                    applyCriticalLocalAstInlinePlanner(
                      applyTargetedHotLocalDomainRenamePass(
                        applyTargetedHotCoreFamilySweep(
                          applyTargetedHotResidualLocalNoiseSweep(applyTargetedHotFinalContentPass(lines.join("\n"))),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const vendorSplitResult = applyTargetedG003VendorSplit(qualityPassContent);
  if (vendorSplitResult.vendorAssetFile) {
    const existingVendorAsset = assetFilesByPath.get(vendorSplitResult.vendorAssetFile.absolutePath);
    if (existingVendorAsset && existingVendorAsset !== vendorSplitResult.vendorAssetFile.content) {
      throw new Error(
        `buildQualityModuleContent: targeted vendor split collision at ${vendorSplitResult.vendorAssetFile.absolutePath}`,
      );
    }
    assetFilesByPath.set(vendorSplitResult.vendorAssetFile.absolutePath, vendorSplitResult.vendorAssetFile.content);
  }
  const moduleContent = ensureTsNoCheckHeader(
    splitLongNamedImportsFinalPass(applyImportHygienePass(vendorSplitResult.content)),
  );
  const assetFiles = [...assetFilesByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([absolutePath, content]) => ({
      absolutePath,
      content,
    }));
  const normalizedModuleFilePath = plan.filePath.replace(/\\/g, "/").toLowerCase();
  const lineCount = moduleContent.split(/\r?\n/).length;
  if (normalizedModuleFilePath.startsWith("src/services/store/")) {
    if (lineCount > STORE_MODULE_MAX_LINES_FAILFAST) {
      throw new Error(
        `buildQualityModuleContent: store module size fail-fast for ${plan.moduleId} (${lineCount} lines > ${STORE_MODULE_MAX_LINES_FAILFAST})`,
      );
    }
  }
  if (normalizedModuleFilePath.startsWith("src/services/")) {
    if (lineCount > SERVICE_MODULE_MAX_LINES_FAILFAST) {
      throw new Error(
        `buildQualityModuleContent: service module size fail-fast for ${plan.moduleId} (${lineCount} lines > ${SERVICE_MODULE_MAX_LINES_FAILFAST})`,
      );
    }
  }
  const namespaceImportCount = (moduleContent.match(/^\s*import\s+\*\s+as\s+/gm) ?? []).length;
  if (targetedHotWorstStoreServiceModule) {
    const namespaceImportCap = targetedHotServiceModule ? 8 : 10;
    if (namespaceImportCount > namespaceImportCap) {
      throw new Error(
        `buildQualityModuleContent: import-noise cap failed for ${plan.moduleId} (${namespaceImportCount} namespace imports > ${namespaceImportCap})`,
      );
    }
  }
  return {
    content: moduleContent,
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
  const hotFocusFileCount = qualityEntries.reduce((count, entry) => count + (entry.hotFocus ? 1 : 0), 0);
  const payload = {
    generatedAtIso: new Date().toISOString(),
    rerenderedModuleCount,
    worstPercent: FILE_QUALITY_WORST_PERCENT,
    hotFirstOnly: HOT_FIRST_REGENERATION_ENABLED,
    hotFirstTargetMin: HOT_FIRST_MIN_TARGET_FILES,
    hotFirstTargetMax: HOT_FIRST_MAX_TARGET_FILES,
    hotFocusFileCount,
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

function resolvePriorityChunkIdsFromHotPlans(
  chunkArtifacts: ChunkArtifactModel,
  modulePlans: ModulePlan[],
): string[] {
  const hotSymbolKeys = new Set<string>();
  for (const plan of modulePlans) {
    if (!plan.hotPriority) {
      continue;
    }
    for (const symbol of plan.symbols) {
      hotSymbolKeys.add(symbol.symbolKey);
    }
  }
  if (hotSymbolKeys.size < 1) {
    return [];
  }

  const priorityChunkIds = new Set<string>();
  for (const mapping of chunkArtifacts.symbolMappings) {
    if (!hotSymbolKeys.has(mapping.symbolKey)) {
      continue;
    }
    priorityChunkIds.add(mapping.chunkId);
  }
  return [...priorityChunkIds].sort((left, right) => left.localeCompare(right));
}

export async function emitTemplateProject(
  ownershipModel: OwnershipModel,
  chunkArtifacts: ChunkArtifactModel,
  semanticIr: SemanticIrModel,
  monolithLayoutHints: MonolithLayoutHintsModel,
  outputProjectDirectory: string,
  statementBudget: number,
  manualRefactorCandidatesPath?: string,
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

  const chunkTopicTokensById = buildChunkTopicTokensById(sortedChunks);
  const signalContext = buildEmitterSignalContext(semanticIr);
  const domainRenameHints = buildDomainRenameHints(ownershipModel, signalContext);
  const monolithTopicHints = buildMonolithTopicHints(monolithLayoutHints);
  if (monolithTopicHints.bySymbolKey.size < 1 && monolithTopicHints.bySymbolName.size < 1) {
    throw new Error("emitTemplateProject: monolith-first mode requires non-empty monolith layout hints");
  }
  const hotTargets = await loadManualHotTargets(manualRefactorCandidatesPath);
  const hotSeedFamilies = hotTargets.hotSeedFamilies;
  const criticalHotFilePaths = hotTargets.criticalHotFilePaths;
  const preliftRawPlans = buildModulePlans(
    ownershipModel,
    Math.max(statementBudget * QUALITY_PLAN_BUDGET_MULTIPLIER, QUALITY_PLAN_BUDGET_MIN),
    domainRenameHints,
    monolithTopicHints,
  );
  const preliftCohesionPlans = applyCohesionMergeSplit(
    preliftRawPlans,
    statementBudget,
    domainRenameHints,
    signalContext,
  );
  const preliftPrioritizedPlans = applyHotSeedPriority(preliftCohesionPlans, hotSeedFamilies);
  const priorityChunkIds = resolvePriorityChunkIdsFromHotPlans(chunkArtifacts, preliftPrioritizedPlans);

  const astLift = await buildAstLiftResult(chunkArtifacts, ownershipModel, {
    hotChunkMax: 120,
    targetCoverage: 0.985,
    minHotChunkCount: 56,
    preferredArchetypes: ["ui", "service", "store", "hook", "transport"],
    minimumChunkScore: 0,
    closureChunkLimit: 960,
    priorityChunkIds,
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
  const qualityPrioritizedPlans = applyHotSeedPriority(qualityCohesionPlans, hotSeedFamilies);
  const qualityPass = applyFileQualityRerender(
    qualityPrioritizedPlans,
    astLift.symbolBindingByKey,
    statementBudget,
    hotSeedFamilies,
    criticalHotFilePaths,
  );
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
      criticalHotFilePaths,
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
