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
  minMappedFiles: 4,
  maxMappedFiles: 6,
  genericSelectionMinScore: 7.2,
  nonGenericSelectionMinScoreStrongAnchor: 3.0,
  nonGenericSelectionMinScoreStrongSignal: 3.4,
  nonGenericSelectionMinScoreDefault: 3.8,
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
  genericPathNoiseSegments: string[];
  allowedTargetPrefixes: string[];
  mappedSymbolsHistoryFile: string;
}

export const REVERSE_QUALITY_GATE_TARGETS: ReverseQualityGateTargets = {
  mappedFilesMin: 4,
  mappedFilesMax: 6,
  mappedSymbolsMin: 10,
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
