import { ToolWeights } from "../contracts";
import { scoreNameQuality, isGenericName, isIdentifierName } from "./name-quality";
import {
  SemanticCallEdge,
  SemanticDeclarationCluster,
  SemanticDomainDeclaration,
  SemanticFileHint,
  SemanticIrModel,
  SemanticSourceMapHint,
  SemanticStateKey,
  SemanticSymbol,
  buildSemanticIr,
} from "./semantic-ir";
import { EvidenceStoreModel } from "./evidence-store";

export interface SemanticIrSweepProfile {
  profileId: string;
  toolWeights: ToolWeights;
}

export interface SemanticIrProfileSummary {
  profileId: string;
  symbolCount: number;
  fileHintCount: number;
  averageSymbolConfidence: number;
}

export interface SemanticIrSweepResult {
  merged: SemanticIrModel;
  profileSummaries: SemanticIrProfileSummary[];
  profileCount: number;
  anchorProfileId: string;
  mergedSymbolWinners: number;
  mergedFileHintWinners: number;
}

interface ProfileModel {
  profileId: string;
  model: SemanticIrModel;
}

interface ScoredSymbolCandidate {
  profileId: string;
  symbol: SemanticSymbol;
  score: number;
}

interface ScoredFileHintCandidate {
  profileId: string;
  hint: SemanticFileHint;
  score: number;
}

interface RankedNameCandidate {
  name: string;
  score: number;
  quality: number;
  support: number;
  evidence: number;
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

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectAnchorModel(models: ProfileModel[]): ProfileModel {
  const sorted = [...models].sort((left, right) => {
    if (left.model.symbols.length !== right.model.symbols.length) {
      return right.model.symbols.length - left.model.symbols.length;
    }
    if (left.model.callEdges.length !== right.model.callEdges.length) {
      return right.model.callEdges.length - left.model.callEdges.length;
    }
    return left.profileId.localeCompare(right.profileId);
  });
  const anchor = sorted[0];
  if (!anchor) {
    throw new Error("semantic-ir-sweep: no profile models available");
  }
  return anchor;
}

function summarizeProfile(profileId: string, model: SemanticIrModel): SemanticIrProfileSummary {
  const totalConfidence = model.symbols.reduce((sum, symbol) => sum + symbol.confidence, 0);
  const averageSymbolConfidence = model.symbols.length === 0 ? 0 : clamp(totalConfidence / model.symbols.length);
  return {
    profileId,
    symbolCount: model.symbols.length,
    fileHintCount: model.fileHints.length,
    averageSymbolConfidence,
  };
}

function symbolCandidateScore(symbol: SemanticSymbol): number {
  const provenanceBonus = Math.min(0.12, symbol.provenance.length * 0.02);
  const genericPenalty = isGenericName(symbol.name) ? 0.12 : 0;
  return symbol.confidence * 0.62 + symbol.quality * 0.3 + provenanceBonus - genericPenalty;
}

function fileHintCandidateScore(hint: SemanticFileHint): number {
  const provenanceBonus = Math.min(0.08, hint.provenance.length * 0.015);
  return hint.confidence * 0.9 + provenanceBonus;
}

function buildRankedSymbolNames(candidates: ScoredSymbolCandidate[]): RankedNameCandidate[] {
  const ranking = new Map<string, RankedNameCandidate>();
  for (const candidate of candidates) {
    const candidateNames = [...new Set([candidate.symbol.name, ...candidate.symbol.alternatives])];
    for (const candidateName of candidateNames) {
      if (!isIdentifierName(candidateName)) {
        continue;
      }
      const quality = scoreNameQuality(candidateName);
      if (quality < 0.2) {
        continue;
      }
      const genericPenalty = isGenericName(candidateName) ? 0.14 : 0;
      const baseScore = candidate.score * 0.52 + quality * 0.4 + candidate.symbol.confidence * 0.08 - genericPenalty;

      const existing = ranking.get(candidateName);
      if (existing) {
        existing.score += baseScore;
        existing.support += 1;
        existing.quality = Math.max(existing.quality, quality);
        existing.evidence = Math.max(existing.evidence, candidate.symbol.evidenceIds.length);
        continue;
      }
      ranking.set(candidateName, {
        name: candidateName,
        score: baseScore,
        quality,
        support: 1,
        evidence: candidate.symbol.evidenceIds.length,
      });
    }
  }

  return [...ranking.values()]
    .map((entry) => ({
      ...entry,
      score: entry.score + Math.min(0.24, entry.support * 0.04) + Math.min(0.08, entry.evidence * 0.005),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.quality !== right.quality) {
        return right.quality - left.quality;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 16);
}

function selectWinnerSymbolName(
  rankedNames: RankedNameCandidate[],
  defaultWinnerName: string,
): { winnerName: string; winnerQuality: number; alternatives: string[] } {
  const defaultEntry = rankedNames.find((entry) => entry.name === defaultWinnerName);
  const first = rankedNames[0];
  if (!first) {
    const quality = scoreNameQuality(defaultWinnerName);
    return {
      winnerName: defaultWinnerName,
      winnerQuality: quality,
      alternatives: [],
    };
  }

  const baselineScore = defaultEntry ? defaultEntry.score : scoreNameQuality(defaultWinnerName) * 0.55;
  const baselineQuality = defaultEntry ? defaultEntry.quality : scoreNameQuality(defaultWinnerName);
  const topIsBetter = first.score >= baselineScore + 0.05;
  const genericUpgrade = isGenericName(defaultWinnerName) && first.quality >= 0.72 && first.score >= baselineScore - 0.015;
  const qualityUpgrade = first.quality >= baselineQuality + 0.08 && first.score >= baselineScore - 0.01;
  const winnerName = topIsBetter || genericUpgrade || qualityUpgrade ? first.name : defaultWinnerName;
  const winnerEntry = rankedNames.find((entry) => entry.name === winnerName);

  return {
    winnerName,
    winnerQuality: winnerEntry ? winnerEntry.quality : scoreNameQuality(winnerName),
    alternatives: rankedNames.filter((entry) => entry.name !== winnerName).slice(0, 8).map((entry) => entry.name),
  };
}

function mergeSymbols(models: ProfileModel[], anchorModel: ProfileModel): { symbols: SemanticSymbol[]; winners: number } {
  const candidateByKey = new Map<string, ScoredSymbolCandidate[]>();

  for (const model of models) {
    for (const symbol of model.model.symbols) {
      const scored: ScoredSymbolCandidate = {
        profileId: model.profileId,
        symbol,
        score: symbolCandidateScore(symbol),
      };
      const existing = candidateByKey.get(symbol.symbolKey);
      if (existing) {
        existing.push(scored);
      } else {
        candidateByKey.set(symbol.symbolKey, [scored]);
      }
    }
  }

  const anchorByKey = new Map(anchorModel.model.symbols.map((symbol) => [symbol.symbolKey, symbol]));
  const merged: SemanticSymbol[] = [];
  let winnerCount = 0;

  const symbolKeys = [...candidateByKey.keys()].sort((left, right) => left.localeCompare(right));
  for (const symbolKey of symbolKeys) {
    const candidates = candidateByKey.get(symbolKey);
    if (!candidates || candidates.length === 0) {
      continue;
    }

    candidates.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.profileId.localeCompare(right.profileId);
    });
    const winner = candidates[0];
    if (!winner) {
      continue;
    }

    const anchor = anchorByKey.get(symbolKey) ?? winner.symbol;
    const averageConfidence =
      candidates.reduce((sum, candidate) => sum + candidate.symbol.confidence, 0) / Math.max(1, candidates.length);
    const unionEvidence = new Set<string>();
    const unionProvenance = new Set<string>();
    for (const candidate of candidates) {
      for (const evidenceId of candidate.symbol.evidenceIds) {
        unionEvidence.add(evidenceId);
      }
      for (const provenance of candidate.symbol.provenance) {
        unionProvenance.add(provenance);
      }
    }

    const rankedNames = buildRankedSymbolNames(candidates);
    const selectedName = selectWinnerSymbolName(rankedNames, winner.symbol.name);

    merged.push({
      ...anchor,
      name: selectedName.winnerName,
      confidence: clamp(Math.max(winner.symbol.confidence, averageConfidence * 0.85)),
      quality: Math.max(winner.symbol.quality, selectedName.winnerQuality),
      alternatives: selectedName.alternatives,
      evidenceIds: [...unionEvidence].sort((left, right) => left.localeCompare(right)),
      provenance: [...unionProvenance].sort((left, right) => left.localeCompare(right)),
      domainKind: winner.symbol.domainKind,
      preferredArchetype: winner.symbol.preferredArchetype,
      routeFlowScore: winner.symbol.routeFlowScore,
      eventFlowScore: winner.symbol.eventFlowScore,
      declarationClusterId:
        anchor.declarationClusterId.length > 0 ? anchor.declarationClusterId : winner.symbol.declarationClusterId,
    });
    winnerCount += 1;
  }

  return {
    symbols: merged.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey)),
    winners: winnerCount,
  };
}

function mergeFileHints(models: ProfileModel[]): { fileHints: SemanticFileHint[]; winners: number } {
  const candidatesByPath = new Map<string, ScoredFileHintCandidate[]>();

  for (const model of models) {
    for (const hint of model.model.fileHints) {
      const scored: ScoredFileHintCandidate = {
        profileId: model.profileId,
        hint,
        score: fileHintCandidateScore(hint),
      };
      const existing = candidatesByPath.get(hint.pathHint);
      if (existing) {
        existing.push(scored);
      } else {
        candidatesByPath.set(hint.pathHint, [scored]);
      }
    }
  }

  const merged: SemanticFileHint[] = [];
  let winnerCount = 0;

  const sortedPaths = [...candidatesByPath.keys()].sort((left, right) => left.localeCompare(right));
  for (const pathHint of sortedPaths) {
    const candidates = candidatesByPath.get(pathHint);
    if (!candidates || candidates.length === 0) {
      continue;
    }

    candidates.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.profileId.localeCompare(right.profileId);
    });
    const winner = candidates[0];
    if (!winner) {
      continue;
    }

    const allEvidence = new Set<string>();
    const allProvenance = new Set<string>();
    let confidenceTotal = 0;
    for (const candidate of candidates) {
      confidenceTotal += candidate.hint.confidence;
      for (const evidenceId of candidate.hint.evidenceIds) {
        allEvidence.add(evidenceId);
      }
      for (const provenance of candidate.hint.provenance) {
        allProvenance.add(provenance);
      }
    }
    const averageConfidence = confidenceTotal / Math.max(1, candidates.length);
    const provenanceBonus = Math.min(0.08, allProvenance.size * 0.01);

    merged.push({
      pathHint,
      confidence: clamp(Math.max(winner.hint.confidence, averageConfidence * 0.9) + provenanceBonus),
      evidenceIds: [...allEvidence].sort((left, right) => left.localeCompare(right)),
      provenance: [...allProvenance].sort((left, right) => left.localeCompare(right)),
    });
    winnerCount += 1;
  }

  merged.sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    return left.pathHint.localeCompare(right.pathHint);
  });

  return {
    fileHints: merged,
    winners: winnerCount,
  };
}

function mergeCallEdges(models: ProfileModel[]): SemanticCallEdge[] {
  const byEdge = new Map<string, SemanticCallEdge[]>();
  for (const model of models) {
    for (const edge of model.model.callEdges) {
      const existing = byEdge.get(edge.edge);
      if (existing) {
        existing.push(edge);
      } else {
        byEdge.set(edge.edge, [edge]);
      }
    }
  }

  const merged: SemanticCallEdge[] = [];
  for (const edge of [...byEdge.keys()].sort((left, right) => left.localeCompare(right))) {
    const candidates = byEdge.get(edge);
    if (!candidates || candidates.length === 0) {
      continue;
    }
    const winner = [...candidates].sort((left, right) => right.confidence - left.confidence)[0];
    if (!winner) {
      continue;
    }
    const evidenceIds = new Set<string>();
    const provenance = new Set<string>();
    const owners = new Set<string>();
    let maxConfidence = 0;
    for (const candidate of candidates) {
      maxConfidence = Math.max(maxConfidence, candidate.confidence);
      for (const evidenceId of candidate.evidenceIds) {
        evidenceIds.add(evidenceId);
      }
      for (const tool of candidate.provenance) {
        provenance.add(tool);
      }
      for (const owner of candidate.owners) {
        owners.add(owner);
      }
    }
    merged.push({
      ...winner,
      confidence: clamp(maxConfidence),
      evidenceIds: [...evidenceIds].sort((left, right) => left.localeCompare(right)),
      provenance: [...provenance].sort((left, right) => left.localeCompare(right)),
      owners: [...owners].sort((left, right) => left.localeCompare(right)),
    });
  }
  return merged;
}

function mergeStateKeys(models: ProfileModel[]): SemanticStateKey[] {
  const byKey = new Map<string, SemanticStateKey[]>();
  for (const model of models) {
    for (const stateKey of model.model.stateKeys) {
      const existing = byKey.get(stateKey.key);
      if (existing) {
        existing.push(stateKey);
      } else {
        byKey.set(stateKey.key, [stateKey]);
      }
    }
  }

  const merged: SemanticStateKey[] = [];
  for (const stateKey of [...byKey.keys()].sort((left, right) => left.localeCompare(right))) {
    const candidates = byKey.get(stateKey);
    if (!candidates || candidates.length === 0) {
      continue;
    }
    const winner = [...candidates].sort((left, right) => right.confidence - left.confidence)[0];
    if (!winner) {
      continue;
    }
    const evidenceIds = new Set<string>();
    const provenance = new Set<string>();
    const owners = new Set<string>();
    const tokens = new Set<string>();
    let maxConfidence = 0;
    for (const candidate of candidates) {
      maxConfidence = Math.max(maxConfidence, candidate.confidence);
      for (const evidenceId of candidate.evidenceIds) {
        evidenceIds.add(evidenceId);
      }
      for (const tool of candidate.provenance) {
        provenance.add(tool);
      }
      for (const owner of candidate.owners) {
        owners.add(owner);
      }
      for (const token of candidate.tokens) {
        tokens.add(token);
      }
    }
    merged.push({
      ...winner,
      confidence: clamp(maxConfidence),
      evidenceIds: [...evidenceIds].sort((left, right) => left.localeCompare(right)),
      provenance: [...provenance].sort((left, right) => left.localeCompare(right)),
      owners: [...owners].sort((left, right) => left.localeCompare(right)),
      tokens: [...tokens].sort((left, right) => left.localeCompare(right)),
    });
  }
  return merged;
}

function mergeSourceMaps(models: ProfileModel[]): SemanticSourceMapHint[] {
  const byPath = new Map<string, SemanticSourceMapHint[]>();
  for (const model of models) {
    for (const sourceMap of model.model.sourceMaps) {
      const existing = byPath.get(sourceMap.sourcePath);
      if (existing) {
        existing.push(sourceMap);
      } else {
        byPath.set(sourceMap.sourcePath, [sourceMap]);
      }
    }
  }

  const merged: SemanticSourceMapHint[] = [];
  for (const sourcePath of [...byPath.keys()].sort((left, right) => left.localeCompare(right))) {
    const candidates = byPath.get(sourcePath);
    if (!candidates || candidates.length === 0) {
      continue;
    }
    const winner = [...candidates].sort((left, right) => right.confidence - left.confidence)[0];
    if (!winner) {
      continue;
    }
    const evidenceIds = new Set<string>();
    const provenance = new Set<string>();
    let maxConfidence = 0;
    for (const candidate of candidates) {
      maxConfidence = Math.max(maxConfidence, candidate.confidence);
      for (const evidenceId of candidate.evidenceIds) {
        evidenceIds.add(evidenceId);
      }
      for (const tool of candidate.provenance) {
        provenance.add(tool);
      }
    }
    merged.push({
      ...winner,
      confidence: clamp(maxConfidence),
      evidenceIds: [...evidenceIds].sort((left, right) => left.localeCompare(right)),
      provenance: [...provenance].sort((left, right) => left.localeCompare(right)),
    });
  }
  return merged;
}

function buildSyntheticClusterId(symbolKey: string): string {
  const hash = stableHash(symbolKey).toString(16).padStart(8, "0");
  return `cluster-sweep-${hash}`;
}

function mergeDeclarationsAndClusters(
  symbols: SemanticSymbol[],
  models: ProfileModel[],
  anchorModel: ProfileModel,
): {
  declarations: SemanticDomainDeclaration[];
  clusters: SemanticDeclarationCluster[];
} {
  const anchorDeclarationBySymbol = new Map(anchorModel.model.domainDeclarations.map((declaration) => [declaration.symbolKey, declaration]));
  const declarationCandidatesBySymbol = new Map<string, SemanticDomainDeclaration[]>();
  for (const model of models) {
    for (const declaration of model.model.domainDeclarations) {
      const existing = declarationCandidatesBySymbol.get(declaration.symbolKey);
      if (existing) {
        existing.push(declaration);
      } else {
        declarationCandidatesBySymbol.set(declaration.symbolKey, [declaration]);
      }
    }
  }

  const mergedDeclarations: SemanticDomainDeclaration[] = [];
  for (const symbol of symbols) {
    const candidates = declarationCandidatesBySymbol.get(symbol.symbolKey) ?? [];
    const winner = [...candidates].sort((left, right) => right.confidence - left.confidence)[0];
    const anchor = anchorDeclarationBySymbol.get(symbol.symbolKey);
    const source = anchor ?? winner;

    const clusterId =
      (source && source.clusterId.length > 0 ? source.clusterId : "") ||
      (symbol.declarationClusterId.length > 0 ? symbol.declarationClusterId : "") ||
      buildSyntheticClusterId(symbol.symbolKey);

    mergedDeclarations.push({
      declarationId: source?.declarationId ?? `${symbol.symbolKey}::${symbol.domainKind}`,
      symbolKey: symbol.symbolKey,
      symbolName: symbol.name,
      ownerLineageId: source?.ownerLineageId ?? symbol.owner,
      domainKind: symbol.domainKind,
      preferredArchetype: symbol.preferredArchetype,
      clusterId,
      callNeighbours: source?.callNeighbours ?? [],
      stateSignals: source?.stateSignals ?? [],
      routeFlowScore: symbol.routeFlowScore,
      eventFlowScore: symbol.eventFlowScore,
      confidence: clamp(Math.max(symbol.confidence, source?.confidence ?? 0)),
    });
  }

  const clusterById = new Map(anchorModel.model.declarationClusters.map((cluster) => [cluster.clusterId, { ...cluster }]));
  const membersByCluster = new Map<string, string[]>();
  for (const declaration of mergedDeclarations) {
    const existing = membersByCluster.get(declaration.clusterId);
    if (existing) {
      existing.push(declaration.symbolKey);
    } else {
      membersByCluster.set(declaration.clusterId, [declaration.symbolKey]);
    }
  }

  for (const [clusterId, memberKeys] of membersByCluster.entries()) {
    const uniqueMembers = [...new Set(memberKeys)].sort((left, right) => left.localeCompare(right));
    const existingCluster = clusterById.get(clusterId);
    if (existingCluster) {
      existingCluster.symbolKeys = uniqueMembers;
      continue;
    }

    const representative = mergedDeclarations.find((declaration) => declaration.clusterId === clusterId);
    if (!representative) {
      continue;
    }

    clusterById.set(clusterId, {
      clusterId,
      ownerLineageId: representative.ownerLineageId,
      domainKind: representative.domainKind,
      preferredArchetype: representative.preferredArchetype,
      symbolKeys: uniqueMembers,
      callEdgeCount: 0,
      stateSignalCount: representative.stateSignals.length,
      routeFlowScore: representative.routeFlowScore,
      eventFlowScore: representative.eventFlowScore,
      cohesionScore: 0.45,
    });
  }

  const clusters = [...clusterById.values()].sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  const declarations = mergedDeclarations.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  return {
    declarations,
    clusters,
  };
}

export function buildSemanticIrFromSweep(
  evidenceStore: EvidenceStoreModel,
  sweepProfiles: SemanticIrSweepProfile[],
): SemanticIrSweepResult {
  if (sweepProfiles.length === 0) {
    throw new Error("semantic-ir-sweep: no sweep profiles provided");
  }

  const models: ProfileModel[] = sweepProfiles.map((profile) => ({
    profileId: profile.profileId,
    model: buildSemanticIr(evidenceStore, profile.toolWeights),
  }));

  const anchorModel = selectAnchorModel(models);
  const mergedSymbols = mergeSymbols(models, anchorModel);
  const mergedFileHints = mergeFileHints(models);
  const mergedCallEdges = mergeCallEdges(models);
  const mergedStateKeys = mergeStateKeys(models);
  const mergedSourceMaps = mergeSourceMaps(models);
  const mergedDeclarationsAndClusters = mergeDeclarationsAndClusters(mergedSymbols.symbols, models, anchorModel);

  const merged: SemanticIrModel = {
    version: 2,
    generatedAtIso: new Date().toISOString(),
    fileHints: mergedFileHints.fileHints,
    symbols: mergedSymbols.symbols,
    callEdges: mergedCallEdges,
    stateKeys: mergedStateKeys,
    sourceMaps: mergedSourceMaps,
    domainDeclarations: mergedDeclarationsAndClusters.declarations,
    declarationClusters: mergedDeclarationsAndClusters.clusters,
  };

  const profileSummaries = models
    .map((profileModel) => summarizeProfile(profileModel.profileId, profileModel.model))
    .sort((left, right) => left.profileId.localeCompare(right.profileId));

  return {
    merged,
    profileSummaries,
    profileCount: models.length,
    anchorProfileId: anchorModel.profileId,
    mergedSymbolWinners: mergedSymbols.winners,
    mergedFileHintWinners: mergedFileHints.winners,
  };
}
