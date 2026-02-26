import * as fs from "node:fs/promises";
import { createEmptyNamingMemory, NamingMemoryModel, updateNamingMemory } from "../ir/naming-memory";
import { DomainArchetype, DomainKind, SemanticIrModel, SemanticSymbol } from "../ir/semantic-ir";
import { isGenericName, scoreNameQuality } from "../ir/name-quality";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { MergedEvidenceReport, MergedSymbolEvidence } from "./execute-suite";

interface PromotionCandidate {
  symbol: MergedSymbolEvidence;
  rankingScore: number;
  candidateQuality: number;
  candidateConfidence: number;
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
const MAX_MONOTONIC_UPDATES_PER_CYCLE = 100;
const PROVENANCE_SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  asar: 0.76,
  webcrack: 1,
  wakaru: 0.96,
  "javascript-deobfuscator": 0.9,
  synchrony: 0.88,
  "unwebpack-sourcemap": 0.93,
};

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
  return "usecase";
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

function normalizeProvenanceTool(token: string): string {
  const lower = token.toLowerCase();
  if (lower.includes("webcrack")) {
    return "webcrack";
  }
  if (lower.includes("wakaru")) {
    return "wakaru";
  }
  if (lower.includes("javascript-deobfuscator")) {
    return "javascript-deobfuscator";
  }
  if (lower.includes("synchrony")) {
    return "synchrony";
  }
  if (lower.includes("unwebpack")) {
    return "unwebpack-sourcemap";
  }
  if (lower.includes("asar")) {
    return "asar";
  }
  return "asar";
}

function provenanceWeight(provenance: string[]): number {
  if (provenance.length === 0) {
    return 0.72;
  }
  const weights = provenance.map((token) => {
    const normalized = normalizeProvenanceTool(token);
    return PROVENANCE_SOURCE_WEIGHTS[normalized] ?? 0.76;
  });
  const average = weights.reduce((sum, value) => sum + value, 0) / Math.max(1, weights.length);
  return clamp(average);
}

function toSemanticSymbol(candidate: PromotionCandidate, index: number): SemanticSymbol {
  const symbol = candidate.symbol;
  const inferredQuality = candidate.candidateQuality;
  const confidence = candidate.candidateConfidence;
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

function buildCurrentNameBySymbolKey(namingMemory: NamingMemoryModel): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const entry of namingMemory.entries) {
    byKey.set(entry.symbolKey, entry.currentName);
  }
  return byKey;
}

function buildCurrentScoreBySymbolKey(namingMemory: NamingMemoryModel): ReadonlyMap<string, number> {
  const byKey = new Map<string, number>();
  for (const entry of namingMemory.entries) {
    byKey.set(entry.symbolKey, entry.currentScore);
  }
  return byKey;
}

function buildPromotionCandidates(
  report: MergedEvidenceReport,
  currentNameBySymbolKey: ReadonlyMap<string, string>,
  currentScoreBySymbolKey: ReadonlyMap<string, number>,
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  for (const symbol of report.symbolWinners) {
    const currentName = currentNameBySymbolKey.get(symbol.symbolKey);
    if (currentName && currentName === symbol.symbolName) {
      continue;
    }
    const quality = clamp(typeof symbol.quality === "number" ? symbol.quality : scoreNameQuality(symbol.symbolName));
    const confidence = clamp(symbol.confidence);
    const currentScore = currentScoreBySymbolKey.get(symbol.symbolKey) ?? 0;
    const sourceWeight = provenanceWeight(symbol.provenance);
    const baseConfidence = symbol.mergedScore * 0.4 + quality * 0.45 + sourceWeight * 0.25 + 0.05;
    const targetConfidence = currentScore > 0 ? (currentScore + 0.008) / Math.max(quality, 0.1) : 0;
    const candidateConfidence = clamp(Math.max(confidence, baseConfidence, targetConfidence));
    if (candidateConfidence < MIN_PROMOTION_CONFIDENCE) {
      continue;
    }
    if (quality < MIN_PROMOTION_QUALITY) {
      continue;
    }
    const currentQuality = currentName ? scoreNameQuality(currentName) : 0;
    if (quality + 0.003 < currentQuality) {
      continue;
    }
    if (currentName && isGenericName(symbol.symbolName) && !isGenericName(currentName)) {
      continue;
    }
    if (isGenericName(symbol.symbolName) && quality < 0.74) {
      continue;
    }
    const qualityGain = quality - currentQuality;
    const confidenceGain = candidateConfidence - currentScore;
    const snapshotProfileBoost = symbol.snapshotProfileId === report.dominantSnapshotProfileId
      ? symbol.snapshotProfileConfidence
      : (1 - symbol.snapshotProfileConfidence) * 0.35;
    const rankingScore = Number((
      symbol.mergedScore * 0.42 +
      quality * 0.24 +
      candidateConfidence * 0.19 +
      sourceWeight * 0.1 +
      snapshotProfileBoost * 0.04 +
      Math.max(0, qualityGain) * 0.04 +
      Math.max(0, confidenceGain) * 0.01
    ).toFixed(4));
    candidates.push({
      symbol,
      rankingScore,
      candidateQuality: quality,
      candidateConfidence,
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

function buildSyntheticSemanticIr(selected: PromotionCandidate[]): SemanticIrModel {
  const symbols = selected.map((candidate, index) => toSemanticSymbol(candidate, index));
  return {
    version: 3,
    generatedAtIso: new Date().toISOString(),
    obfuscationProfile: {
      profileId: "profile-v1",
      confidence: 0.35,
      adapterVersion: 1,
      signals: ["synthetic=merged-evidence-promotion"],
    },
    fileHints: [],
    symbols,
    callEdges: [],
    stateKeys: [],
    sourceMaps: [],
    domainDeclarations: [],
    declarationClusters: [],
    domainEntities: [],
    symbolProvenanceGraph: {
      nodes: [],
      edges: [],
    },
    exportContractGraph: {
      nodes: [],
      edges: [],
    },
  };
}

function averageSelectedQuality(selected: MergedSymbolEvidence[]): number {
  if (selected.length === 0) {
    return 0;
  }
  const total = selected.reduce((sum, symbol) => sum + clamp(scoreNameQuality(symbol.symbolName)), 0);
  return clamp(total / selected.length);
}

function trimHistory<T>(history: T[]): T[] {
  if (history.length <= 32) {
    return history;
  }
  return history.slice(history.length - 32);
}

function semanticTokenCount(name: string): number {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3).length;
}

function applyMonotonicPromotionFallback(
  namingMemory: NamingMemoryModel,
  selected: PromotionCandidate[],
  runId: string,
): { namingMemory: NamingMemoryModel; inserted: number; updated: number } {
  const byKey = new Map<string, NamingMemoryModel["entries"][number]>();
  for (const entry of namingMemory.entries) {
    byKey.set(entry.symbolKey, {
      ...entry,
      evidenceIds: [...entry.evidenceIds],
      history: [...entry.history],
    });
  }

  let inserted = 0;
  let updated = 0;
  let remainingUpdateBudget = MAX_MONOTONIC_UPDATES_PER_CYCLE;
  for (const [index, candidate] of selected.entries()) {
    const symbol = candidate.symbol;
    const candidateName = symbol.symbolName;
    const candidateQuality = candidate.candidateQuality;
    const candidateScore = clamp(candidate.candidateConfidence * Math.max(candidateQuality, 0.1));
    const evidenceId = `merged-evidence:${runId}:${index}`;
    const nowIso = new Date().toISOString();

    const existing = byKey.get(symbol.symbolKey);
    if (!existing) {
      byKey.set(symbol.symbolKey, {
        symbolKey: symbol.symbolKey,
        currentName: candidateName,
        currentScore: candidateScore,
        updatedAtIso: nowIso,
        evidenceIds: [evidenceId],
        history: [
          {
            runId,
            updatedAtIso: nowIso,
            candidateName,
            candidateScore,
            accepted: true,
            evidenceIds: [evidenceId],
          },
        ],
      });
      inserted += 1;
      continue;
    }

    if (existing.currentName === candidateName) {
      continue;
    }

    if (remainingUpdateBudget < 1) {
      break;
    }

    const currentQuality = scoreNameQuality(existing.currentName);
    if (candidateQuality + 0.001 < currentQuality) {
      continue;
    }
    if (isGenericName(candidateName) && !isGenericName(existing.currentName)) {
      continue;
    }
    const qualityUpgrade = candidateQuality >= currentQuality + 0.0001;
    const nonGenericUpgrade = isGenericName(existing.currentName) && !isGenericName(candidateName);
    const longerName = candidateName.length >= existing.currentName.length + 2;
    const currentTokenCount = semanticTokenCount(existing.currentName);
    const candidateTokenCount = semanticTokenCount(candidateName);
    const richerTokenShape = candidateTokenCount >= currentTokenCount + 1;
    const scoreLift = candidateScore >= existing.currentScore + 0.002;
    if (!qualityUpgrade && !nonGenericUpgrade && !longerName && !richerTokenShape && !scoreLift) {
      continue;
    }

    existing.currentName = candidateName;
    existing.currentScore = clamp(Math.max(existing.currentScore + 0.001, candidateScore));
    existing.updatedAtIso = nowIso;
    existing.evidenceIds = [evidenceId];
    existing.history = trimHistory([
      ...existing.history,
      {
        runId,
        updatedAtIso: nowIso,
        candidateName,
        candidateScore,
        accepted: true,
        evidenceIds: [evidenceId],
      },
    ]);
    updated += 1;
    remainingUpdateBudget -= 1;
  }

  return {
    namingMemory: {
      ...namingMemory,
      updatedAtIso: new Date().toISOString(),
      entries: [...byKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    inserted,
    updated,
  };
}

export async function applyMergedEvidencePromotion(
  options: ApplyMergedEvidencePromotionOptions,
): Promise<ApplyMergedEvidencePromotionResult> {
  if (options.promotionBudget < 1) {
    throw new Error(`promotion budget must be >= 1, got ${options.promotionBudget}`);
  }
  const mergedEvidence = await readJsonFile<MergedEvidenceReport>(options.mergedEvidencePath);
  const namingMemory = await readNamingMemoryFromPath(options.namingMemoryPath);
  const currentNameBySymbolKey = buildCurrentNameBySymbolKey(namingMemory);
  const currentScoreBySymbolKey = buildCurrentScoreBySymbolKey(namingMemory);
  const promotionCandidates = buildPromotionCandidates(
    mergedEvidence,
    currentNameBySymbolKey,
    currentScoreBySymbolKey,
  );
  const selectedPromotionCandidates = promotionCandidates.slice(0, options.promotionBudget);
  const selectedCandidates = selectedPromotionCandidates.map((entry) => entry.symbol);
  const selectedCandidateByKey = new Map<string, PromotionCandidate>();
  for (const candidate of selectedPromotionCandidates) {
    selectedCandidateByKey.set(candidate.symbol.symbolKey, candidate);
  }
  const selectedForSyntheticIr: PromotionCandidate[] = [];
  for (const selected of selectedCandidates) {
    const candidate = selectedCandidateByKey.get(selected.symbolKey);
    if (candidate) {
      selectedForSyntheticIr.push(candidate);
    }
  }
  if (selectedForSyntheticIr.length !== selectedCandidates.length) {
    throw new Error("applyMergedEvidencePromotion: inconsistent selected candidate set");
  }
  const syntheticSemanticIr = buildSyntheticSemanticIr(selectedForSyntheticIr);
  const updateResult = updateNamingMemory(namingMemory, syntheticSemanticIr, options.runId);
  const fallbackPromotion = applyMonotonicPromotionFallback(
    updateResult.namingMemory,
    selectedPromotionCandidates,
    options.runId,
  );
  const finalInserted = updateResult.insertedEntryCount + fallbackPromotion.inserted;
  const finalUpdated = updateResult.updatedEntryCount + fallbackPromotion.updated;
  const finalKept = Math.max(0, selectedCandidates.length - finalInserted - finalUpdated);

  await writeJsonFile(options.namingMemoryPath, fallbackPromotion.namingMemory);
  await writeJsonFile(options.legacyNamingMemoryPath, fallbackPromotion.namingMemory);

  return {
    mergedEvidencePath: options.mergedEvidencePath,
    namingMemoryPath: options.namingMemoryPath,
    promotionBudget: options.promotionBudget,
    candidateCount: promotionCandidates.length,
    selectedCount: selectedCandidates.length,
    insertedEntryCount: finalInserted,
    updatedEntryCount: finalUpdated,
    keptEntryCount: finalKept,
    averageSelectedQuality: averageSelectedQuality(selectedCandidates),
  };
}
