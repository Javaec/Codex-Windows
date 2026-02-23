export interface MatchV2RegressionHintRule {
  sourcePattern: RegExp;
  preferredReferencePatterns: RegExp[];
  avoidReferencePatterns?: RegExp[];
}

export interface MatchV2ScoreWeights {
  file: {
    tokenHitWeight: number;
    layerRendererBoost: number;
    layerMainBoost: number;
    layerPreloadBoost: number;
    layerMainToTauriBoost: number;
    layerRendererToServicesBoost: number;
    qualityBoostCap: number;
    qualityDivisor: number;
    sourceOneCodeBoost: number;
    sourceCodexMonitorBoost: number;
    originSymbolMapBoost: number;
    originPathMapBoost: number;
    genericPathPenalty: number;
    broadFilePenaltyStart: number;
    broadFilePenaltyStep: number;
    broadFilePenaltyCap: number;
    heavyTokenPenaltyStart: number;
    heavyTokenPenaltyStep: number;
    heavyTokenPenaltyCap: number;
    rustPenalty: number;
    pathMapLayerAlignBoost: number;
    pathMapUnknownPenalty: number;
  };
  symbol: {
    tokenHitWeight: number;
    layerRendererBoost: number;
    layerMainBoost: number;
    layerPreloadBoost: number;
    symbolKindBoost: number;
    qualityBoostCap: number;
    qualityDivisor: number;
    genericPathPenalty: number;
    broadFilePenalty: number;
    genericNamePenalty: number;
    rustPenalty: number;
    candidateTokenBoostCap: number;
    candidateTokenBoostStep: number;
    pathMapLayerAlignBoost: number;
  };
  signal: {
    astCap: number;
    astWeight: number;
    ipcRpcCap: number;
    ipcRpcWeight: number;
    stateCap: number;
    stateWeight: number;
    boundaryCap: number;
    boundaryWeight: number;
    flowCap: number;
    flowWeight: number;
  };
}

export interface MatchV2Thresholds {
  minMappedFiles: number;
  maxMappedFiles: number;
  genericSelectionMinScore: number;
  nonGenericSelectionMinScoreStrongAnchor: number;
  nonGenericSelectionMinScoreStrongSignal: number;
  nonGenericSelectionMinScoreDefault: number;
}

export interface MatchV2RuntimeVariant {
  id: string;
  description: string;
  scoreWeightsPatch?: {
    file?: Partial<MatchV2ScoreWeights["file"]>;
    symbol?: Partial<MatchV2ScoreWeights["symbol"]>;
    signal?: Partial<MatchV2ScoreWeights["signal"]>;
  };
  thresholdsPatch?: Partial<MatchV2Thresholds>;
}

export interface MatchV2ResolvedRuntimeConfig {
  profileId: string;
  variantId: string;
  variantDescription: string;
  scoreWeights: MatchV2ScoreWeights;
  thresholds: MatchV2Thresholds;
}

export const MATCH_V2_CALIBRATION_PROFILE = {
  id: "regression-core-v2",
  description: "Fixed-weight profile calibrated on locked regression runs from Codex app bundle snapshots.",
  fixedRegressionRuns: ["core-no-binary", "core-no-binary-no-pretty", "core-no-binary-top120", "core-runtime-probe-soft"],
};

export const MATCH_V2_SCORE_WEIGHTS: MatchV2ScoreWeights = {
  file: {
    tokenHitWeight: 1.95,
    layerRendererBoost: 1.9,
    layerMainBoost: 1.9,
    layerPreloadBoost: 1.5,
    layerMainToTauriBoost: 0.9,
    layerRendererToServicesBoost: 0.8,
    qualityBoostCap: 2.6,
    qualityDivisor: 820,
    sourceOneCodeBoost: 0.35,
    sourceCodexMonitorBoost: 0.25,
    originSymbolMapBoost: 0.55,
    originPathMapBoost: 0.35,
    genericPathPenalty: 2.8,
    broadFilePenaltyStart: 6,
    broadFilePenaltyStep: 0.34,
    broadFilePenaltyCap: 3.4,
    heavyTokenPenaltyStart: 85,
    heavyTokenPenaltyStep: 0.025,
    heavyTokenPenaltyCap: 1.5,
    rustPenalty: 0.45,
    pathMapLayerAlignBoost: 0.55,
    pathMapUnknownPenalty: 0.15,
  },
  symbol: {
    tokenHitWeight: 1.85,
    layerRendererBoost: 1.5,
    layerMainBoost: 1.5,
    layerPreloadBoost: 1.2,
    symbolKindBoost: 1.7,
    qualityBoostCap: 2.6,
    qualityDivisor: 700,
    genericPathPenalty: 2.1,
    broadFilePenalty: 0.55,
    genericNamePenalty: 2.3,
    rustPenalty: 0.35,
    candidateTokenBoostCap: 1.2,
    candidateTokenBoostStep: 0.25,
    pathMapLayerAlignBoost: 0.35,
  },
  signal: {
    astCap: 3.2,
    astWeight: 0.08,
    ipcRpcCap: 4.4,
    ipcRpcWeight: 0.14,
    stateCap: 2.8,
    stateWeight: 0.1,
    boundaryCap: 2.8,
    boundaryWeight: 0.12,
    flowCap: 2.2,
    flowWeight: 0.09,
  },
};

export const MATCH_V2_THRESHOLDS: MatchV2Thresholds = {
  minMappedFiles: 5,
  maxMappedFiles: 6,
  genericSelectionMinScore: 7.2,
  nonGenericSelectionMinScoreStrongAnchor: 3.0,
  nonGenericSelectionMinScoreStrongSignal: 3.4,
  nonGenericSelectionMinScoreDefault: 3.8,
};

export const MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID = "baseline";

export const MATCH_V2_RUNTIME_VARIANTS: MatchV2RuntimeVariant[] = [
  {
    id: "baseline",
    description: "Pinned baseline profile from regression-core-v2.",
  },
  {
    id: "ownership_boost",
    description: "Boost boundary ownership, route/event flow, and symbol ownership scoring.",
    scoreWeightsPatch: {
      signal: {
        boundaryWeight: 0.16,
        flowWeight: 0.11,
      },
      symbol: {
        candidateTokenBoostCap: 1.35,
        pathMapLayerAlignBoost: 0.45,
      },
    },
    thresholdsPatch: {
      nonGenericSelectionMinScoreStrongSignal: 3.3,
      nonGenericSelectionMinScoreDefault: 3.7,
    },
  },
  {
    id: "file_recall_boost",
    description: "Increase non-generic file recall while preserving generic-path gates.",
    scoreWeightsPatch: {
      file: {
        tokenHitWeight: 2.05,
        pathMapLayerAlignBoost: 0.65,
      },
      signal: {
        astWeight: 0.09,
        ipcRpcWeight: 0.15,
      },
    },
    thresholdsPatch: {
      nonGenericSelectionMinScoreStrongAnchor: 2.9,
      nonGenericSelectionMinScoreStrongSignal: 3.25,
      nonGenericSelectionMinScoreDefault: 3.65,
    },
  },
];

export const MATCH_V2_CALIBRATION_TARGETS = {
  mappedFilesMin: 5,
  mappedFilesMax: 6,
  mappedSymbolsMin: 12,
  mappedSymbolsMax: 16,
};

export const MATCH_V2_REGRESSION_HINTS: MatchV2RegressionHintRule[] = [
  {
    sourcePattern: /^\.vite\/build\/main-/i,
    preferredReferencePatterns: [/(^|\/)src\/main\//i, /src-tauri\/src\//i, /(backend|ipc|window)/i],
  },
  {
    sourcePattern: /^\.vite\/build\/worker/i,
    preferredReferencePatterns: [/src-tauri\/src\//i, /(backend|state|types|daemon|workspace)/i],
    avoidReferencePatterns: [/(^|\/)src\/renderer\//i],
  },
  {
    sourcePattern: /^webview\/assets\/index-/i,
    preferredReferencePatterns: [/(^|\/)src\/renderer\//i, /(features|layout|app|chat)/i],
  },
  {
    sourcePattern: /^webview\/assets\/worker-/i,
    preferredReferencePatterns: [/(^|\/)src\/renderer\//i, /(chat|thread|event|stream|view)/i],
  },
  {
    sourcePattern: /^webview\/assets\/automation-/i,
    preferredReferencePatterns: [/(automation|queue|event|job|task)/i],
  },
  {
    sourcePattern: /^webview\/assets\/diff-/i,
    preferredReferencePatterns: [/(diff|patch|git)/i],
  },
];

export interface ReverseQualityGateTargets {
  mappedFilesMin: number;
  mappedFilesMax: number;
  mappedSymbolsMin: number;
  lowConfidenceSymbolsMax: number;
  noisySymbolNamesMax: number;
  placeholderModulesMax: number;
  genericPathNoiseSegments: string[];
  allowedTargetPrefixes: string[];
  mappedSymbolsHistoryFile: string;
}

export const REVERSE_QUALITY_GATE_TARGETS: ReverseQualityGateTargets = {
  mappedFilesMin: 4,
  mappedFilesMax: 6,
  mappedSymbolsMin: 12,
  lowConfidenceSymbolsMax: 120,
  noisySymbolNamesMax: 40,
  placeholderModulesMax: 0,
  genericPathNoiseSegments: ["types", "utils", "index", "common", "shared"],
  allowedTargetPrefixes: ["src/main/", "src/renderer/", "src/services/", "src-tauri-adapter/"],
  mappedSymbolsHistoryFile: "work/reverse-quality-history.json",
};

export interface FixedRegressionRun {
  id: string;
  label: string;
  args: string[];
}

export const FIXED_REGRESSION_RUNS: FixedRegressionRun[] = [
  {
    id: "core-no-binary",
    label: "Core run without bundled binary extraction",
    args: ["-NoBinary"],
  },
  {
    id: "core-no-binary-no-pretty",
    label: "Core run without binary + without pretty decompile",
    args: ["-NoBinary", "-NoPretty"],
  },
  {
    id: "core-no-binary-top120",
    label: "Core run without binary and narrower reporting window",
    args: ["-NoBinary", "-Top", "120"],
  },
  {
    id: "core-runtime-probe-soft",
    label: "Core run with runtime probe enabled (soft runtime RPC noise mode)",
    args: ["-NoBinary", "-RuntimeProbe", "-RuntimeProbeMs", "12000", "-RuntimeRpcNoiseMode", "soft"],
  },
];

export const REVERSE_REGRESSION_BASELINES_FILE = "scripts/reverse/regression-baselines.json";

function resolveRuntimeVariant(rawVariantId: string | undefined): MatchV2RuntimeVariant {
  const baselineFallback = MATCH_V2_RUNTIME_VARIANTS.find((variant) => variant.id === MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID);
  const firstVariant = MATCH_V2_RUNTIME_VARIANTS[0];
  const defaultVariant = baselineFallback ?? firstVariant;
  if (!defaultVariant) {
    throw new Error("MATCH_V2_RUNTIME_VARIANTS must define at least one variant.");
  }
  const normalized = (rawVariantId ?? "").trim();
  if (normalized.length === 0) {
    return defaultVariant;
  }
  return MATCH_V2_RUNTIME_VARIANTS.find((variant) => variant.id === normalized) ?? defaultVariant;
}

function applyScoreWeightsPatch(
  base: MatchV2ScoreWeights,
  patch: MatchV2RuntimeVariant["scoreWeightsPatch"] | undefined,
): MatchV2ScoreWeights {
  if (!patch) return base;
  return {
    file: {
      ...base.file,
      ...(patch.file ?? {}),
    },
    symbol: {
      ...base.symbol,
      ...(patch.symbol ?? {}),
    },
    signal: {
      ...base.signal,
      ...(patch.signal ?? {}),
    },
  };
}

function applyThresholdPatch(base: MatchV2Thresholds, patch: Partial<MatchV2Thresholds> | undefined): MatchV2Thresholds {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
  };
}

export function resolveMatchV2RuntimeConfig(rawVariantId: string | undefined): MatchV2ResolvedRuntimeConfig {
  const variant = resolveRuntimeVariant(rawVariantId);
  const scoreWeights = applyScoreWeightsPatch(MATCH_V2_SCORE_WEIGHTS, variant.scoreWeightsPatch);
  const thresholds = applyThresholdPatch(MATCH_V2_THRESHOLDS, variant.thresholdsPatch);
  const profileId =
    variant.id === MATCH_V2_DEFAULT_RUNTIME_VARIANT_ID
      ? MATCH_V2_CALIBRATION_PROFILE.id
      : `${MATCH_V2_CALIBRATION_PROFILE.id}+${variant.id}`;
  return {
    profileId,
    variantId: variant.id,
    variantDescription: variant.description,
    scoreWeights,
    thresholds,
  };
}
