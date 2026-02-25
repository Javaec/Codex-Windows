import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NamingMemoryStageInput, NamingMemoryStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { SemanticIrModel } from "../ir/semantic-ir";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
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
  promotionBySymbolKey: ReadonlyMap<string, NamingSeedCandidate>,
  promotionBudget: number,
): PromotionSelectionSummary {
  const symbolByKey = buildSemanticSymbolMap(semanticIr);
  const memoryByKey = buildMemoryEntryMap(namingMemory);
  const candidates: PromotionBudgetCandidate[] = [];

  for (const [symbolKey, seed] of promotionBySymbolKey) {
    const symbol = symbolByKey.get(symbolKey);
    if (!symbol) {
      continue;
    }
    if (seed.source !== "promotion") {
      continue;
    }

    const memoryEntry = memoryByKey.get(symbolKey);
    const baselineName = memoryEntry ? memoryEntry.currentName : symbol.name;
    const baselineQuality = scoreNameQuality(baselineName);
    const candidateQuality = scoreNameQuality(seed.name);
    if (candidateQuality < baselineQuality + 0.035) {
      continue;
    }
    if (isGenericName(seed.name) && !isGenericName(baselineName)) {
      continue;
    }

    const baselineScore = memoryEntry ? memoryEntry.currentScore : candidateScoreFromSymbol(symbol, undefined);
    const candidateScore = candidateScoreFromSymbol(symbol, seed.confidence);
    if (candidateScore + 0.015 < baselineScore) {
      continue;
    }
    const qualityGain = Number((candidateQuality - baselineQuality).toFixed(4));
    if (qualityGain <= 0) {
      continue;
    }
    const priority = Number((qualityGain * 0.5 + candidateQuality * 0.2 + seed.signalScore * 0.2 + candidateScore * 0.1).toFixed(4));
    candidates.push({
      symbolKey,
      seed,
      baselineQuality,
      candidateQuality,
      baselineScore,
      candidateScore,
      qualityGain,
      priority,
    });
  }

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
  const coverageSeedMap = buildCoverageSeedMap(semanticIr, seedMap.directBySymbolKey, seedMap.promotionBySymbolKey);
  const coverageNamedSemanticIr = applyCoverageNaming(semanticIr, coverageSeedMap);
  const promotionSelection = selectPromotionSeeds(semanticIr, namingMemory, seedMap.promotionBySymbolKey, input.promotionBudget);
  const seedBySymbolKey = new Map<string, NamingSeedCandidate>();
  for (const [symbolKey, candidate] of seedMap.directBySymbolKey) {
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
