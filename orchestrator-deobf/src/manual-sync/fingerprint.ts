import { SemanticDeclarationFingerprint } from "../ir/semantic-ir";
import { ManualSyncSymbolFingerprint } from "./contracts";

const FINGERPRINT_VERSION = 1;

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function tokenizeSignal(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function bucketDegree(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value <= 2) {
    return 1;
  }
  if (value <= 5) {
    return 2;
  }
  if (value <= 9) {
    return 3;
  }
  return 4;
}

function overlapScore(left: readonly string[], right: readonly string[]): number {
  if (left.length < 1 || right.length < 1) {
    return 0;
  }
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      matches += 1;
    }
  }
  const denominator = Math.max(left.length, right.length);
  return clamp(matches / denominator);
}

export function buildManualSyncSymbolFingerprint(
  declaration: SemanticDeclarationFingerprint,
): ManualSyncSymbolFingerprint {
  const stateTokens = dedupeSorted(
    declaration.stateKeys
      .slice(0, 12)
      .flatMap((entry) => tokenizeSignal(entry))
      .slice(0, 8),
  );
  const callTokens = dedupeSorted(
    declaration.callGraphNeighborhood.neighbourNames
      .slice(0, 16)
      .flatMap((entry) => tokenizeSignal(entry))
      .slice(0, 8),
  );
  return {
    version: FINGERPRINT_VERSION,
    role: declaration.role,
    apiShape: declaration.ioSignature.apiShape,
    mutationProfile: declaration.mutationProfile,
    parameterCount: declaration.ioSignature.parameterCount,
    incomingBucket: bucketDegree(declaration.callGraphNeighborhood.incomingCount),
    outgoingBucket: bucketDegree(declaration.callGraphNeighborhood.outgoingCount),
    stateTokens,
    callTokens,
  };
}

export function scoreManualSyncSymbolFingerprint(
  target: ManualSyncSymbolFingerprint,
  candidate: ManualSyncSymbolFingerprint,
): number {
  if (target.version !== candidate.version) {
    return 0;
  }
  const roleScore = target.role === candidate.role ? 1 : 0;
  const apiShapeScore = target.apiShape === candidate.apiShape ? 1 : 0;
  const mutationScore = target.mutationProfile === candidate.mutationProfile ? 1 : 0;
  const parameterScore = target.parameterCount === candidate.parameterCount
    ? 1
    : Math.max(0, 1 - Math.abs(target.parameterCount - candidate.parameterCount) * 0.5);
  const inBucketScore = target.incomingBucket === candidate.incomingBucket ? 1 : 0;
  const outBucketScore = target.outgoingBucket === candidate.outgoingBucket ? 1 : 0;
  const stateOverlap = overlapScore(target.stateTokens, candidate.stateTokens);
  const callOverlap = overlapScore(target.callTokens, candidate.callTokens);
  return clamp(
    roleScore * 0.24 +
      apiShapeScore * 0.18 +
      mutationScore * 0.12 +
      parameterScore * 0.12 +
      inBucketScore * 0.08 +
      outBucketScore * 0.08 +
      stateOverlap * 0.1 +
      callOverlap * 0.08,
  );
}

export interface FingerprintResolutionCandidate {
  symbolKey: string;
  score: number;
}

export interface FingerprintResolutionResult {
  symbolKey: string;
  score: number;
  secondBestScore: number;
}

export function resolveSymbolByManualFingerprint(
  target: ManualSyncSymbolFingerprint,
  fingerprintsBySymbolKey: ReadonlyMap<string, ManualSyncSymbolFingerprint>,
  claimedSymbolKeys: ReadonlySet<string>,
  minimumScore: number,
  ambiguityDelta: number,
): FingerprintResolutionResult | undefined {
  const ranked: FingerprintResolutionCandidate[] = [];
  for (const [symbolKey, fingerprint] of fingerprintsBySymbolKey) {
    if (claimedSymbolKeys.has(symbolKey)) {
      continue;
    }
    const score = scoreManualSyncSymbolFingerprint(target, fingerprint);
    if (score < minimumScore) {
      continue;
    }
    ranked.push({ symbolKey, score });
  }
  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.symbolKey.localeCompare(right.symbolKey);
  });
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  const secondBestScore = ranked.length > 1 ? ranked[1]!.score : 0;
  if (best.score - secondBestScore < ambiguityDelta) {
    return undefined;
  }
  return {
    symbolKey: best.symbolKey,
    score: best.score,
    secondBestScore,
  };
}
