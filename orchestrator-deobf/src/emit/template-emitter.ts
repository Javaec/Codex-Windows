import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as ts from "typescript";
import { ArchetypeId, LayerId } from "../contracts";
import { ChunkArtifactModel } from "../ir/chunk-artifact-model";
import { OwnershipModel, OwnershipRecord } from "../ir/ownership-model";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { buildAstLiftResult, LiftedSymbolBinding } from "../lift/ast-lift";
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
  moduleId: string;
  symbols: OwnershipRecord[];
  filePath: string;
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

interface ModulePlanPartition {
  qualityPlans: ModulePlan[];
  speculativePlans: ModulePlan[];
  qualitySymbolCount: number;
  speculativeSymbolCount: number;
}

const GENERIC_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);
const LAYER_ORDER: LayerId[] = ["main", "renderer", "services", "tauri"];
const ARCHETYPE_ORDER: ArchetypeId[] = ["hook", "service", "ui", "transport", "store"];
const ARCHETYPE_LAYER_COMPATIBILITY: Record<ArchetypeId, LayerId[]> = {
  hook: ["renderer"],
  service: ["services", "main"],
  ui: ["renderer"],
  transport: ["main", "tauri", "services"],
  store: ["services", "renderer"],
};
const FILE_QUALITY_WORST_PERCENT = 0.08;
const FILE_QUALITY_MIN_RERENDER_COUNT = 1;
const FILE_QUALITY_TARGET_BUDGET_FACTOR = 0.6;
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
const SPECULATIVE_PLAN_BUDGET_MULTIPLIER = 10;
const SPECULATIVE_PLAN_BUDGET_MIN = 256;
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
): string {
  const domainTokens = splitNameTokens(symbol.domainKind);
  const layerTokens = splitNameTokens(plan.layer);
  const topicTokens = splitNameTokens(topic);
  const clusterTokens = clusterTokensFromDeclaration(symbol.declarationClusterId);
  const bindingTokens = bindingSignalTokens(liftBinding, chunkTopicTokensById);
  const hintTokens = chunkHintTokens(symbol.chunkHint);
  const semanticTokens = dedupeNameTokens(
    [...bindingTokens, ...hintTokens, ...clusterTokens, ...topicTokens, ...domainTokens, ...layerTokens]
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

function buildReadableImportAliasBase(exportName: string): string {
  const pascal = toPascalCase(exportName);
  const stem = pascal.length > 0 ? pascal : "DomainSymbol";
  return sanitizeIdentifier(`impl${stem}`);
}

function buildChunkImportAliasBase(chunkId: string, chunkTopicTokensById: Map<string, string[]>): string {
  const hintedTokens = chunkTopicTokensById.get(chunkId) ?? chunkTokensFromChunkId(chunkId);
  const semanticTokens = dedupeNameTokens(
    hintedTokens
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 3)
      .filter((token) => !GENERIC_SEGMENTS.has(token))
      .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token)),
  ).slice(0, 2);

  if (semanticTokens.length === 0) {
    const fallbackTokens = dedupeNameTokens(
      chunkId
        .replace(/^chunk-/i, "")
        .split("-")
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3)
        .filter((token) => !/^[a-f0-9]{7,}$/i.test(token))
        .filter((token) => !/^\d+$/.test(token))
        .filter((token) => !GENERIC_SEGMENTS.has(token))
        .filter((token) => !SIGNAL_TOKEN_STOPWORDS.has(token)),
    ).slice(0, 2);
    semanticTokens.push(...fallbackTokens);
  }

  const stem = semanticTokens.map((token) => toPascalCase(token)).join("");
  return sanitizeIdentifier(`chunk${stem.length > 0 ? stem : "Source"}`);
}

function buildDomainExportName(
  symbol: OwnershipRecord,
  plan: ModulePlan,
  topic: string,
  ordinal: number,
  usedNames: Map<string, number>,
  liftBinding?: LiftedSymbolBinding,
  chunkTopicTokensById: Map<string, string[]> = new Map<string, string[]>(),
): string {
  if (shouldKeepSymbolName(symbol.symbolName)) {
    return nextUniqueName(sanitizeIdentifier(symbol.symbolName), usedNames);
  }
  const base = buildSignalDrivenBaseName(symbol, plan, topic, ordinal, liftBinding, chunkTopicTokensById);
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

function ensureUniqueFilePath(filePath: string, usedFilePaths: Set<string>): string {
  if (!usedFilePaths.has(filePath)) {
    usedFilePaths.add(filePath);
    return filePath;
  }

  const extension = path.extname(filePath);
  const stem = extension.length > 0 ? filePath.slice(0, -extension.length) : filePath;
  let index = 2;
  while (true) {
    const suffix = `-v${String(index).padStart(2, "0")}`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!usedFilePaths.has(candidate)) {
      usedFilePaths.add(candidate);
      return candidate;
    }
    index += 1;
  }
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

function assertHardOwnershipCompatibility(layer: LayerId, archetype: ArchetypeId, symbolKey: string): void {
  const allowedLayers = ARCHETYPE_LAYER_COMPATIBILITY[archetype];
  if (!allowedLayers.includes(layer)) {
    throw new Error(
      `template-emitter: hard file-ownership gate blocked ${symbolKey} (layer=${layer}, archetype=${archetype}, allowed=${allowedLayers.join(",")})`,
    );
  }
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

function modelBySymbol(chunkArtifacts: ChunkArtifactModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const mapping of chunkArtifacts.symbolMappings) {
    map.set(mapping.symbolKey, mapping.chunkId);
  }
  return map;
}

function buildOwnershipSubset(base: OwnershipModel, symbols: OwnershipRecord[]): OwnershipModel {
  return {
    ...base,
    generatedAtIso: new Date().toISOString(),
    symbols: [...symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
}

function topicSegmentForSymbol(symbol: OwnershipRecord): string {
  const direct = kebabFromSymbol(symbol.symbolName);
  if (direct !== "domain") {
    return direct;
  }
  return fallbackTopicByArchetype(symbol.archetype);
}

function toSpeculativeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return `coverage/speculative/${normalized}`;
}

function partitionModulePlansByLiftBinding(
  modulePlans: ModulePlan[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
): ModulePlanPartition {
  const qualityPlans: ModulePlan[] = [];
  const speculativePlans: ModulePlan[] = [];
  let qualitySymbolCount = 0;
  let speculativeSymbolCount = 0;

  for (const plan of modulePlans) {
    const qualitySymbols = plan.symbols.filter((symbol) => bindingByKey.has(symbol.symbolKey));
    const speculativeSymbols = plan.symbols.filter((symbol) => !bindingByKey.has(symbol.symbolKey));

    if (qualitySymbols.length > 0) {
      qualityPlans.push({
        ...plan,
        symbols: qualitySymbols,
      });
      qualitySymbolCount += qualitySymbols.length;
    }

    if (speculativeSymbols.length > 0) {
      speculativePlans.push({
        ...plan,
        moduleId: `${plan.moduleId}:speculative`,
        filePath: toSpeculativeFilePath(plan.filePath),
        symbols: speculativeSymbols,
      });
      speculativeSymbolCount += speculativeSymbols.length;
    }
  }

  qualityPlans.sort((left, right) => left.filePath.localeCompare(right.filePath));
  speculativePlans.sort((left, right) => left.filePath.localeCompare(right.filePath));

  return {
    qualityPlans,
    speculativePlans,
    qualitySymbolCount,
    speculativeSymbolCount,
  };
}

function buildModulePlans(ownershipModel: OwnershipModel, statementBudget: number): ModulePlan[] {
  const buckets = new Map<string, OwnershipRecord[]>();
  const sortedSymbols = [...ownershipModel.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
  for (const symbol of sortedSymbols) {
    assertHardOwnershipCompatibility(symbol.layer, symbol.archetype, symbol.symbolKey);
    const topic = topicSegmentForSymbol(symbol);
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
        const chunks = splitByBudget(byName, chunkBudget);
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

function splitPlanForQuality(plan: ModulePlan, statementBudget: number): ModulePlan[] {
  const archetypeBudget = statementBudgetForArchetype(plan.archetype, statementBudget);
  const qualityBudget = Math.max(6, Math.floor(archetypeBudget * FILE_QUALITY_TARGET_BUDGET_FACTOR));
  let chunks = splitByBudget(plan.symbols, qualityBudget);
  if (chunks.length === 1 && plan.symbols.length > 1) {
    const half = Math.ceil(plan.symbols.length / 2);
    chunks = [plan.symbols.slice(0, half), plan.symbols.slice(half)];
  }

  return chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunk, index) => {
      const suffix = `quality-${String(index + 1).padStart(2, "0")}`;
      return {
        ...plan,
        moduleId: `${plan.moduleId}:${suffix}`,
        symbols: chunk,
        filePath: plan.filePath.replace(/\.ts$/, `-${suffix}.ts`),
      };
    });
}

function applyFileQualityRerender(
  modulePlans: ModulePlan[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
  statementBudget: number,
): { modulePlans: ModulePlan[]; qualityEntries: ModuleQualityEntry[]; rerenderedModuleCount: number } {
  void statementBudget;
  if (modulePlans.length === 0) {
    return {
      modulePlans: [],
      qualityEntries: [],
      rerenderedModuleCount: 0,
    };
  }

  const orderedPlans = [...modulePlans].sort((left, right) => left.filePath.localeCompare(right.filePath));
  const qualityEntries = orderedPlans.map((plan) => {
    const entry = computeModuleQuality(plan, bindingByKey);
    return {
      ...entry,
      rerendered: false,
    };
  });

  return {
    modulePlans: orderedPlans,
    qualityEntries,
    rerenderedModuleCount: 0,
  };
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
      '      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],',
    "    },",
    "  },",
    "];",
    "",
  ].join("\n");
}

function buildRuntimeContent(allChunks: ChunkArtifactModel["chunks"], liftedChunkIds: string[]): string {
  const liftedImports = liftedChunkIds.map((chunkId) => {
    const importName = `lifted${sanitizeIdentifier(chunkId)}`;
    return {
      importName,
      line: `import * as ${importName} from "../src/chunks-ts/${chunkId}.js";`,
      chunkId,
    };
  });

  const descriptorRegistry = allChunks.map((chunk) =>
    [
      `  ${quote(chunk.chunkId)}: {`,
      `    chunkId: ${quote(chunk.chunkId)},`,
      `    sourceFilePath: ${quote(chunk.sourceFilePath.replace(/\\/g, "/"))},`,
      `    bytes: ${chunk.bytes},`,
      `    sha256: ${quote(chunk.sha256)},`,
      `    lineageId: ${quote(chunk.lineageId)},`,
      `    tool: ${quote(chunk.tool)},`,
      "  },",
    ].join("\n"),
  );
  const liftedRegistry = liftedImports.map((entry) => `  ${quote(entry.chunkId)}: ${entry.importName} as Record<string, unknown>,`);

  return [
    ...liftedImports.map((entry) => entry.line),
    "",
    "export interface ChunkArtifactDescriptor {",
    "  chunkId: string;",
    "  sourceFilePath: string;",
    "  bytes: number;",
    "  sha256: string;",
    "  lineageId: string;",
    "  tool: string;",
    "}",
    "",
    "export interface SymbolFallbackDescriptor {",
    "  placeholder: true;",
    "  chunkId: string;",
    "  symbolName: string;",
    "  symbolKey: string;",
    "}",
    "",
    "export interface ResolvedSymbol<T = unknown> extends ChunkArtifactDescriptor {",
    "  symbolName: string;",
    "  symbolKey: string;",
    '  source: "lifted" | "descriptor";',
    "  value: T | SymbolFallbackDescriptor;",
    "}",
    "",
    "const chunkDescriptorRegistry: Record<string, ChunkArtifactDescriptor> = {",
    ...descriptorRegistry,
    "};",
    "",
    "const liftedChunkRegistry: Record<string, Record<string, unknown>> = {",
    ...liftedRegistry,
    "};",
    "",
    "function descriptorFallback(chunkId: string, symbolName: string, symbolKey: string): SymbolFallbackDescriptor {",
    "  return {",
    "    placeholder: true,",
    "    chunkId,",
    "    symbolName,",
    "    symbolKey,",
    "  };",
    "}",
    "",
    "export function resolveSymbol<T = unknown>(chunkId: string, symbolName: string, symbolKey: string): ResolvedSymbol<T> {",
    "  const descriptor = chunkDescriptorRegistry[chunkId];",
    "  if (!descriptor) {",
    "    throw new Error(`Unknown chunk id: ${chunkId}`);",
    "  }",
    "",
    "  const liftedChunk = liftedChunkRegistry[chunkId];",
    "  if (liftedChunk && symbolName in liftedChunk) {",
    "    const liftedValue = liftedChunk[symbolName] as T;",
    "    return {",
    "      ...descriptor,",
    "      symbolName,",
    "      symbolKey,",
    '      source: "lifted",',
    "      value: liftedValue,",
    "    };",
    "  }",
    "",
    "  return {",
    "    ...descriptor,",
    "    symbolName,",
    "    symbolKey,",
    '    source: "descriptor",',
    "    value: descriptorFallback(chunkId, symbolName, symbolKey),",
    "  };",
    "}",
    "",
  ].join("\n");
}

function contractFactoryName(archetype: ArchetypeId): string {
  if (archetype === "hook") {
    return "createHookModuleContract";
  }
  if (archetype === "service") {
    return "createServiceModuleContract";
  }
  if (archetype === "ui") {
    return "createUiModuleContract";
  }
  if (archetype === "transport") {
    return "createTransportModuleContract";
  }
  return "createStoreModuleContract";
}

function buildModuleContractsContent(): string {
  return [
    'import type { ResolvedSymbol } from "./chunk-runtime.js";',
    "",
    'export type LayerContractId = "main" | "renderer" | "services" | "tauri";',
    'export type ArchetypeContractId = "hook" | "service" | "ui" | "transport" | "store";',
    "",
    "export interface ModuleContractBase {",
    "  moduleId: string;",
    "  layer: LayerContractId;",
    "  archetype: ArchetypeContractId;",
    "  symbols: Readonly<Record<string, ResolvedSymbol>>;",
    "}",
    "",
    'export interface HookModuleContract extends ModuleContractBase { archetype: "hook"; }',
    'export interface ServiceModuleContract extends ModuleContractBase { archetype: "service"; }',
    'export interface UiModuleContract extends ModuleContractBase { archetype: "ui"; }',
    'export interface TransportModuleContract extends ModuleContractBase { archetype: "transport"; }',
    'export interface StoreModuleContract extends ModuleContractBase { archetype: "store"; }',
    "",
    "export function createHookModuleContract(",
    "  moduleId: string,",
    "  layer: LayerContractId,",
    "  symbols: Record<string, ResolvedSymbol>,",
    "): HookModuleContract {",
    '  return { moduleId, layer, archetype: "hook", symbols };',
    "}",
    "",
    "export function createServiceModuleContract(",
    "  moduleId: string,",
    "  layer: LayerContractId,",
    "  symbols: Record<string, ResolvedSymbol>,",
    "): ServiceModuleContract {",
    '  return { moduleId, layer, archetype: "service", symbols };',
    "}",
    "",
    "export function createUiModuleContract(",
    "  moduleId: string,",
    "  layer: LayerContractId,",
    "  symbols: Record<string, ResolvedSymbol>,",
    "): UiModuleContract {",
    '  return { moduleId, layer, archetype: "ui", symbols };',
    "}",
    "",
    "export function createTransportModuleContract(",
    "  moduleId: string,",
    "  layer: LayerContractId,",
    "  symbols: Record<string, ResolvedSymbol>,",
    "): TransportModuleContract {",
    '  return { moduleId, layer, archetype: "transport", symbols };',
    "}",
    "",
    "export function createStoreModuleContract(",
    "  moduleId: string,",
    "  layer: LayerContractId,",
    "  symbols: Record<string, ResolvedSymbol>,",
    "): StoreModuleContract {",
    '  return { moduleId, layer, archetype: "store", symbols };',
    "}",
    "",
  ].join("\n");
}

function buildIpcContractsContent(): string {
  return [
    'import type { ResolvedSymbol } from "../../runtime/chunk-runtime.js";',
    "",
    "export interface IpcContract<Request = unknown, Response = unknown> {",
    '  kind: "ipc";',
    "  channel: string;",
    "  symbol: ResolvedSymbol;",
    "  invoke: (payload: Request) => Promise<Response>;",
    "}",
    "",
    "export function defineIpcContract<Request = unknown, Response = unknown>(",
    "  channel: string,",
    "  symbol: ResolvedSymbol,",
    "): IpcContract<Request, Response> {",
    "  return {",
    '    kind: "ipc",',
    "    channel,",
    "    symbol,",
    "    invoke: async (_payload: Request) => {",
    '      throw new Error(`IPC contract ${channel} is unresolved in generated output`);',
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function buildRpcContractsContent(): string {
  return [
    'import type { ResolvedSymbol } from "../../runtime/chunk-runtime.js";',
    "",
    "export interface RpcContract<Request = unknown, Response = unknown> {",
    '  kind: "rpc";',
    "  method: string;",
    "  symbol: ResolvedSymbol;",
    "  execute: (payload: Request) => Promise<Response>;",
    "}",
    "",
    "export function defineRpcContract<Request = unknown, Response = unknown>(",
    "  method: string,",
    "  symbol: ResolvedSymbol,",
    "): RpcContract<Request, Response> {",
    "  return {",
    '    kind: "rpc",',
    "    method,",
    "    symbol,",
    "    execute: async (_payload: Request) => {",
    '      throw new Error(`RPC contract ${method} is unresolved in generated output`);',
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function buildContractsEntryContent(): string {
  return [
    'export { defineIpcContract, type IpcContract } from "./ipc.js";',
    'export { defineRpcContract, type RpcContract } from "./rpc.js";',
    "",
  ].join("\n");
}

function buildQualityModuleContent(
  plan: ModulePlan,
  moduleAbsolutePath: string,
  outputProjectDirectory: string,
  symbols: OwnershipRecord[],
  bindingByKey: Map<string, LiftedSymbolBinding>,
  chunkTopicTokensById: Map<string, string[]>,
): string {
  if (symbols.length === 0) {
    throw new Error(`buildQualityModuleContent: module ${plan.moduleId} has no symbols`);
  }

  const lines: string[] = [];
  lines.push("// Quality contour module: AST-lift declarations only.");
  const topic = topicSegmentFromFilePath(plan.filePath, plan.archetype);
  const usedExportNames = new Map<string, number>();
  const usedLocalNames = new Set<string>();
  const importMapByChunk = new Map<string, Map<string, string>>();
  const localNameByLiftedSymbol = new Map<string, string>();
  const exportEntries: Array<{ exportName: string; localName: string }> = [];

  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const symbol = symbols[symbolIndex];
    if (!symbol) {
      continue;
    }
    const liftBinding = bindingByKey.get(symbol.symbolKey);
    if (!liftBinding) {
      throw new Error(`buildQualityModuleContent: missing AST-lift binding for ${symbol.symbolKey}`);
    }

    const exportName = buildDomainExportName(
      symbol,
      plan,
      topic,
      symbolIndex + 1,
      usedExportNames,
      liftBinding,
      chunkTopicTokensById,
    );
    const liftedBindingKey = `${liftBinding.chunkId}::${liftBinding.exportName}`;
    let localName = localNameByLiftedSymbol.get(liftedBindingKey);
    if (!localName) {
      const localBaseName = buildReadableImportAliasBase(exportName);
      localName = nextUniqueIdentifier(localBaseName, usedLocalNames);
      localNameByLiftedSymbol.set(liftedBindingKey, localName);
      const chunkImports = importMapByChunk.get(liftBinding.chunkId) ?? new Map<string, string>();
      chunkImports.set(liftBinding.exportName, localName);
      importMapByChunk.set(liftBinding.chunkId, chunkImports);
    }

    exportEntries.push({
      exportName,
      localName,
    });
  }

  const chunkIds = [...importMapByChunk.keys()].sort((left, right) => left.localeCompare(right));
  const importAliasByChunk = new Map<string, string>();
  const usedChunkAliases = new Set<string>();
  for (const chunkId of chunkIds) {
    const chunkImports = importMapByChunk.get(chunkId);
    if (!chunkImports || chunkImports.size === 0) {
      continue;
    }
    const chunkModulePath = path.join(outputProjectDirectory, "src", "chunks-ts", `${chunkId}.ts`);
    const importPath = toJsImportPath(moduleAbsolutePath, chunkModulePath);
    const chunkAliasBase = buildChunkImportAliasBase(chunkId, chunkTopicTokensById);
    const chunkAlias = nextUniqueIdentifier(chunkAliasBase, usedChunkAliases);
    importAliasByChunk.set(chunkId, chunkAlias);
    lines.push(`import * as ${chunkAlias} from ${quote(importPath)};`);
  }

  lines.push("");
  for (const chunkId of chunkIds) {
    const chunkImports = importMapByChunk.get(chunkId);
    const chunkAlias = importAliasByChunk.get(chunkId);
    if (!chunkImports || chunkImports.size === 0 || !chunkAlias) {
      continue;
    }
    const entries = [...chunkImports.entries()].sort(([left], [right]) => left.localeCompare(right));
    lines.push(`const {`);
    for (const [sourceExport, localName] of entries) {
      lines.push(`  ${sourceExport}: ${localName},`);
    }
    lines.push(`} = ${chunkAlias};`);
    lines.push("");
  }

  for (const entry of exportEntries) {
    lines.push(`export const ${entry.exportName} = ${entry.localName};`);
  }
  lines.push("");
  lines.push("const moduleExports = {");
  for (const entry of exportEntries) {
    lines.push(`  ${entry.exportName},`);
  }
  lines.push("};");
  lines.push("export default moduleExports;");
  lines.push("");
  return lines.join("\n");
}

function buildSpeculativeModuleContent(
  plan: ModulePlan,
  runtimeImportPath: string,
  contractsImportPath: string,
  domainContractsImportPath: string,
  symbols: OwnershipRecord[],
  symbolToChunk: Map<string, string>,
  bindingByKey: Map<string, LiftedSymbolBinding>,
  chunkTopicTokensById: Map<string, string[]>,
): string {
  const lines: string[] = [];
  const contractFactory = contractFactoryName(plan.archetype);
  lines.push(`import { resolveSymbol, type ResolvedSymbol } from ${quote(runtimeImportPath)};`);
  lines.push(`import { ${contractFactory} } from ${quote(contractsImportPath)};`);

  const requiresIpc = plan.archetype === "transport";
  const requiresRpc = plan.archetype === "service";
  if (requiresIpc || requiresRpc) {
    const importNames: string[] = [];
    if (requiresIpc) {
      importNames.push("defineIpcContract");
    }
    if (requiresRpc) {
      importNames.push("defineRpcContract");
    }
    lines.push(`import { ${importNames.join(", ")} } from ${quote(domainContractsImportPath)};`);
  }

  lines.push("");

  const usedNames = new Map<string, number>();
  const exportedNames: string[] = [];
  const resolvedSymbolNames: string[] = [];
  const topic = topicSegmentFromFilePath(plan.filePath, plan.archetype);

  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
    const symbol = symbols[symbolIndex];
    if (!symbol) {
      continue;
    }
    const chunkId = symbolToChunk.get(symbol.symbolKey);
    if (!chunkId) {
      throw new Error(`Missing chunk mapping for symbol ${symbol.symbolKey}`);
    }

    const liftBinding = bindingByKey.get(symbol.symbolKey);
    const exportName = buildDomainExportName(
      symbol,
      plan,
      topic,
      symbolIndex + 1,
      usedNames,
      liftBinding,
      chunkTopicTokensById,
    );
    const resolvedName = `${exportName}Symbol`;
    const runtimeSymbolName = liftBinding && liftBinding.chunkId === chunkId ? liftBinding.exportName : symbol.symbolName;

    exportedNames.push(exportName);
    resolvedSymbolNames.push(resolvedName);

    lines.push(
      `const ${resolvedName}: ResolvedSymbol = resolveSymbol(${quote(chunkId)}, ${quote(runtimeSymbolName)}, ${quote(symbol.symbolKey)});`,
    );
    lines.push(`export const ${exportName} = ${resolvedName}.value;`);

    if (requiresIpc) {
      lines.push(`export const ${exportName}Ipc = defineIpcContract(${quote(exportName)}, ${resolvedName});`);
    }
    if (requiresRpc) {
      lines.push(`export const ${exportName}Rpc = defineRpcContract(${quote(exportName)}, ${resolvedName});`);
    }
  }

  lines.push("");
  lines.push("const moduleSymbols: Record<string, ResolvedSymbol> = {");
  for (let index = 0; index < exportedNames.length; index += 1) {
    const exportName = exportedNames[index];
    const resolvedName = resolvedSymbolNames[index];
    if (!exportName || !resolvedName) {
      continue;
    }
    lines.push(`  ${exportName}: ${resolvedName},`);
  }
  lines.push("};");
  lines.push("");
  lines.push(
    `export const moduleContract = ${contractFactory}(${quote(plan.moduleId)}, ${quote(plan.layer)}, moduleSymbols);`,
  );
  lines.push("export default moduleContract;");
  lines.push("");
  return lines.join("\n");
}

function buildSmokeRunner(modulePaths: string[]): string {
  const imports = modulePaths.map((modulePath) => `  ${quote(modulePath)},`);
  return [
    "const modules = [",
    ...imports,
    "];",
    "",
    "let imported = 0;",
    "for (const modulePath of modules) {",
    "  await import(new URL(modulePath, import.meta.url));",
    "  imported += 1;",
    "}",
    'console.log(`[dev-smoke] imported ${imported} modules`);',
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

interface ChunkStubDependency {
  requiresDefaultExport: boolean;
  namedExports: Set<string>;
}

function chunkIdFromRelativeImport(moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith(".")) {
    return undefined;
  }
  const normalized = moduleSpecifier.replace(/\\/g, "/");
  const baseName = path.basename(normalized).replace(/\.[cm]?[jt]sx?$/i, "");
  if (baseName.length === 0) {
    return undefined;
  }
  return baseName;
}

function collectChunkStubDependencies(
  liftedChunks: Awaited<ReturnType<typeof buildAstLiftResult>>["liftedChunks"],
  emittedChunkIds: Set<string>,
): Map<string, ChunkStubDependency> {
  const dependencies = new Map<string, ChunkStubDependency>();

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

      const existing = dependencies.get(importedChunkId) ?? {
        requiresDefaultExport: false,
        namedExports: new Set<string>(),
      };
      const clause = statement.importClause;
      if (clause?.name) {
        existing.requiresDefaultExport = true;
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName ?? element.name;
          existing.namedExports.add(importedName.text);
        }
      }
      dependencies.set(importedChunkId, existing);
    }
  }

  return dependencies;
}

function buildChunkStubContent(chunkId: string, dependency: ChunkStubDependency): string {
  const lines: string[] = [];
  lines.push("// @ts-nocheck");
  lines.push(`// Auto-generated chunk stub for unresolved lifted dependency: ${chunkId}`);
  lines.push("");
  lines.push(
    "const chunkStub = new Proxy(function chunkStubCallable() { return undefined; }, {",
    "  get: () => chunkStub,",
    "  apply: () => undefined,",
    "  construct: () => ({}),",
    "});",
  );
  lines.push("");
  lines.push(`export const liftedSourcePath = ${quote(`stub://${chunkId}`)};`);
  lines.push("export const liftedImportShapingCount = 0;");
  lines.push("export const liftedPrunedDeclarationCount = 0;");
  lines.push("export const liftedDeclarationCount = 0;");
  lines.push("");
  const namedExports = [...dependency.namedExports].sort((left, right) => left.localeCompare(right));
  for (const name of namedExports) {
    lines.push(`export const ${name} = chunkStub;`);
  }
  if (dependency.requiresDefaultExport || namedExports.length === 0) {
    lines.push("export default chunkStub;");
  }
  lines.push("");
  return lines.join("\n");
}

export async function emitTemplateProject(
  ownershipModel: OwnershipModel,
  chunkArtifacts: ChunkArtifactModel,
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
    hotChunkMax: 24,
    targetCoverage: 0.95,
    minHotChunkCount: 10,
    preferredArchetypes: ["ui", "service", "hook", "transport"],
    minimumChunkScore: 0,
  });

  const liftedChunkIds = new Set<string>();
  for (const liftedChunk of astLift.liftedChunks) {
    liftedChunkIds.add(liftedChunk.chunkId);
    const liftedPath = path.join(outputProjectDirectory, "src", "chunks-ts", `${liftedChunk.chunkId}.ts`);
    await writeTextFile(liftedPath, liftedChunk.content);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, liftedPath));
  }

  const chunkStubDependencies = collectChunkStubDependencies(astLift.liftedChunks, liftedChunkIds);
  for (const [stubChunkId, dependency] of [...chunkStubDependencies.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (liftedChunkIds.has(stubChunkId)) {
      continue;
    }
    const stubPath = path.join(outputProjectDirectory, "src", "chunks-ts", `${stubChunkId}.ts`);
    await writeTextFile(stubPath, buildChunkStubContent(stubChunkId, dependency));
    liftedChunkIds.add(stubChunkId);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, stubPath));
  }

  const runtimePath = path.join(outputProjectDirectory, "runtime", "chunk-runtime.ts");
  const runtimeContent = buildRuntimeContent(sortedChunks, [...liftedChunkIds].sort((left, right) => left.localeCompare(right)));
  await writeTextFile(runtimePath, runtimeContent);
  emittedFiles.push(toProjectRelative(outputProjectDirectory, runtimePath));

  const moduleContractsPath = path.join(outputProjectDirectory, "runtime", "module-contracts.ts");
  await writeTextFile(moduleContractsPath, buildModuleContractsContent());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, moduleContractsPath));

  const ipcContractsPath = path.join(outputProjectDirectory, "src", "contracts", "ipc.ts");
  await writeTextFile(ipcContractsPath, buildIpcContractsContent());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, ipcContractsPath));

  const rpcContractsPath = path.join(outputProjectDirectory, "src", "contracts", "rpc.ts");
  await writeTextFile(rpcContractsPath, buildRpcContractsContent());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, rpcContractsPath));

  const contractsEntryPath = path.join(outputProjectDirectory, "src", "contracts", "contracts.ts");
  await writeTextFile(contractsEntryPath, buildContractsEntryContent());
  emittedFiles.push(toProjectRelative(outputProjectDirectory, contractsEntryPath));

  const symbolToChunk = modelBySymbol(chunkArtifacts);
  const chunkTopicTokensById = buildChunkTopicTokensById(sortedChunks);
  const qualitySymbols = ownershipModel.symbols.filter((symbol) => astLift.symbolBindingByKey.has(symbol.symbolKey));
  const speculativeSymbols = ownershipModel.symbols.filter((symbol) => !astLift.symbolBindingByKey.has(symbol.symbolKey));

  const qualityOwnership = buildOwnershipSubset(ownershipModel, qualitySymbols);
  const qualityRawPlans = buildModulePlans(
    qualityOwnership,
    Math.max(statementBudget * QUALITY_PLAN_BUDGET_MULTIPLIER, QUALITY_PLAN_BUDGET_MIN),
  );
  const qualityPass = applyFileQualityRerender(qualityRawPlans, astLift.symbolBindingByKey, statementBudget);
  const qualityModulePlans = qualityPass.modulePlans;
  const speculativeOwnership = buildOwnershipSubset(ownershipModel, speculativeSymbols);
  const speculativeRawPlans = buildModulePlans(
    speculativeOwnership,
    Math.max(statementBudget * SPECULATIVE_PLAN_BUDGET_MULTIPLIER, SPECULATIVE_PLAN_BUDGET_MIN),
  );
  const speculativeModulePlans = speculativeRawPlans.map((plan) => ({
    ...plan,
    moduleId: `${plan.moduleId}:speculative`,
    filePath: toSpeculativeFilePath(plan.filePath),
  }));

  for (const plan of qualityModulePlans) {
    const absoluteFilePath = path.join(outputProjectDirectory, plan.filePath);
    const moduleContent = buildQualityModuleContent(
      plan,
      absoluteFilePath,
      outputProjectDirectory,
      plan.symbols,
      astLift.symbolBindingByKey,
      chunkTopicTokensById,
    );
    await writeTextFile(absoluteFilePath, moduleContent);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, absoluteFilePath));
  }

  for (const plan of speculativeModulePlans) {
    const absoluteFilePath = path.join(outputProjectDirectory, plan.filePath);
    const runtimeImport = toJsImportPath(absoluteFilePath, runtimePath);
    const moduleContractsImport = toJsImportPath(absoluteFilePath, moduleContractsPath);
    const domainContractsImport = toJsImportPath(absoluteFilePath, contractsEntryPath);

    const moduleContent = buildSpeculativeModuleContent(
      plan,
      runtimeImport,
      moduleContractsImport,
      domainContractsImport,
      plan.symbols,
      symbolToChunk,
      astLift.symbolBindingByKey,
      chunkTopicTokensById,
    );
    await writeTextFile(absoluteFilePath, moduleContent);
    emittedFiles.push(toProjectRelative(outputProjectDirectory, absoluteFilePath));
  }

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
    emittedModuleCount: qualityModulePlans.length + speculativeModulePlans.length,
    emittedSymbolCount: qualitySymbols.length,
    fileQualityReportPath,
    rerenderedModuleCount: qualityPass.rerenderedModuleCount,
    hotChunkCount: astLift.hotChunkIds.length,
  };
}
