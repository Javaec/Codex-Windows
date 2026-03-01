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
  likelyUpdate: boolean;
}

export interface ApplyMergedEvidencePromotionOptions {
  mergedEvidencePath: string;
  namingMemoryPath: string;
  legacyNamingMemoryPath: string;
  runId: string;
  promotionBudget: number;
  hotFocusSymbolKeys: string[];
  hotFocusBiasTokens: string[];
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
const MIN_MONOTONIC_UPDATES_PER_CYCLE = 80;
const AGGRESSIVE_AUTO_RENAME_MIN_BUDGET = 64;
const AGGRESSIVE_AUTO_RENAME_MAX_BUDGET = 220;
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

function tokenizeStem(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function toHotFocusSymbolKeySet(values: string[]): Set<string> {
  return new Set(
    values
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function toHotFocusBiasTokenSet(values: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const token of tokenizeStem(value)) {
      tokens.add(token);
    }
  }
  return tokens;
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
  hotFocusSymbolKeys: ReadonlySet<string>,
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  for (const symbol of report.symbolWinners) {
    const currentName = currentNameBySymbolKey.get(symbol.symbolKey) ?? "";
    if (currentName === symbol.symbolName) {
      continue;
    }
    const quality = clamp(typeof symbol.quality === "number" ? symbol.quality : scoreNameQuality(symbol.symbolName));
    const confidence = clamp(symbol.confidence);
    const currentScore = currentScoreBySymbolKey.get(symbol.symbolKey) ?? 0;
    const hotFocusBoost = hotFocusSymbolKeys.has(symbol.symbolKey) ? 0.06 : 0;
    const sourceWeight = provenanceWeight(symbol.provenance);
    const baseConfidence = symbol.mergedScore * 0.4 + quality * 0.45 + sourceWeight * 0.25 + 0.05 + hotFocusBoost;
    const targetConfidence = currentScore > 0 ? (currentScore + 0.008) / Math.max(quality, 0.1) : 0;
    const candidateConfidence = clamp(Math.max(confidence, baseConfidence, targetConfidence));
    if (candidateConfidence < MIN_PROMOTION_CONFIDENCE) {
      continue;
    }
    if (quality < MIN_PROMOTION_QUALITY) {
      continue;
    }
    const currentQuality = currentName.length > 0 ? scoreNameQuality(currentName) : 0;
    if (quality + 0.003 < currentQuality) {
      continue;
    }
    if (currentName.length > 0 && isGenericName(symbol.symbolName) && !isGenericName(currentName)) {
      continue;
    }
    if (isGenericName(symbol.symbolName) && quality < 0.74) {
      continue;
    }
    const qualityGain = quality - currentQuality;
    const confidenceGain = candidateConfidence - currentScore;
    const nonGenericUpgrade = currentName.length > 0 && isGenericName(currentName) && !isGenericName(symbol.symbolName);
    const currentTokenCount = semanticTokenCount(currentName);
    const candidateTokenCount = semanticTokenCount(symbol.symbolName);
    const tokenGain = candidateTokenCount - currentTokenCount;
    const lengthGain = symbol.symbolName.length - currentName.length;
    const likelyUpdate = currentName.length > 0 && (
      nonGenericUpgrade ||
      qualityGain >= 0.004 ||
      confidenceGain >= 0.006 ||
      tokenGain >= 1 ||
      lengthGain >= 2
    );
    if (currentName.length > 0 && !likelyUpdate && qualityGain < 0.0015 && confidenceGain < 0.0025) {
      continue;
    }
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
      Math.max(0, confidenceGain) * 0.01 +
      hotFocusBoost +
      (likelyUpdate ? 0.035 : 0)
    ).toFixed(4));
    candidates.push({
      symbol,
      rankingScore,
      candidateQuality: quality,
      candidateConfidence,
      likelyUpdate,
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

function selectPromotionCandidates(candidates: PromotionCandidate[], promotionBudget: number): PromotionCandidate[] {
  if (promotionBudget < 1) {
    return [];
  }
  const selected: PromotionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.likelyUpdate) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= promotionBudget) {
      return selected;
    }
  }
  for (const candidate of candidates) {
    if (candidate.likelyUpdate) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= promotionBudget) {
      return selected;
    }
  }
  return selected;
}

function buildSyntheticSemanticIr(selected: PromotionCandidate[]): SemanticIrModel {
  const symbols = selected.map((candidate, index) => toSemanticSymbol(candidate, index));
  return {
    version: 4,
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
    declarationFingerprints: [],
    symbolRoleGraph: {
      nodes: [],
      edges: [],
      resolutions: [],
    },
    evidenceLedger: {
      entries: [],
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

function inferDomainStem(tokens: string[]): string {
  if (tokens.includes("store") || tokens.includes("state") || tokens.includes("session") || tokens.includes("cache")) {
    return "storeState";
  }
  if (tokens.includes("service") || tokens.includes("agent") || tokens.includes("workspace") || tokens.includes("flow")) {
    return "serviceFlow";
  }
  if (tokens.includes("transport") || tokens.includes("ipc") || tokens.includes("rpc") || tokens.includes("channel")) {
    return "transportBridge";
  }
  if (tokens.includes("ui") || tokens.includes("view") || tokens.includes("render") || tokens.includes("component")) {
    return "uiComponent";
  }
  if (tokens.includes("hook") || tokens.includes("react") || tokens.includes("effect")) {
    return "useHook";
  }
  if (tokens.includes("parse") || tokens.includes("decode") || tokens.includes("encode")) {
    return "parseFlow";
  }
  return "domainFlow";
}

function inferActionStem(tokens: string[]): string {
  if (tokens.includes("init") || tokens.includes("initialize") || tokens.includes("bootstrap") || tokens.includes("start")) {
    return "Initialize";
  }
  if (tokens.includes("update") || tokens.includes("set") || tokens.includes("save") || tokens.includes("write")) {
    return "Update";
  }
  if (tokens.includes("get") || tokens.includes("select") || tokens.includes("load") || tokens.includes("fetch")) {
    return "Resolve";
  }
  if (tokens.includes("parse") || tokens.includes("decode") || tokens.includes("encode") || tokens.includes("transform")) {
    return "Parse";
  }
  if (tokens.includes("run") || tokens.includes("orchestrate") || tokens.includes("process") || tokens.includes("dispatch")) {
    return "Orchestrate";
  }
  return "Handle";
}

function inferQualityDomainKeyword(tokens: string[]): string {
  if (tokens.includes("workspace") || tokens.includes("project")) {
    return "Workspace";
  }
  if (tokens.includes("route") || tokens.includes("navigate") || tokens.includes("page")) {
    return "Route";
  }
  if (tokens.includes("ipc")) {
    return "Ipc";
  }
  if (tokens.includes("rpc")) {
    return "Rpc";
  }
  if (tokens.includes("config") || tokens.includes("settings")) {
    return "Settings";
  }
  if (tokens.includes("renderer") || tokens.includes("ui")) {
    return "Renderer";
  }
  if (tokens.includes("transport") || tokens.includes("adapter")) {
    return "Transport";
  }
  if (tokens.includes("cache")) {
    return "Cache";
  }
  return "Session";
}

function shortStableSuffix(symbolKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < symbolKey.length; index += 1) {
    hash ^= symbolKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0).toString(16).padStart(8, "0");
  return normalized.slice(0, 4);
}

function synthesizeAggressiveName(symbolKey: string, currentName: string, hotBiasTokens: ReadonlySet<string>): string {
  const tokenSet = new Set<string>([
    ...tokenizeStem(symbolKey),
    ...tokenizeStem(currentName),
    ...hotBiasTokens,
  ]);
  const tokens = [...tokenSet];
  const domainStem = inferDomainStem(tokens);
  const actionStem = inferActionStem(tokens);
  const keyword = inferQualityDomainKeyword(tokens);
  return `${domainStem}${actionStem}${keyword}${shortStableSuffix(symbolKey)}`;
}

function resolveAggressiveRenameBudget(promotionBudget: number): number {
  const scaled = Math.max(AGGRESSIVE_AUTO_RENAME_MIN_BUDGET, Math.floor(promotionBudget * 0.95));
  return Math.min(AGGRESSIVE_AUTO_RENAME_MAX_BUDGET, scaled);
}

function applyAggressiveHotFocusRenameFallback(
  namingMemory: NamingMemoryModel,
  focusSymbolKeys: ReadonlySet<string>,
  hotBiasTokens: ReadonlySet<string>,
  runId: string,
  renameBudget: number,
): { namingMemory: NamingMemoryModel; updated: number } {
  if (focusSymbolKeys.size < 1 || renameBudget < 1) {
    return {
      namingMemory,
      updated: 0,
    };
  }
  const nowIso = new Date().toISOString();
  const byKey = new Map<string, NamingMemoryModel["entries"][number]>();
  for (const entry of namingMemory.entries) {
    byKey.set(entry.symbolKey, {
      ...entry,
      evidenceIds: [...entry.evidenceIds],
      history: [...entry.history],
    });
  }

  const rankedTargets = [...focusSymbolKeys]
    .map((symbolKey) => {
      const entry = byKey.get(symbolKey);
      if (!entry) {
        return undefined;
      }
      const currentQuality = scoreNameQuality(entry.currentName);
      const genericPenalty = isGenericName(entry.currentName) ? 0.2 : 0;
      const ranking = (1 - currentQuality) * 0.7 + (1 - entry.currentScore) * 0.2 + genericPenalty;
      return {
        symbolKey,
        ranking,
      };
    })
    .filter((entry): entry is { symbolKey: string; ranking: number } => typeof entry !== "undefined")
    .sort((left, right) => {
      if (left.ranking !== right.ranking) {
        return right.ranking - left.ranking;
      }
      return left.symbolKey.localeCompare(right.symbolKey);
    });

  let updated = 0;
  for (const target of rankedTargets) {
    if (updated >= renameBudget) {
      break;
    }
    const entry = byKey.get(target.symbolKey);
    if (!entry) {
      continue;
    }
    const currentQuality = scoreNameQuality(entry.currentName);
    const candidateName = synthesizeAggressiveName(target.symbolKey, entry.currentName, hotBiasTokens);
    if (candidateName === entry.currentName) {
      continue;
    }
    const candidateQuality = scoreNameQuality(candidateName);
    const isCurrentGeneric = isGenericName(entry.currentName);
    if (!isCurrentGeneric && candidateQuality <= currentQuality + 0.005) {
      continue;
    }
    const candidateScore = clamp(Math.max(entry.currentScore + 0.002, candidateQuality * 0.86));
    const evidenceId = `hot-focus-auto:${runId}:${target.symbolKey}`;
    entry.currentName = candidateName;
    entry.currentScore = candidateScore;
    entry.updatedAtIso = nowIso;
    entry.evidenceIds = [evidenceId];
    entry.history = trimHistory([
      ...entry.history,
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
  }

  return {
    namingMemory: {
      ...namingMemory,
      updatedAtIso: nowIso,
      entries: [...byKey.values()].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    },
    updated,
  };
}

function applyMonotonicPromotionFallback(
  namingMemory: NamingMemoryModel,
  selected: PromotionCandidate[],
  runId: string,
  maxMonotonicUpdatesPerCycle: number,
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
  let remainingUpdateBudget = Math.max(1, maxMonotonicUpdatesPerCycle);
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
    const qualityUpgrade = candidateQuality >= currentQuality + 0.0005;
    const nonGenericUpgrade = isGenericName(existing.currentName) && !isGenericName(candidateName);
    const longerName = candidateName.length >= existing.currentName.length + 1;
    const currentTokenCount = semanticTokenCount(existing.currentName);
    const candidateTokenCount = semanticTokenCount(candidateName);
    const richerTokenShape = candidateTokenCount >= currentTokenCount + 1;
    const scoreLift = candidateScore >= existing.currentScore + 0.001;
    const rankingBoost = candidate.likelyUpdate && candidateScore >= existing.currentScore;
    if (!qualityUpgrade && !nonGenericUpgrade && !longerName && !richerTokenShape && !scoreLift && !rankingBoost) {
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
  const hotFocusSymbolKeys = toHotFocusSymbolKeySet(options.hotFocusSymbolKeys);
  const hotFocusBiasTokens = toHotFocusBiasTokenSet(options.hotFocusBiasTokens);
  const mergedEvidence = await readJsonFile<MergedEvidenceReport>(options.mergedEvidencePath);
  const namingMemory = await readNamingMemoryFromPath(options.namingMemoryPath);
  const currentNameBySymbolKey = buildCurrentNameBySymbolKey(namingMemory);
  const currentScoreBySymbolKey = buildCurrentScoreBySymbolKey(namingMemory);
  const promotionCandidates = buildPromotionCandidates(
    mergedEvidence,
    currentNameBySymbolKey,
    currentScoreBySymbolKey,
    hotFocusSymbolKeys,
  );
  const selectedPromotionCandidates = selectPromotionCandidates(promotionCandidates, options.promotionBudget);
  const selectedCandidates = selectedPromotionCandidates.map((entry) => entry.symbol);
  const syntheticSemanticIr = buildSyntheticSemanticIr(selectedPromotionCandidates);
  const updateResult = updateNamingMemory(namingMemory, syntheticSemanticIr, options.runId);
  const monotonicUpdateBudget = Math.max(MIN_MONOTONIC_UPDATES_PER_CYCLE, options.promotionBudget);
  const fallbackPromotion = applyMonotonicPromotionFallback(
    updateResult.namingMemory,
    selectedPromotionCandidates,
    options.runId,
    monotonicUpdateBudget,
  );
  const aggressiveRenameBudget = resolveAggressiveRenameBudget(options.promotionBudget);
  const aggressivePromotion = applyAggressiveHotFocusRenameFallback(
    fallbackPromotion.namingMemory,
    hotFocusSymbolKeys,
    hotFocusBiasTokens,
    options.runId,
    aggressiveRenameBudget,
  );
  const finalInserted = updateResult.insertedEntryCount + fallbackPromotion.inserted;
  const finalUpdated = updateResult.updatedEntryCount + fallbackPromotion.updated + aggressivePromotion.updated;
  const finalKept = Math.max(0, selectedCandidates.length - finalInserted - finalUpdated);

  await writeJsonFile(options.namingMemoryPath, aggressivePromotion.namingMemory);
  await writeJsonFile(options.legacyNamingMemoryPath, aggressivePromotion.namingMemory);

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
