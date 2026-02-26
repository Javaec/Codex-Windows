import { RunMetrics } from "../contracts";
import { SemanticIrModel } from "../ir/semantic-ir";
import { OwnershipModel } from "../ir/ownership-model";
import { GreenGateStageOutput, MonolithCensusStageOutput, QualityGatesStageOutput } from "../contracts";
import { scoreNameQuality } from "../ir/name-quality";

const GENERIC_SEGMENTS = new Set<string>(["types", "utils", "index", "common", "shared"]);

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function mappedFilesCount(semanticIr: SemanticIrModel): number {
  const validHints = semanticIr.fileHints.filter((hint) => {
    const segments = hint.pathHint.split("/");
    return !segments.some((segment) => GENERIC_SEGMENTS.has(segment.toLowerCase()));
  });
  return validHints.length;
}

function mappedSymbolsCount(ownershipModel: OwnershipModel): number {
  return ownershipModel.symbols.filter((symbol) => symbol.confidence >= 0.2 && scoreNameQuality(symbol.symbolName) >= 0.56).length;
}

function coverageSymbolsCount(ownershipModel: OwnershipModel): number {
  return ownershipModel.symbols.filter((symbol) => symbol.confidence >= 0.2).length;
}

function highConfidenceSymbolsCount(ownershipModel: OwnershipModel): number {
  return ownershipModel.symbols.filter((symbol) => symbol.confidence >= 0.75 && scoreNameQuality(symbol.symbolName) >= 0.7).length;
}

function averageNameQuality(ownershipModel: OwnershipModel): number {
  if (ownershipModel.symbols.length === 0) {
    return 0;
  }
  let total = 0;
  for (const symbol of ownershipModel.symbols) {
    total += scoreNameQuality(symbol.symbolName);
  }
  return clamp(total / ownershipModel.symbols.length);
}

function lowQualitySymbolCount(ownershipModel: OwnershipModel): number {
  let count = 0;
  for (const symbol of ownershipModel.symbols) {
    if (scoreNameQuality(symbol.symbolName) < 0.55) {
      count += 1;
    }
  }
  return count;
}

function buildHealth(greenGates: GreenGateStageOutput): boolean {
  const required = ["npm run typecheck", "npm run lint", "npm run build"];
  for (const command of required) {
    const matched = greenGates.checkedCommands.find((entry) => entry.command === command);
    if (!matched || matched.exitCode !== 0) {
      return false;
    }
  }
  return true;
}

function devHealth(greenGates: GreenGateStageOutput): boolean {
  const devCommand = greenGates.checkedCommands.find((entry) => entry.command === "npm run dev:smoke");
  if (!devCommand || devCommand.exitCode !== 0) {
    return false;
  }
  if (greenGates.runtimeErrorCount > 0 || greenGates.runtimeWarningCount > 0) {
    return false;
  }
  return true;
}

function coverageByLayer(ownershipModel: OwnershipModel): RunMetrics["layerCoverage"] {
  const coverage: RunMetrics["layerCoverage"] = {
    main: 0,
    renderer: 0,
    services: 0,
    tauri: 0,
  };
  for (const symbol of ownershipModel.symbols) {
    coverage[symbol.layer] += 1;
  }
  return coverage;
}

function coverageByArchetype(ownershipModel: OwnershipModel): RunMetrics["archetypeCoverage"] {
  const coverage: RunMetrics["archetypeCoverage"] = {
    hook: 0,
    service: 0,
    ui: 0,
    transport: 0,
    store: 0,
  };
  for (const symbol of ownershipModel.symbols) {
    coverage[symbol.archetype] += 1;
  }
  return coverage;
}

function normalizeCoverage(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return clamp(value);
}

function classCoverage(monolith: MonolithCensusStageOutput): number {
  if (monolith.classCount < 1) {
    return 0;
  }
  return 1;
}

function functionCoverage(monolith: MonolithCensusStageOutput): number {
  if (monolith.functionCount < 1) {
    return 0;
  }
  return 1;
}

function functionClassCoverage(monolith: MonolithCensusStageOutput): number {
  const total = monolith.classCount + monolith.functionCount;
  if (total < 1) {
    return 0;
  }
  return 1;
}

function variableCoverageByOwnership(monolith: MonolithCensusStageOutput, coverageOwnershipModel: OwnershipModel): number {
  if (monolith.variableCoverageCount < 1) {
    return 0;
  }
  let covered = 0;
  for (const symbol of coverageOwnershipModel.symbols) {
    if (symbol.symbolKey.includes(":coverage:var:")) {
      covered += 1;
    }
  }
  return normalizeCoverage(covered / monolith.variableCoverageCount);
}

export function buildRunMetrics(
  monolithCensus: MonolithCensusStageOutput,
  semanticIr: SemanticIrModel,
  coverageOwnershipModel: OwnershipModel,
  qualityOwnershipModel: OwnershipModel,
  qualityGates: QualityGatesStageOutput,
  greenGates: GreenGateStageOutput,
): RunMetrics {
  return {
    mappedFiles: mappedFilesCount(semanticIr),
    mappedSymbols: mappedSymbolsCount(qualityOwnershipModel),
    coverageSymbols: coverageSymbolsCount(coverageOwnershipModel),
    highConfidenceSymbols: highConfidenceSymbolsCount(qualityOwnershipModel),
    nameQuality: averageNameQuality(qualityOwnershipModel),
    coverageNameQuality: averageNameQuality(coverageOwnershipModel),
    classCoverage: classCoverage(monolithCensus),
    functionCoverage: functionCoverage(monolithCensus),
    functionClassCoverage: functionClassCoverage(monolithCensus),
    variableCoverage: variableCoverageByOwnership(monolithCensus, coverageOwnershipModel),
    buildHealth: buildHealth(greenGates),
    devHealth: devHealth(greenGates),
    genericPathNoiseCount: qualityGates.violations.length,
    lowQualitySymbolCount: lowQualitySymbolCount(qualityOwnershipModel),
    coverageLowQualitySymbolCount: lowQualitySymbolCount(coverageOwnershipModel),
    layerCoverage: coverageByLayer(qualityOwnershipModel),
    archetypeCoverage: coverageByArchetype(qualityOwnershipModel),
  };
}
