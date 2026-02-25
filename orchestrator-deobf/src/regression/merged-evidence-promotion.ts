import * as fs from "node:fs/promises";
import { createEmptyNamingMemory, NamingMemoryModel, updateNamingMemory } from "../ir/naming-memory";
import { DomainArchetype, DomainKind, SemanticIrModel, SemanticSymbol } from "../ir/semantic-ir";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { MergedEvidenceReport, MergedSymbolEvidence } from "./execute-suite";

interface PromotionCandidate {
  symbol: MergedSymbolEvidence;
  rankingScore: number;
}

export interface ApplyMergedEvidencePromotionOptions {
  mergedEvidencePath: string;
  namingMemoryPath: string;
  legacyNamingMemoryPath: string;
  runId: string;
  promotionBudget: number;
}

export interface ApplyMergedEvidencePromotionResult {
  mergedEvidencePath: string;
  namingMemoryPath: string;
  promotionBudget: number;
  candidateCount: number;
  selectedCount: number;
  insertedEntryCount: number;
  updatedEntryCount: number;
  keptEntryCount: number;
  averageSelectedQuality: number;
}

const MIN_PROMOTION_CONFIDENCE = 0.28;
const MIN_PROMOTION_QUALITY = 0.56;

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function readNamingMemoryFromPath(namingMemoryPath: string): Promise<NamingMemoryModel> {
  if (!(await fileExists(namingMemoryPath))) {
    return createEmptyNamingMemory();
  }
  return await readJsonFile<NamingMemoryModel>(namingMemoryPath);
}

function inferDomainKind(symbolName: string): DomainKind {
  const lower = symbolName.toLowerCase();
  if (lower.includes("hook") || lower.startsWith("use")) {
    return "hook";
  }
  if (lower.includes("store") || lower.includes("state")) {
    return "store";
  }
  if (lower.includes("transport") || lower.includes("ipc") || lower.includes("rpc")) {
    return "transport";
  }
  if (lower.includes("view") || lower.includes("component") || lower.includes("render") || lower.includes("ui")) {
    return "ui";
  }
  if (lower.includes("service") || lower.includes("client")) {
    return "service";
  }
  return "use-case";
}

function archetypeForDomain(kind: DomainKind): DomainArchetype {
  if (kind === "hook") {
    return "hook";
  }
  if (kind === "store") {
    return "store";
  }
  if (kind === "transport") {
    return "transport";
  }
  if (kind === "ui") {
    return "ui";
  }
  return "service";
}

function toSemanticSymbol(symbol: MergedSymbolEvidence, index: number): SemanticSymbol {
  const inferredQuality = clamp(scoreNameQuality(symbol.symbolName));
  const confidence = clamp(Math.max(symbol.confidence, Math.min(0.99, symbol.mergedScore)));
  const domainKind = inferDomainKind(symbol.symbolName);
  return {
    symbolKey: symbol.symbolKey,
    owner: "merged-evidence",
    name: symbol.symbolName,
    confidence,
    quality: inferredQuality,
    alternatives: [],
    evidenceIds: [`merged-evidence:${symbol.runId}:${index}`],
    provenance: [...symbol.provenance],
    domainKind,
    preferredArchetype: archetypeForDomain(domainKind),
    declarationClusterId: "cluster-merged-evidence-promotion",
    routeFlowScore: 0,
    eventFlowScore: 0,
  };
}

function buildPromotionCandidates(report: MergedEvidenceReport): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  for (const symbol of report.symbolWinners) {
    const quality = clamp(typeof symbol.quality === "number" ? symbol.quality : scoreNameQuality(symbol.symbolName));
    const confidence = clamp(symbol.confidence);
    if (confidence < MIN_PROMOTION_CONFIDENCE) {
      continue;
    }
    if (quality < MIN_PROMOTION_QUALITY) {
      continue;
    }
    if (isGenericName(symbol.symbolName) && quality < 0.74) {
      continue;
    }
    const rankingScore = Number((symbol.mergedScore * 0.68 + quality * 0.22 + confidence * 0.1).toFixed(4));
    candidates.push({
      symbol,
      rankingScore,
    });
  }
  candidates.sort((left, right) => {
    if (left.rankingScore !== right.rankingScore) {
      return right.rankingScore - left.rankingScore;
    }
    if (left.symbol.quality !== right.symbol.quality) {
      return right.symbol.quality - left.symbol.quality;
    }
    return left.symbol.symbolKey.localeCompare(right.symbol.symbolKey);
  });
  return candidates;
}

function buildSyntheticSemanticIr(selected: MergedSymbolEvidence[]): SemanticIrModel {
  const symbols = selected.map((symbol, index) => toSemanticSymbol(symbol, index));
  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    fileHints: [],
    symbols,
    callEdges: [],
    stateKeys: [],
    sourceMaps: [],
    domainDeclarations: [],
    declarationClusters: [],
  };
}

function averageSelectedQuality(selected: MergedSymbolEvidence[]): number {
  if (selected.length === 0) {
    return 0;
  }
  const total = selected.reduce((sum, symbol) => sum + clamp(scoreNameQuality(symbol.symbolName)), 0);
  return clamp(total / selected.length);
}

export async function applyMergedEvidencePromotion(
  options: ApplyMergedEvidencePromotionOptions,
): Promise<ApplyMergedEvidencePromotionResult> {
  if (options.promotionBudget < 1) {
    throw new Error(`promotion budget must be >= 1, got ${options.promotionBudget}`);
  }
  const mergedEvidence = await readJsonFile<MergedEvidenceReport>(options.mergedEvidencePath);
  const namingMemory = await readNamingMemoryFromPath(options.namingMemoryPath);
  const promotionCandidates = buildPromotionCandidates(mergedEvidence);
  const selectedCandidates = promotionCandidates.slice(0, options.promotionBudget).map((entry) => entry.symbol);
  const syntheticSemanticIr = buildSyntheticSemanticIr(selectedCandidates);
  const updateResult = updateNamingMemory(namingMemory, syntheticSemanticIr, options.runId);

  await writeJsonFile(options.namingMemoryPath, updateResult.namingMemory);
  await writeJsonFile(options.legacyNamingMemoryPath, updateResult.namingMemory);

  return {
    mergedEvidencePath: options.mergedEvidencePath,
    namingMemoryPath: options.namingMemoryPath,
    promotionBudget: options.promotionBudget,
    candidateCount: promotionCandidates.length,
    selectedCount: selectedCandidates.length,
    insertedEntryCount: updateResult.insertedEntryCount,
    updatedEntryCount: updateResult.updatedEntryCount,
    keptEntryCount: updateResult.keptEntryCount,
    averageSelectedQuality: averageSelectedQuality(selectedCandidates),
  };
}

