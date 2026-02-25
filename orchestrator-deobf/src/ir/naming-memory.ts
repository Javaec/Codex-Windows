import { SemanticIrModel, SemanticSymbol } from "./semantic-ir";
import { isGenericName, scoreNameQuality } from "./name-quality";

export interface NamingMemoryHistoryEvent {
  runId: string;
  updatedAtIso: string;
  candidateName: string;
  candidateScore: number;
  accepted: boolean;
  evidenceIds: string[];
}

export interface NamingMemoryEntry {
  symbolKey: string;
  currentName: string;
  currentScore: number;
  updatedAtIso: string;
  evidenceIds: string[];
  history: NamingMemoryHistoryEvent[];
}

export interface NamingMemoryModel {
  version: number;
  updatedAtIso: string;
  entries: NamingMemoryEntry[];
}

export interface NamingMemoryUpdateResult {
  namingMemory: NamingMemoryModel;
  insertedEntryCount: number;
  updatedEntryCount: number;
  keptEntryCount: number;
}

export interface NamingSeedCandidate {
  name: string;
  confidence: number;
  source: "direct" | "promotion";
  signalScore: number;
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

function buildCandidateScore(symbol: SemanticSymbol): number {
  return clamp(symbol.confidence * Math.max(symbol.quality, 0.1));
}

function isSyntheticCoverageName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.startsWith("classunit")) {
    return true;
  }
  if (normalized.startsWith("functionunit")) {
    return true;
  }
  if (normalized.startsWith("callableunit")) {
    return true;
  }
  if (normalized.startsWith("valueunit")) {
    return true;
  }
  return false;
}

function buildSeededCandidate(
  symbol: SemanticSymbol,
  seedBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): SemanticSymbol {
  const seed = seedBySymbolKey.get(symbol.symbolKey);
  if (!seed) {
    return symbol;
  }

  if (seed.source === "promotion" && isSyntheticCoverageName(seed.name)) {
    return symbol;
  }

  const currentQuality = scoreNameQuality(symbol.name);
  const seedQuality = scoreNameQuality(seed.name);
  const isPromotion = seed.source === "promotion";
  const shouldUseDirectSeed =
    !isPromotion &&
    (isGenericName(symbol.name) || currentQuality < 0.56) &&
    seedQuality >= currentQuality + 0.03 &&
    seed.signalScore >= 0.45;
  const shouldUsePromotionSeed =
    isPromotion &&
    (isGenericName(symbol.name) || currentQuality < 0.74) &&
    seedQuality >= currentQuality + 0.04 &&
    seed.signalScore >= 0.68;

  if (!shouldUseDirectSeed && !shouldUsePromotionSeed) {
    return symbol;
  }

  return {
    ...symbol,
    name: seed.name,
    quality: seedQuality,
    confidence: Math.max(symbol.confidence, seed.confidence),
  };
}

function shouldUpgrade(entry: NamingMemoryEntry, symbol: SemanticSymbol, candidateScore: number): boolean {
  const currentQuality = scoreNameQuality(entry.currentName);
  const candidateQuality = scoreNameQuality(symbol.name);
  if (!isGenericName(entry.currentName) && isGenericName(symbol.name)) {
    return false;
  }
  if (candidateQuality + 0.01 < currentQuality) {
    return false;
  }
  if (candidateQuality >= currentQuality + 0.08 && candidateScore >= entry.currentScore * 0.9) {
    return true;
  }
  if (candidateQuality > currentQuality && candidateScore >= entry.currentScore && symbol.name.length <= entry.currentName.length + 12) {
    return true;
  }
  if (candidateScore > entry.currentScore + 0.01) {
    return true;
  }
  if (isGenericName(entry.currentName) && !isGenericName(symbol.name) && candidateScore >= entry.currentScore * 0.9) {
    return true;
  }
  if (candidateScore === entry.currentScore && entry.currentName !== symbol.name) {
    if (isGenericName(entry.currentName) && !isGenericName(symbol.name)) {
      return true;
    }
    if (symbol.name.length > entry.currentName.length + 2) {
      return true;
    }
  }
  return false;
}

function historyEvent(runId: string, symbol: SemanticSymbol, candidateScore: number, accepted: boolean): NamingMemoryHistoryEvent {
  return {
    runId,
    updatedAtIso: new Date().toISOString(),
    candidateName: symbol.name,
    candidateScore,
    accepted,
    evidenceIds: [...symbol.evidenceIds],
  };
}

function trimHistory(history: NamingMemoryHistoryEvent[]): NamingMemoryHistoryEvent[] {
  return history.slice(-32);
}

export function updateNamingMemory(
  currentMemory: NamingMemoryModel,
  semanticIr: SemanticIrModel,
  runId: string,
  seedBySymbolKey: ReadonlyMap<string, NamingSeedCandidate> = new Map<string, NamingSeedCandidate>(),
): NamingMemoryUpdateResult {
  const entriesByKey = new Map<string, NamingMemoryEntry>();
  for (const entry of currentMemory.entries) {
    entriesByKey.set(entry.symbolKey, { ...entry, history: [...entry.history], evidenceIds: [...entry.evidenceIds] });
  }

  let insertedEntryCount = 0;
  let updatedEntryCount = 0;
  let keptEntryCount = 0;
  const orderedSymbols = [...semanticIr.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  for (const symbol of orderedSymbols) {
    const candidateSymbol = buildSeededCandidate(symbol, seedBySymbolKey);
    const score = buildCandidateScore(candidateSymbol);
    const existing = entriesByKey.get(symbol.symbolKey);
    if (!existing) {
      const created: NamingMemoryEntry = {
        symbolKey: symbol.symbolKey,
        currentName: candidateSymbol.name,
        currentScore: score,
        updatedAtIso: new Date().toISOString(),
        evidenceIds: [...candidateSymbol.evidenceIds],
        history: [historyEvent(runId, candidateSymbol, score, true)],
      };
      entriesByKey.set(symbol.symbolKey, created);
      insertedEntryCount += 1;
      continue;
    }

    if (shouldUpgrade(existing, candidateSymbol, score)) {
      existing.currentName = candidateSymbol.name;
      existing.currentScore = score;
      existing.updatedAtIso = new Date().toISOString();
      existing.evidenceIds = [...candidateSymbol.evidenceIds];
      existing.history = trimHistory([...existing.history, historyEvent(runId, candidateSymbol, score, true)]);
      updatedEntryCount += 1;
      continue;
    }

    existing.history = trimHistory([...existing.history, historyEvent(runId, candidateSymbol, score, false)]);
    keptEntryCount += 1;
  }

  const namingMemory: NamingMemoryModel = {
    version: 1,
    updatedAtIso: new Date().toISOString(),
    entries: [...entriesByKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
  };
  return {
    namingMemory,
    insertedEntryCount,
    updatedEntryCount,
    keptEntryCount,
  };
}

export function createEmptyNamingMemory(): NamingMemoryModel {
  return {
    version: 1,
    updatedAtIso: new Date().toISOString(),
    entries: [],
  };
}

export function applyNamingMemory(semanticIr: SemanticIrModel, namingMemory: NamingMemoryModel): SemanticIrModel {
  const memoryByKey = new Map<string, NamingMemoryEntry>();
  for (const entry of namingMemory.entries) {
    memoryByKey.set(entry.symbolKey, entry);
  }

  const symbols = semanticIr.symbols.map((symbol) => {
    const memoryEntry = memoryByKey.get(symbol.symbolKey);
    if (!memoryEntry) {
      return symbol;
    }
    return {
      ...symbol,
      name: memoryEntry.currentName,
      confidence: Math.max(symbol.confidence, memoryEntry.currentScore),
    };
  });
  return {
    ...semanticIr,
    symbols,
  };
}
