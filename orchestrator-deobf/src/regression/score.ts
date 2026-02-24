import { RunMetrics } from "../contracts";

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function minTargetScore(value: number, minValue: number): number {
  if (value >= minValue) {
    return 1;
  }
  return clamp01(value / minValue);
}

export interface MetricScore {
  total: number;
  mappedFilesScore: number;
  mappedSymbolsScore: number;
  nameQualityScore: number;
  buildScore: number;
  devScore: number;
}

export function scoreRunMetrics(metrics: RunMetrics): MetricScore {
  const mappedFilesScore = minTargetScore(metrics.mappedFiles, 5);
  const mappedSymbolsScore = clamp01(metrics.mappedSymbols / 16);
  const nameQualityScore = clamp01(metrics.nameQuality);
  const buildScore = metrics.buildHealth ? 1 : 0;
  const devScore = metrics.devHealth ? 1 : 0;

  const coreScore =
    mappedFilesScore * 0.35 +
    mappedSymbolsScore * 0.25 +
    nameQualityScore * 0.2 +
    buildScore * 0.1 +
    devScore * 0.1;

  const genericNoisePenalty = metrics.genericPathNoiseCount > 0 ? 1 : 0;
  const lowQualityPenalty = clamp01(metrics.lowQualitySymbolCount / 32) * 0.2;
  const total = clamp01(coreScore - genericNoisePenalty - lowQualityPenalty);

  return {
    total: Number(total.toFixed(4)),
    mappedFilesScore: Number(mappedFilesScore.toFixed(4)),
    mappedSymbolsScore: Number(mappedSymbolsScore.toFixed(4)),
    nameQualityScore: Number(nameQualityScore.toFixed(4)),
    buildScore: Number(buildScore.toFixed(4)),
    devScore: Number(devScore.toFixed(4)),
  };
}
