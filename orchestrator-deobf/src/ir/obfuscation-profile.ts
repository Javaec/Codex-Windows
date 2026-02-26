import { ToolWeights } from "../contracts";
import { EvidenceRecord, EvidenceStoreModel } from "./evidence-store";

export type ObfuscationProfileId = "profile-v1" | "profile-v2";

export interface ObfuscationProfileDescriptor {
  profileId: ObfuscationProfileId;
  confidence: number;
  adapterVersion: number;
  signals: string[];
}

export interface ObfuscationProfileResolution {
  profile: ObfuscationProfileDescriptor;
  normalizedEvidenceStore: EvidenceStoreModel;
}

interface ObfuscationProfileMetrics {
  symbolHintCount: number;
  shortAliasRatio: number;
  hashedChunkHintRatio: number;
  sourceMapRatio: number;
  stateSignalDensity: number;
  symbolToolCoverage: number;
}

interface ObfuscationProfileAdapter {
  profileId: ObfuscationProfileId;
  detectScore: (metrics: ObfuscationProfileMetrics) => number;
  collectSignals: (metrics: ObfuscationProfileMetrics, score: number) => string[];
  normalizeRecords: (records: EvidenceRecord[]) => EvidenceRecord[];
  tuneWeights: (weights: ToolWeights) => ToolWeights;
}

const ADAPTER_VERSION = 1;
const TOTAL_TOOL_COUNT = 6;
const HASHED_CHUNK_PATTERN = /(?:chunk|index|treemap|vendor)-[a-z0-9]{6,}\.(?:js|ts|tsx|jsx|mjs|cjs)$/i;
const SHORT_ALIAS_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,2}$/;

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function scaleWeight(value: number, factor: number): number {
  const scaled = value * factor;
  if (scaled < 0.01) {
    return 0.01;
  }
  return Number(scaled.toFixed(4));
}

function dedupeAndSortRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const record of records) {
    byId.set(record.id, record);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildEvidenceStats(records: EvidenceRecord[]): EvidenceStoreModel["stats"] {
  let fileHintCount = 0;
  let symbolHintCount = 0;
  let callEdgeCount = 0;
  let stateKeyCount = 0;
  let sourceMapCount = 0;
  let ioSignatureCount = 0;
  for (const record of records) {
    if (record.kind === "file_hint") {
      fileHintCount += 1;
      continue;
    }
    if (record.kind === "symbol_hint") {
      symbolHintCount += 1;
      continue;
    }
    if (record.kind === "call_edge") {
      callEdgeCount += 1;
      continue;
    }
    if (record.kind === "state_key") {
      stateKeyCount += 1;
      continue;
    }
    if (record.kind === "source_map") {
      sourceMapCount += 1;
      continue;
    }
    if (record.kind === "io_signature") {
      ioSignatureCount += 1;
    }
  }
  return {
    totalRecords: records.length,
    fileHintCount,
    symbolHintCount,
    callEdgeCount,
    stateKeyCount,
    sourceMapCount,
    ioSignatureCount,
  };
}

function countHashedHints(records: EvidenceRecord[]): number {
  let hashed = 0;
  for (const record of records) {
    if (record.kind !== "file_hint" && record.kind !== "source_map") {
      continue;
    }
    const normalized = record.value.replace(/\\/g, "/").toLowerCase();
    if (HASHED_CHUNK_PATTERN.test(normalized)) {
      hashed += 1;
    }
  }
  return hashed;
}

function buildProfileMetrics(evidenceStore: EvidenceStoreModel): ObfuscationProfileMetrics {
  const symbolHints = evidenceStore.records.filter((record) => record.kind === "symbol_hint");
  const nonCoverageSymbols = symbolHints.filter((record) => !record.owner.endsWith("-census"));
  const symbolSet = nonCoverageSymbols.length > 0 ? nonCoverageSymbols : symbolHints;
  const stateKeyCount = evidenceStore.records.filter((record) => record.kind === "state_key").length;
  const sourceMapCount = evidenceStore.records.filter((record) => record.kind === "source_map").length;
  const fileHintCount = evidenceStore.records.filter((record) => record.kind === "file_hint").length;
  const hashedHints = countHashedHints(evidenceStore.records);

  let shortAliasCount = 0;
  const symbolTools = new Set<string>();
  for (const record of symbolSet) {
    symbolTools.add(record.provenance.tool);
    if (SHORT_ALIAS_PATTERN.test(record.value.trim())) {
      shortAliasCount += 1;
    }
  }

  const symbolHintCount = symbolSet.length;
  const hintDenominator = Math.max(1, sourceMapCount + fileHintCount);

  return {
    symbolHintCount,
    shortAliasRatio: clamp(shortAliasCount / Math.max(1, symbolHintCount)),
    hashedChunkHintRatio: clamp(hashedHints / hintDenominator),
    sourceMapRatio: clamp(sourceMapCount / hintDenominator),
    stateSignalDensity: clamp(stateKeyCount / Math.max(1, symbolHintCount)),
    symbolToolCoverage: clamp(symbolTools.size / TOTAL_TOOL_COUNT),
  };
}

function formatMetricsSignals(metrics: ObfuscationProfileMetrics, score: number): string[] {
  return [
    `score=${score.toFixed(4)}`,
    `symbolHintCount=${metrics.symbolHintCount}`,
    `shortAliasRatio=${metrics.shortAliasRatio.toFixed(4)}`,
    `hashedChunkHintRatio=${metrics.hashedChunkHintRatio.toFixed(4)}`,
    `stateSignalDensity=${metrics.stateSignalDensity.toFixed(4)}`,
    `sourceMapRatio=${metrics.sourceMapRatio.toFixed(4)}`,
    `symbolToolCoverage=${metrics.symbolToolCoverage.toFixed(4)}`,
  ];
}

function tuneWeightsV2(weights: ToolWeights): ToolWeights {
  return {
    asar: scaleWeight(weights.asar, 1.12),
    webcrack: scaleWeight(weights.webcrack, 1.08),
    wakaru: scaleWeight(weights.wakaru, 1.06),
    javascriptDeobfuscator: scaleWeight(weights.javascriptDeobfuscator, 0.94),
    synchrony: scaleWeight(weights.synchrony, 0.94),
    unwebpackSourcemap: scaleWeight(weights.unwebpackSourcemap, 1.14),
  };
}

const PROFILE_ADAPTERS: ObfuscationProfileAdapter[] = [
  {
    profileId: "profile-v1",
    detectScore: (metrics) => {
      const readability = 1 - metrics.shortAliasRatio;
      const stablePaths = 1 - metrics.hashedChunkHintRatio;
      const stateRichness = clamp(metrics.stateSignalDensity / 0.9);
      const score =
        readability * 0.42 + stablePaths * 0.23 + stateRichness * 0.2 + metrics.sourceMapRatio * 0.15;
      return clamp(score);
    },
    collectSignals: (metrics, score) => [
      "adapter=profile-v1",
      ...formatMetricsSignals(metrics, score),
      "bias=readable-identifiers",
    ],
    normalizeRecords: (records) => dedupeAndSortRecords(records),
    tuneWeights: (weights) => ({ ...weights }),
  },
  {
    profileId: "profile-v2",
    detectScore: (metrics) => {
      const sparseState = 1 - clamp(metrics.stateSignalDensity / 0.9);
      const sparseSourcemap = 1 - metrics.sourceMapRatio;
      const score =
        metrics.shortAliasRatio * 0.44 +
        metrics.hashedChunkHintRatio * 0.28 +
        sparseState * 0.16 +
        sparseSourcemap * 0.12;
      return clamp(score);
    },
    collectSignals: (metrics, score) => [
      "adapter=profile-v2",
      ...formatMetricsSignals(metrics, score),
      "bias=alias-heavy-obfuscation",
    ],
    normalizeRecords: (records) => dedupeAndSortRecords(records),
    tuneWeights: (weights) => tuneWeightsV2(weights),
  },
];

function getAdapter(profileId: ObfuscationProfileId): ObfuscationProfileAdapter {
  const adapter = PROFILE_ADAPTERS.find((entry) => entry.profileId === profileId);
  if (!adapter) {
    throw new Error(`obfuscation-profile: missing adapter for ${profileId}`);
  }
  return adapter;
}

export function applyObfuscationProfileWeights(
  weights: ToolWeights,
  profile: ObfuscationProfileDescriptor,
): ToolWeights {
  const adapter = getAdapter(profile.profileId);
  return adapter.tuneWeights(weights);
}

export function resolveObfuscationProfile(evidenceStore: EvidenceStoreModel): ObfuscationProfileResolution {
  const metrics = buildProfileMetrics(evidenceStore);
  const ranked = PROFILE_ADAPTERS.map((adapter) => ({
    adapter,
    score: adapter.detectScore(metrics),
  })).sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.adapter.profileId.localeCompare(right.adapter.profileId);
  });

  const winner = ranked[0];
  if (!winner) {
    throw new Error("obfuscation-profile: no adapters registered");
  }
  const runnerUp = ranked[1];
  const confidenceBase = winner.score;
  const scoreSpread = runnerUp ? winner.score - runnerUp.score : winner.score;
  const confidence = clamp(Math.max(0.35, confidenceBase * 0.75 + Math.min(0.25, Math.max(0, scoreSpread))));
  const signals = winner.adapter.collectSignals(metrics, winner.score);
  const normalizedRecords = winner.adapter.normalizeRecords(evidenceStore.records);
  const normalizedEvidenceStore: EvidenceStoreModel = {
    version: evidenceStore.version,
    generatedAtIso: evidenceStore.generatedAtIso,
    records: normalizedRecords,
    stats: buildEvidenceStats(normalizedRecords),
  };

  return {
    profile: {
      profileId: winner.adapter.profileId,
      confidence,
      adapterVersion: ADAPTER_VERSION,
      signals,
    },
    normalizedEvidenceStore,
  };
}
