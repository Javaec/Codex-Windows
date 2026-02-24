import { RunMetrics } from "../contracts";
import { SemanticIrModel } from "../ir/semantic-ir";
import { OwnershipModel } from "../ir/ownership-model";
import { GreenGateStageOutput, QualityGatesStageOutput } from "../contracts";
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

export function buildRunMetrics(
  semanticIr: SemanticIrModel,
  ownershipModel: OwnershipModel,
  qualityGates: QualityGatesStageOutput,
  greenGates: GreenGateStageOutput,
): RunMetrics {
  return {
    mappedFiles: mappedFilesCount(semanticIr),
    mappedSymbols: mappedSymbolsCount(ownershipModel),
    nameQuality: averageNameQuality(ownershipModel),
    buildHealth: buildHealth(greenGates),
    devHealth: devHealth(greenGates),
    genericPathNoiseCount: qualityGates.violations.length,
    lowQualitySymbolCount: lowQualitySymbolCount(ownershipModel),
    layerCoverage: coverageByLayer(ownershipModel),
    archetypeCoverage: coverageByArchetype(ownershipModel),
  };
}
