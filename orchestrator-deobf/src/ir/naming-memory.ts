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

interface NameVariantCandidate {
  name: string;
  confidence: number;
  signalScore: number;
  source: "symbol" | "alternative" | "seed";
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

function scoreVariant(
  symbol: SemanticSymbol,
  variant: NameVariantCandidate,
): number {
  const quality = scoreNameQuality(variant.name);
  const genericPenalty = isGenericName(variant.name) ? 0.2 : 0;
  const provenanceBoost = Math.min(0.12, symbol.provenance.length * 0.02);
  const evidenceBoost = Math.min(0.08, symbol.evidenceIds.length * 0.004);
  const sourceBoost = variant.source === "seed" ? 0.07 : variant.source === "alternative" ? 0.03 : 0;
  const signalBoost = variant.signalScore * 0.06;
  return clamp(
    variant.confidence * 0.36 +
      quality * 0.44 +
      provenanceBoost +
      evidenceBoost +
      sourceBoost +
      signalBoost -
      genericPenalty,
  );
}

function pickBestRerankVariant(
  symbol: SemanticSymbol,
  selectedSeed: NamingSeedCandidate | undefined,
): SemanticSymbol {
  const variantByName = new Map<string, NameVariantCandidate>();
  const registerVariant = (variant: NameVariantCandidate): void => {
    const normalized = variant.name.trim();
    if (normalized.length === 0) {
      return;
    }
    const key = normalized.toLowerCase();
    const existing = variantByName.get(key);
    if (!existing) {
      variantByName.set(key, { ...variant, name: normalized });
      return;
    }
    const existingScore = scoreVariant(symbol, existing);
    const candidateScore = scoreVariant(symbol, variant);
    if (candidateScore > existingScore) {
      variantByName.set(key, { ...variant, name: normalized });
    }
  };

  registerVariant({
    name: symbol.name,
    confidence: symbol.confidence,
    signalScore: 0.5,
    source: "symbol",
  });

  for (const alternative of symbol.alternatives) {
    registerVariant({
      name: alternative,
      confidence: clamp(symbol.confidence * 0.93),
      signalScore: 0.44,
      source: "alternative",
    });
  }

  if (selectedSeed) {
    registerVariant({
      name: selectedSeed.name,
      confidence: Math.max(symbol.confidence, selectedSeed.confidence),
      signalScore: selectedSeed.signalScore,
      source: "seed",
    });
  }

  const ranked = [...variantByName.values()]
    .map((variant) => ({
      variant,
      score: scoreVariant(symbol, variant),
      quality: scoreNameQuality(variant.name),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.quality !== right.quality) {
        return right.quality - left.quality;
      }
      return left.variant.name.localeCompare(right.variant.name);
    });
  const winner = ranked[0];
  const baseline = ranked.find((entry) => entry.variant.name === symbol.name) ?? winner;
  if (!winner || !baseline) {
    return symbol;
  }

  if (winner.variant.name === symbol.name) {
    return symbol;
  }

  const qualityGain = winner.quality - baseline.quality;
  const scoreGain = winner.score - baseline.score;
  const genericUpgrade = isGenericName(symbol.name) && !isGenericName(winner.variant.name);
  const shouldAdopt =
    qualityGain >= 0.03 ||
    (genericUpgrade && scoreGain >= -0.02) ||
    (scoreGain >= 0.045 && winner.quality >= baseline.quality);
  if (!shouldAdopt) {
    return symbol;
  }

  const alternatives = ranked
    .map((entry) => entry.variant.name)
    .filter((name) => name !== winner.variant.name)
    .slice(0, 8);
  return {
    ...symbol,
    name: winner.variant.name,
    quality: Math.max(symbol.quality, winner.quality),
    confidence: Math.max(symbol.confidence, winner.variant.confidence),
    alternatives,
  };
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

function isCoverageSymbolKey(symbolKey: string): boolean {
  return symbolKey.includes("-census:");
}

function buildSeededCandidate(
  symbol: SemanticSymbol,
  seedBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
): SemanticSymbol {
  const seed = seedBySymbolKey.get(symbol.symbolKey);
  if (!seed) {
    return pickBestRerankVariant(symbol, undefined);
  }

  if (seed.source === "promotion" && isSyntheticCoverageName(seed.name)) {
    return pickBestRerankVariant(symbol, undefined);
  }

  if (seed.source === "direct" && isCoverageSymbolKey(symbol.symbolKey)) {
    const seededCoverage = {
      ...symbol,
      name: seed.name,
      quality: scoreNameQuality(seed.name),
      confidence: Math.max(symbol.confidence, seed.confidence),
    };
    return pickBestRerankVariant(seededCoverage, seed);
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
    return pickBestRerankVariant(symbol, undefined);
  }

  const seeded = {
    ...symbol,
    name: seed.name,
    quality: seedQuality,
    confidence: Math.max(symbol.confidence, seed.confidence),
  };
  return pickBestRerankVariant(seeded, seed);
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
  if (candidateQuality >= currentQuality + 0.12 && candidateScore >= entry.currentScore * 0.78) {
    return true;
  }
  if (candidateQuality > currentQuality && candidateScore >= entry.currentScore && symbol.name.length <= entry.currentName.length + 12) {
    return true;
  }
  if (candidateScore > entry.currentScore + 0.01) {
    return true;
  }
  if (!isGenericName(symbol.name) && isGenericName(entry.currentName) && candidateScore >= entry.currentScore * 0.72) {
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
