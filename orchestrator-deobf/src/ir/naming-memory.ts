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

function shouldUpgrade(entry: NamingMemoryEntry, symbol: SemanticSymbol, candidateScore: number): boolean {
  const currentQuality = scoreNameQuality(entry.currentName);
  const candidateQuality = scoreNameQuality(symbol.name);
  if (!isGenericName(entry.currentName) && isGenericName(symbol.name)) {
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
    const score = buildCandidateScore(symbol);
    const existing = entriesByKey.get(symbol.symbolKey);
    if (!existing) {
      const created: NamingMemoryEntry = {
        symbolKey: symbol.symbolKey,
        currentName: symbol.name,
        currentScore: score,
        updatedAtIso: new Date().toISOString(),
        evidenceIds: [...symbol.evidenceIds],
        history: [historyEvent(runId, symbol, score, true)],
      };
      entriesByKey.set(symbol.symbolKey, created);
      insertedEntryCount += 1;
      continue;
    }

    if (shouldUpgrade(existing, symbol, score)) {
      existing.currentName = symbol.name;
      existing.currentScore = score;
      existing.updatedAtIso = new Date().toISOString();
      existing.evidenceIds = [...symbol.evidenceIds];
      existing.history = trimHistory([...existing.history, historyEvent(runId, symbol, score, true)]);
      updatedEntryCount += 1;
      continue;
    }

    existing.history = trimHistory([...existing.history, historyEvent(runId, symbol, score, false)]);
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
