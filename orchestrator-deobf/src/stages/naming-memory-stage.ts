import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NamingMemoryStageInput, NamingMemoryStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { DomainArchetype, DomainKind, SemanticDeclarationFingerprint, SemanticIrModel } from "../ir/semantic-ir";
import { isGenericName, isIdentifierName, scoreNameQuality } from "../ir/name-quality";
import {
  applyNamingMemory,
  createEmptyNamingMemory,
  NamingMemoryModel,
  NamingSeedCandidate,
  NamingMemoryEntry,
  updateNamingMemory,
} from "../ir/naming-memory";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

interface MonolithSymbolTableEntry {
  symbolKey: string;
  kind?: "class" | "function" | "callable-variable" | "variable";
  anchor?: string;
  finalName: string;
  signalScore?: number;
  promoteToQuality?: boolean;
  inferredType?: "boolean" | "array" | "object" | "function" | "unknown";
  signature?: string;
  parameterCount?: number;
  returnHint?: "boolean" | "array" | "object" | "function" | "unknown";
}

interface MonolithSymbolTableModel {
  entries: MonolithSymbolTableEntry[];
}

interface MonolithTypingFunctionHint {
  symbolKey: string;
  name: string;
  parameterCount: number;
  signature: string;
  returnHint: "boolean" | "array" | "object" | "function" | "unknown";
}

interface MonolithTypingVariableHint {
  variableKey: string;
  variableName: string;
  inferredType: "boolean" | "array" | "object" | "function" | "unknown";
}

interface MonolithTypingHintsModel {
  functionHints?: MonolithTypingFunctionHint[];
  variableHints?: MonolithTypingVariableHint[];
}

interface TypingHintMaps {
  functionBySymbolKey: Map<string, MonolithTypingFunctionHint>;
  variableByKey: Map<string, MonolithTypingVariableHint>;
}

interface SeedMapSplit {
  directBySymbolKey: Map<string, NamingSeedCandidate>;
  promotionBySymbolKey: Map<string, NamingSeedCandidate>;
}

interface PromotionSelectionSummary {
  selectedBySymbolKey: Map<string, NamingSeedCandidate>;
  candidateCount: number;
  selectedCount: number;
  rejectedCount: number;
}

interface PromotionBudgetCandidate {
  symbolKey: string;
  seed: NamingSeedCandidate;
  baselineQuality: number;
  candidateQuality: number;
  baselineScore: number;
  candidateScore: number;
  qualityGain: number;
  priority: number;
}

interface SemanticSeedMaps {
  directBySymbolKey: Map<string, NamingSeedCandidate>;
  promotionBySymbolKey: Map<string, NamingSeedCandidate>;
}

const PROMOTION_MIN_QUALITY_GAIN = 0.001;
const PROMOTION_MIN_SCORE_GAIN = 0.0005;
const PROMOTION_PRIORITY_QUALITY_GAIN_WEIGHT = 0.42;
const PROMOTION_PRIORITY_QUALITY_WEIGHT = 0.18;
const PROMOTION_PRIORITY_SIGNAL_WEIGHT = 0.18;
const PROMOTION_PRIORITY_SCORE_WEIGHT = 0.22;
const GENERIC_DOMAIN_TOKENS = new Set<string>([
  "class",
  "func",
  "function",
  "var",
  "value",
  "state",
  "store",
  "data",
  "item",
  "object",
  "list",
  "array",
  "temp",
  "tmp",
  "unknown",
  "generic",
  "module",
  "handler",
  "event",
]);

async function readNamingMemoryFromPath(namingMemoryPath: string): Promise<NamingMemoryModel> {
  const exists = await fs
    .stat(namingMemoryPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return createEmptyNamingMemory();
  }
  return await readJsonFile<NamingMemoryModel>(namingMemoryPath);
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

function tokenizeIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}

function toPascalToken(token: string): string {
  if (token.length < 1) {
    return "";
  }
  return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
}

function sanitizeIdentifierName(name: string, fallbackName: string): string {
  const parts = name
    .replace(/[^A-Za-z0-9_$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
  if (parts.length < 1) {
    return fallbackName;
  }
  const head = parts[0];
  if (!head) {
    return fallbackName;
  }
  const tail = parts.slice(1).map((entry) => toPascalToken(entry.toLowerCase()));
  const compactHead = head.replace(/[^A-Za-z0-9_$]/g, "");
  const compactTail = tail.join("").replace(/[^A-Za-z0-9_$]/g, "");
  const normalized = `${compactHead}${compactTail}`;
  if (normalized.length < 1) {
    return fallbackName;
  }
  const safe = /^[A-Za-z_$]/.test(normalized) ? normalized : `n${normalized}`;
  if (!isIdentifierName(safe)) {
    return fallbackName;
  }
  return safe;
}

function isCoverageVariableSymbolKey(symbolKey: string): boolean {
  return symbolKey.includes(":coverage:var:");
}

function ownerFromCoverageSymbolKey(symbolKey: string): string {
  const marker = ":coverage:";
  const markerIndex = symbolKey.indexOf(marker);
  if (markerIndex < 1) {
    throw new Error(`ownerFromCoverageSymbolKey: invalid coverage symbol key ${symbolKey}`);
  }
  return symbolKey.slice(0, markerIndex);
}

function inferDomainKindForCoverageName(symbolName: string): DomainKind {
  const lower = symbolName.toLowerCase();
  if (lower.startsWith("use") || lower.includes("hook")) {
    return "hook";
  }
  if (lower.includes("store") || lower.includes("state")) {
    return "store";
  }
  if (lower.includes("ipc") || lower.includes("rpc") || lower.includes("channel") || lower.includes("transport")) {
    return "transport";
  }
  if (lower.includes("view") || lower.includes("component") || lower.includes("render") || lower.includes("ui")) {
    return "ui";
  }
  if (lower.includes("service") || lower.includes("client")) {
    return "service";
  }
  return "usecase";
}

function archetypeForDomainKind(domainKind: DomainKind): DomainArchetype {
  if (domainKind === "hook") {
    return "hook";
  }
  if (domainKind === "store") {
    return "store";
  }
  if (domainKind === "transport") {
    return "transport";
  }
  if (domainKind === "ui") {
    return "ui";
  }
  return "service";
}

function pickDomainStem(
  symbolName: string,
  declarationFingerprint: SemanticDeclarationFingerprint | undefined,
): string {
  const candidates: string[] = [];
  const pushTokens = (input: string): void => {
    for (const token of tokenizeIdentifier(input)) {
      if (GENERIC_DOMAIN_TOKENS.has(token)) {
        continue;
      }
      if (isGenericName(token)) {
        continue;
      }
      if (token.length < 4) {
        continue;
      }
      candidates.push(token);
    }
  };

  if (declarationFingerprint) {
    for (const stateKey of declarationFingerprint.stateKeys.slice(0, 6)) {
      pushTokens(stateKey);
    }
    for (const neighbourName of declarationFingerprint.callGraphNeighborhood.neighbourNames.slice(0, 6)) {
      pushTokens(neighbourName);
    }
  }
  pushTokens(symbolName);

  const winner = candidates[0];
  if (!winner) {
    return "domain";
  }
  return winner;
}

function roleVerbForFingerprint(declarationFingerprint: SemanticDeclarationFingerprint): string {
  if (declarationFingerprint.role === "parser") {
    return declarationFingerprint.sideEffects.performsIo ? "parse" : "decode";
  }
  if (declarationFingerprint.role === "store") {
    return declarationFingerprint.sideEffects.mutatesState ? "update" : "select";
  }
  if (declarationFingerprint.role === "transport") {
    return declarationFingerprint.sideEffects.invokesTransport ? "invoke" : "dispatch";
  }
  if (declarationFingerprint.role === "ui") {
    return declarationFingerprint.sideEffects.emitsEvents ? "handle" : "render";
  }
  return declarationFingerprint.sideEffects.emitsEvents ? "orchestrate" : "run";
}

function roleSuffixForFingerprint(declarationFingerprint: SemanticDeclarationFingerprint): string {
  if (declarationFingerprint.role === "parser") {
    return "Payload";
  }
  if (declarationFingerprint.role === "store") {
    return "State";
  }
  if (declarationFingerprint.role === "transport") {
    return "Request";
  }
  if (declarationFingerprint.role === "ui") {
    return declarationFingerprint.sideEffects.emitsEvents ? "Event" : "View";
  }
  return "Flow";
}

function roleBasedName(
  symbolName: string,
  declarationFingerprint: SemanticDeclarationFingerprint,
): string {
  const domainStem = toPascalToken(pickDomainStem(symbolName, declarationFingerprint));
  const verb = roleVerbForFingerprint(declarationFingerprint);
  const suffix = roleSuffixForFingerprint(declarationFingerprint);
  const raw = `${verb}${domainStem}${suffix}`;
  return sanitizeIdentifierName(raw, symbolName);
}

function isCoverageSymbolKey(symbolKey: string): boolean {
  return symbolKey.includes("-census:");
}

function coverageVariableKey(symbolKey: string): string | undefined {
  const marker = "coverage:";
  const markerIndex = symbolKey.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  return symbolKey.slice(markerIndex + marker.length);
}

function typedNameFromSeed(baseName: string, inferredType: MonolithTypingVariableHint["inferredType"]): string {
  const suffix = inferredType === "boolean"
    ? "BoolVar"
    : inferredType === "array"
      ? "ListVar"
      : inferredType === "object"
        ? "ObjectVar"
        : inferredType === "function"
          ? "FnVar"
          : "Var";
  if (/boolvar|listvar|objectvar|fnvar|var/i.test(baseName)) {
    return baseName.replace(/(?:boolvar|listvar|objectvar|fnvar|var)/i, suffix);
  }
  return `${baseName}${suffix}`;
}

function scoreSeedCandidate(candidate: NamingSeedCandidate): number {
  return Number((candidate.confidence * 0.75 + candidate.signalScore * 0.25).toFixed(4));
}

function pickStrongerSeed(
  existing: NamingSeedCandidate | undefined,
  incoming: NamingSeedCandidate,
): NamingSeedCandidate {
  if (!existing) {
    return incoming;
  }
  const existingScore = scoreSeedCandidate(existing);
  const incomingScore = scoreSeedCandidate(incoming);
  if (incomingScore !== existingScore) {
    return incomingScore > existingScore ? incoming : existing;
  }
  if (incoming.name.length !== existing.name.length) {
    return incoming.name.length > existing.name.length ? incoming : existing;
  }
  return incoming.name.localeCompare(existing.name) < 0 ? incoming : existing;
}

function toPromotionKey(symbolKey: string): string {
  return symbolKey.replace("-census:", ":");
}

function buildMemoryEntryMap(memory: NamingMemoryModel): Map<string, NamingMemoryEntry> {
  const byKey = new Map<string, NamingMemoryEntry>();
  for (const entry of memory.entries) {
    byKey.set(entry.symbolKey, entry);
  }
  return byKey;
}

function buildSemanticSymbolMap(semanticIr: SemanticIrModel): Map<string, SemanticIrModel["symbols"][number]> {
  const byKey = new Map<string, SemanticIrModel["symbols"][number]>();
  for (const symbol of semanticIr.symbols) {
    byKey.set(symbol.symbolKey, symbol);
  }
  return byKey;
}

async function readTypingHintMaps(typingHintsPath: string): Promise<TypingHintMaps> {
  const model = await readJsonFile<MonolithTypingHintsModel>(typingHintsPath);
  const functionBySymbolKey = new Map<string, MonolithTypingFunctionHint>();
  const variableByKey = new Map<string, MonolithTypingVariableHint>();

  const functionHints = Array.isArray(model.functionHints) ? model.functionHints : [];
  for (const hint of functionHints) {
    if (typeof hint.symbolKey !== "string" || hint.symbolKey.length === 0) {
      continue;
    }
    functionBySymbolKey.set(hint.symbolKey, hint);
  }

  const variableHints = Array.isArray(model.variableHints) ? model.variableHints : [];
  for (const hint of variableHints) {
    if (typeof hint.variableKey !== "string" || hint.variableKey.length === 0) {
      continue;
    }
    variableByKey.set(hint.variableKey, hint);
  }

  return {
    functionBySymbolKey,
    variableByKey,
  };
}

function candidateScoreFromSymbol(symbol: SemanticIrModel["symbols"][number], confidenceOverride: number | undefined): number {
  const confidence = typeof confidenceOverride === "number" ? Math.max(symbol.confidence, confidenceOverride) : symbol.confidence;
  return clamp(confidence * Math.max(symbol.quality, 0.1));
}

function averageQualityForSemanticSymbols(
  semanticIr: SemanticIrModel,
  resolveName: (symbolKey: string, fallbackName: string) => string,
): number {
  if (semanticIr.symbols.length === 0) {
    return 0;
  }
  let total = 0;
  for (const symbol of semanticIr.symbols) {
    const candidateName = resolveName(symbol.symbolKey, symbol.name);
    total += scoreNameQuality(candidateName);
  }
  return clamp(total / semanticIr.symbols.length);
}

function selectPromotionSeeds(
  semanticIr: SemanticIrModel,
  namingMemory: NamingMemoryModel,
  directBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
  promotionBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
  promotionBudget: number,
): PromotionSelectionSummary {
  const symbolByKey = buildSemanticSymbolMap(semanticIr);
  const memoryByKey = buildMemoryEntryMap(namingMemory);
  const candidatesBySymbolKey = new Map<string, PromotionBudgetCandidate>();

  const registerCandidate = (symbolKey: string, seed: NamingSeedCandidate, sourceBoost: number): void => {
    const symbol = symbolByKey.get(symbolKey);
    if (!symbol) {
      return;
    }

    const memoryEntry = memoryByKey.get(symbolKey);
    const baselineName = memoryEntry ? memoryEntry.currentName : symbol.name;
    if (seed.name === baselineName) {
      return;
    }
    const baselineQuality = scoreNameQuality(baselineName);
    const candidateQuality = scoreNameQuality(seed.name);
    if (candidateQuality < baselineQuality + PROMOTION_MIN_QUALITY_GAIN) {
      return;
    }
    if (isGenericName(seed.name) && !isGenericName(baselineName)) {
      return;
    }

    const baselineScore = memoryEntry ? memoryEntry.currentScore : candidateScoreFromSymbol(symbol, undefined);
    const candidateScore = clamp(candidateScoreFromSymbol(symbol, seed.confidence) * 0.86 + seed.signalScore * 0.14);
    if (candidateScore < baselineScore + PROMOTION_MIN_SCORE_GAIN) {
      return;
    }
    const qualityGain = Number((candidateQuality - baselineQuality).toFixed(4));
    if (qualityGain <= 0) {
      return;
    }
    const priority = Number((
      qualityGain * PROMOTION_PRIORITY_QUALITY_GAIN_WEIGHT +
      candidateQuality * PROMOTION_PRIORITY_QUALITY_WEIGHT +
      seed.signalScore * PROMOTION_PRIORITY_SIGNAL_WEIGHT +
      candidateScore * PROMOTION_PRIORITY_SCORE_WEIGHT
    ).toFixed(4)) + sourceBoost;
    const candidate: PromotionBudgetCandidate = {
      symbolKey,
      seed,
      baselineQuality,
      candidateQuality,
      baselineScore,
      candidateScore,
      qualityGain,
      priority,
    };
    const existing = candidatesBySymbolKey.get(symbolKey);
    if (!existing) {
      candidatesBySymbolKey.set(symbolKey, candidate);
      return;
    }
    if (candidate.priority > existing.priority) {
      candidatesBySymbolKey.set(symbolKey, candidate);
      return;
    }
    if (candidate.priority === existing.priority && candidate.qualityGain > existing.qualityGain) {
      candidatesBySymbolKey.set(symbolKey, candidate);
      return;
    }
    if (
      candidate.priority === existing.priority &&
      candidate.qualityGain === existing.qualityGain &&
      candidate.candidateScore > existing.candidateScore
    ) {
      candidatesBySymbolKey.set(symbolKey, candidate);
    }
  };

  for (const [symbolKey, seed] of promotionBySymbolKey) {
    if (seed.source !== "promotion") {
      continue;
    }
    registerCandidate(symbolKey, seed, 0.03);
  }

  if (candidatesBySymbolKey.size < promotionBudget) {
    for (const [symbolKey, seed] of directBySymbolKey) {
      registerCandidate(symbolKey, seed, 0.015);
    }
  }

  if (candidatesBySymbolKey.size < promotionBudget) {
    const symbolKeys = [...symbolByKey.keys()].sort((left, right) => left.localeCompare(right));
    for (const symbolKey of symbolKeys) {
      const symbol = symbolByKey.get(symbolKey);
      if (!symbol) {
        continue;
      }
      for (const alternative of symbol.alternatives.slice(0, 4)) {
        registerCandidate(symbolKey, candidateFromAlternative(symbol.confidence, alternative), 0);
      }
    }
  }

  const candidates = [...candidatesBySymbolKey.values()];

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (left.qualityGain !== right.qualityGain) {
      return right.qualityGain - left.qualityGain;
    }
    if (left.candidateQuality !== right.candidateQuality) {
      return right.candidateQuality - left.candidateQuality;
    }
    if (left.baselineScore !== right.baselineScore) {
      return right.baselineScore - left.baselineScore;
    }
    if (left.candidateScore !== right.candidateScore) {
      return right.candidateScore - left.candidateScore;
    }
    return left.symbolKey.localeCompare(right.symbolKey);
  });

  const selectedBySymbolKey = new Map<string, NamingSeedCandidate>();
  for (const candidate of candidates.slice(0, promotionBudget)) {
    selectedBySymbolKey.set(candidate.symbolKey, candidate.seed);
  }

  return {
    selectedBySymbolKey,
    candidateCount: candidates.length,
    selectedCount: selectedBySymbolKey.size,
    rejectedCount: Math.max(0, candidates.length - selectedBySymbolKey.size),
  };
}

function candidateFromAlternative(baseConfidence: number, alternativeName: string): NamingSeedCandidate {
  const quality = scoreNameQuality(alternativeName);
  return {
    name: alternativeName,
    confidence: clamp(Math.max(baseConfidence, 0.34 + quality * 0.48)),
    source: "direct",
    signalScore: clamp(0.46 + quality * 0.42),
  };
}

function buildCoverageSeedMap(
  semanticIr: SemanticIrModel,
  directBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
  promotionBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): Map<string, NamingSeedCandidate> {
  const coverageBySymbolKey = new Map<string, NamingSeedCandidate>();
  for (const [symbolKey, seed] of directBySymbolKey) {
    coverageBySymbolKey.set(symbolKey, pickStrongerSeed(coverageBySymbolKey.get(symbolKey), seed));
  }
  for (const [symbolKey, seed] of promotionBySymbolKey) {
    coverageBySymbolKey.set(symbolKey, pickStrongerSeed(coverageBySymbolKey.get(symbolKey), seed));
  }

  for (const symbol of semanticIr.symbols) {
    for (const alternative of symbol.alternatives) {
      if (typeof alternative !== "string" || alternative.length === 0) {
        continue;
      }
      const candidate = candidateFromAlternative(symbol.confidence, alternative);
      coverageBySymbolKey.set(symbol.symbolKey, pickStrongerSeed(coverageBySymbolKey.get(symbol.symbolKey), candidate));
    }
  }
  return coverageBySymbolKey;
}

function mergeSeedMaps(
  baseBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
  appendBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): Map<string, NamingSeedCandidate> {
  const merged = new Map<string, NamingSeedCandidate>();
  for (const [symbolKey, seed] of baseBySymbolKey) {
    merged.set(symbolKey, seed);
  }
  for (const [symbolKey, seed] of appendBySymbolKey) {
    merged.set(symbolKey, pickStrongerSeed(merged.get(symbolKey), seed));
  }
  return merged;
}

function buildSemanticSeedMaps(semanticIr: SemanticIrModel): SemanticSeedMaps {
  const directBySymbolKey = new Map<string, NamingSeedCandidate>();
  const promotionBySymbolKey = new Map<string, NamingSeedCandidate>();
  const fingerprintBySymbolKey = new Map(
    semanticIr.declarationFingerprints.map((fingerprint) => [fingerprint.symbolKey, fingerprint]),
  );
  const ledgerEntryBySymbolKey = new Map(
    semanticIr.evidenceLedger.entries.map((entry) => [entry.symbolKey, entry]),
  );

  const registerCandidate = (
    symbolKey: string,
    candidate: NamingSeedCandidate,
    promote: boolean,
  ): void => {
    directBySymbolKey.set(symbolKey, pickStrongerSeed(directBySymbolKey.get(symbolKey), candidate));
    if (!promote) {
      return;
    }
    const promoted: NamingSeedCandidate = {
      name: candidate.name,
      confidence: clamp(candidate.confidence + 0.04),
      source: "promotion",
      signalScore: clamp(candidate.signalScore + 0.05),
    };
    promotionBySymbolKey.set(symbolKey, pickStrongerSeed(promotionBySymbolKey.get(symbolKey), promoted));
  };

  for (const symbol of semanticIr.symbols) {
    const fingerprint = fingerprintBySymbolKey.get(symbol.symbolKey);
    const ledgerEntry = ledgerEntryBySymbolKey.get(symbol.symbolKey);
    if (ledgerEntry) {
      for (const candidate of ledgerEntry.candidates.slice(0, 6)) {
        if (!isIdentifierName(candidate.name)) {
          continue;
        }
        const quality = scoreNameQuality(candidate.name);
        if (quality < 0.52) {
          continue;
        }
        const supportBoost = Math.min(0.12, candidate.supportCount * 0.02);
        const provenanceBoost = Math.min(0.1, candidate.provenance.length * 0.02);
        const confidence = clamp(
          Math.max(
            symbol.confidence * 0.86,
            candidate.score * 0.9,
            quality * 0.7 + provenanceBoost * 0.2,
          ),
        );
        const signalScore = clamp(
          candidate.score * 0.58 +
          quality * 0.24 +
          supportBoost +
          provenanceBoost +
          (candidate.name === ledgerEntry.winnerName ? 0.04 : 0),
        );
        const promote =
          candidate.name === ledgerEntry.winnerName &&
          candidate.score >= 0.62 &&
          quality >= 0.6 &&
          (isGenericName(symbol.name) || quality >= scoreNameQuality(symbol.name) + 0.02);
        registerCandidate(
          symbol.symbolKey,
          {
            name: candidate.name,
            confidence,
            source: "direct",
            signalScore,
          },
          promote,
        );
      }
    }

    if (fingerprint) {
      const generatedName = roleBasedName(symbol.name, fingerprint);
      if (!isIdentifierName(generatedName)) {
        continue;
      }
      const quality = scoreNameQuality(generatedName);
      if (quality < 0.54) {
        continue;
      }
      const confidence = clamp(
        Math.max(
          symbol.confidence * 0.82,
          fingerprint.confidence * 0.94,
          quality * 0.68,
        ),
      );
      const signalScore = clamp(
        fingerprint.confidence * 0.55 +
        quality * 0.25 +
        Math.min(0.1, fingerprint.callGraphNeighborhood.outgoingCount * 0.01) +
        Math.min(0.1, fingerprint.stateKeys.length * 0.01),
      );
      const promote = isGenericName(symbol.name) && quality >= 0.58;
      registerCandidate(
        symbol.symbolKey,
        {
          name: generatedName,
          confidence,
          source: "direct",
          signalScore,
        },
        promote,
      );
    }
  }

  return {
    directBySymbolKey,
    promotionBySymbolKey,
  };
}

function shouldApplyCoverageSeed(symbol: SemanticIrModel["symbols"][number], seed: NamingSeedCandidate): boolean {
  const currentQuality = scoreNameQuality(symbol.name);
  const seedQuality = scoreNameQuality(seed.name);
  if (isCoverageSymbolKey(symbol.symbolKey)) {
    return true;
  }
  if (seedQuality >= currentQuality + 0.01) {
    return true;
  }
  if (isGenericName(symbol.name) && !isGenericName(seed.name)) {
    return true;
  }
  return false;
}

function applyCoverageNaming(
  semanticIr: SemanticIrModel,
  coverageBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): SemanticIrModel {
  const symbols = semanticIr.symbols.map((symbol) => {
    const seed = coverageBySymbolKey.get(symbol.symbolKey);
    if (!seed) {
      return symbol;
    }
    if (!shouldApplyCoverageSeed(symbol, seed)) {
      return symbol;
    }
    return {
      ...symbol,
      name: seed.name,
      quality: Math.max(symbol.quality, scoreNameQuality(seed.name)),
      confidence: Math.max(symbol.confidence, seed.confidence),
    };
  });
  return {
    ...semanticIr,
    symbols,
  };
}

function augmentCoverageSemanticIrWithMonolithVariables(
  semanticIr: SemanticIrModel,
  directBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): SemanticIrModel {
  const existingSymbolKeys = new Set<string>(semanticIr.symbols.map((symbol) => symbol.symbolKey));
  const symbols = [...semanticIr.symbols];
  const declarations = [...semanticIr.domainDeclarations];
  let injectedCount = 0;

  for (const [symbolKey, seed] of directBySymbolKey) {
    if (!isCoverageVariableSymbolKey(symbolKey)) {
      continue;
    }
    if (existingSymbolKeys.has(symbolKey)) {
      continue;
    }
    const owner = ownerFromCoverageSymbolKey(symbolKey);
    const domainKind = inferDomainKindForCoverageName(seed.name);
    const preferredArchetype = archetypeForDomainKind(domainKind);
    const declarationClusterId = `cluster:${owner}:coverage:${domainKind}`;
    const confidence = clamp(Math.max(seed.confidence, 0.54));
    const quality = clamp(Math.max(scoreNameQuality(seed.name), 0.56));

    symbols.push({
      symbolKey,
      owner,
      name: seed.name,
      confidence,
      quality,
      alternatives: [],
      evidenceIds: [`coverage-seed:${symbolKey}`],
      provenance: ["monolith-census"],
      domainKind,
      preferredArchetype,
      declarationClusterId,
      routeFlowScore: 0,
      eventFlowScore: 0,
    });

    declarations.push({
      declarationId: `${symbolKey}::${domainKind}`,
      symbolKey,
      symbolName: seed.name,
      ownerLineageId: owner,
      domainKind,
      preferredArchetype,
      clusterId: declarationClusterId,
      callNeighbours: [],
      stateSignals: [],
      routeFlowScore: 0,
      eventFlowScore: 0,
      confidence,
    });

    existingSymbolKeys.add(symbolKey);
    injectedCount += 1;
  }

  if (injectedCount < 1) {
    return semanticIr;
  }

  return {
    ...semanticIr,
    symbols: symbols.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    domainDeclarations: declarations.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
}

async function readSeedMap(symbolTablePath: string, typingHints: TypingHintMaps): Promise<SeedMapSplit> {
  const symbolTable = await readJsonFile<MonolithSymbolTableModel>(symbolTablePath);
  const directBySymbolKey = new Map<string, NamingSeedCandidate>();
  const promotionBySymbolKey = new Map<string, NamingSeedCandidate>();
  for (const entry of symbolTable.entries) {
    if (typeof entry.symbolKey !== "string" || entry.symbolKey.length === 0) {
      continue;
    }
    if (typeof entry.finalName !== "string" || entry.finalName.length === 0) {
      continue;
    }
    const functionHint = typingHints.functionBySymbolKey.get(entry.symbolKey);
    const variableKey = coverageVariableKey(entry.symbolKey);
    const variableHint = variableKey ? typingHints.variableByKey.get(variableKey) : undefined;
    const typingBoost = functionHint ? 0.12 : variableHint && variableHint.inferredType !== "unknown" ? 0.08 : 0;
    const signalScore = clamp((typeof entry.signalScore === "number" ? entry.signalScore : 0.42) + typingBoost);
    const directName = variableHint ? typedNameFromSeed(entry.finalName, variableHint.inferredType) : entry.finalName;
    const directCandidate: NamingSeedCandidate = {
      name: directName,
      confidence: clamp(0.46 + signalScore * 0.4),
      source: "direct",
      signalScore,
    };
    directBySymbolKey.set(entry.symbolKey, pickStrongerSeed(directBySymbolKey.get(entry.symbolKey), directCandidate));

    if (!entry.promoteToQuality) {
      continue;
    }
    const promotedKey = toPromotionKey(entry.symbolKey);
    if (promotedKey === entry.symbolKey) {
      continue;
    }
    const promotedName = variableHint ? typedNameFromSeed(entry.finalName, variableHint.inferredType) : entry.finalName;
    const promotedCandidate: NamingSeedCandidate = {
      name: promotedName,
      confidence: clamp(0.7 + signalScore * 0.28),
      source: "promotion",
      signalScore,
    };
    promotionBySymbolKey.set(promotedKey, pickStrongerSeed(promotionBySymbolKey.get(promotedKey), promotedCandidate));
  }
  return {
    directBySymbolKey,
    promotionBySymbolKey,
  };
}

async function executeNamingMemory(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<NamingMemoryStageInput>(request.inputPath);
  if (input.promotionBudget < 1) {
    throw new Error(`promotionBudget must be >= 1, got ${input.promotionBudget}`);
  }
  const semanticIr = await readJsonFile<SemanticIrModel>(input.semanticIrPath);
  const namingMemory = await readNamingMemoryFromPath(input.namingMemoryPath);
  const typingHints = await readTypingHintMaps(input.monolithTypingHintsPath);
  const seedMap = await readSeedMap(input.monolithSymbolTablePath, typingHints);
  const semanticSeedMaps = buildSemanticSeedMaps(semanticIr);
  const mergedDirectBySymbolKey = mergeSeedMaps(seedMap.directBySymbolKey, semanticSeedMaps.directBySymbolKey);
  const mergedPromotionBySymbolKey = mergeSeedMaps(seedMap.promotionBySymbolKey, semanticSeedMaps.promotionBySymbolKey);
  const coverageSemanticIr = augmentCoverageSemanticIrWithMonolithVariables(semanticIr, mergedDirectBySymbolKey);
  const coverageSeedMap = buildCoverageSeedMap(coverageSemanticIr, mergedDirectBySymbolKey, mergedPromotionBySymbolKey);
  const coverageNamedSemanticIr = applyCoverageNaming(coverageSemanticIr, coverageSeedMap);
  const promotionSelection = selectPromotionSeeds(
    semanticIr,
    namingMemory,
    mergedDirectBySymbolKey,
    mergedPromotionBySymbolKey,
    input.promotionBudget,
  );
  const seedBySymbolKey = new Map<string, NamingSeedCandidate>();
  for (const [symbolKey, candidate] of mergedDirectBySymbolKey) {
    seedBySymbolKey.set(symbolKey, pickStrongerSeed(seedBySymbolKey.get(symbolKey), candidate));
  }
  for (const [symbolKey, candidate] of promotionSelection.selectedBySymbolKey) {
    seedBySymbolKey.set(symbolKey, pickStrongerSeed(seedBySymbolKey.get(symbolKey), candidate));
  }
  const memoryBySymbolKey = buildMemoryEntryMap(namingMemory);
  const baselineQualityBefore = averageQualityForSemanticSymbols(semanticIr, (symbolKey, fallbackName) => {
    const memoryEntry = memoryBySymbolKey.get(symbolKey);
    return memoryEntry ? memoryEntry.currentName : fallbackName;
  });

  const updateResult = updateNamingMemory(namingMemory, semanticIr, input.runId, seedBySymbolKey);
  const namedSemanticIr = applyNamingMemory(semanticIr, updateResult.namingMemory);
  const baselineQualityAfter = averageQualityForSemanticSymbols(namedSemanticIr, (_symbolKey, fallbackName) => fallbackName);
  const baselineGuardPassed = baselineQualityAfter + 0.0001 >= baselineQualityBefore;
  if (!baselineGuardPassed) {
    throw new Error(
      `Naming baseline guard failed: before=${baselineQualityBefore.toFixed(4)} after=${baselineQualityAfter.toFixed(4)}`,
    );
  }

  await fs.mkdir(path.dirname(input.namingMemoryPath), { recursive: true });
  await fs.mkdir(path.dirname(input.snapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(input.namedSemanticIrPath), { recursive: true });
  await fs.mkdir(path.dirname(input.coverageNamedSemanticIrPath), { recursive: true });
  await writeJsonFile(input.namingMemoryPath, updateResult.namingMemory);
  await writeJsonFile(input.snapshotPath, updateResult.namingMemory);
  await writeJsonFile(input.namedSemanticIrPath, namedSemanticIr);
  await writeJsonFile(input.coverageNamedSemanticIrPath, coverageNamedSemanticIr);

  const output: NamingMemoryStageOutput = {
    namingMemoryPath: input.namingMemoryPath,
    snapshotPath: input.snapshotPath,
    namedSemanticIrPath: input.namedSemanticIrPath,
    qualityNamedSemanticIrPath: input.namedSemanticIrPath,
    coverageNamedSemanticIrPath: input.coverageNamedSemanticIrPath,
    insertedEntryCount: updateResult.insertedEntryCount,
    updatedEntryCount: updateResult.updatedEntryCount,
    keptEntryCount: updateResult.keptEntryCount,
    promotionBudget: input.promotionBudget,
    promotionCandidateCount: promotionSelection.candidateCount,
    promotionSelectedCount: promotionSelection.selectedCount,
    promotionRejectedCount: promotionSelection.rejectedCount,
    baselineQualityBefore,
    baselineQualityAfter,
    baselineGuardPassed,
  };
  await writeJsonFile(request.outputPath, output);
}

export const namingMemoryStage: PipelineStage = {
  id: "naming-memory",
  execute: executeNamingMemory,
};
