import type { SemanticIrModel, SemanticIrModule, SemanticIrSymbol, SemanticLayer } from "./semantic-ir";

export interface OwnershipResolutionDiagnostics {
  conflicts: number;
  reassignedSymbols: number;
  droppedSymbols: number;
}

export interface OwnershipResolutionResult {
  model: SemanticIrModel;
  diagnostics: OwnershipResolutionDiagnostics;
}

type SymbolCandidate = {
  moduleIndex: number;
  symbolIndex: number;
  score: number;
};

function inferLayerFromSourceFile(sourceFile: string): SemanticLayer {
  const normalized = sourceFile.toLowerCase();
  if (normalized.includes("/.vite/build/main-") || normalized.includes("/.vite/build/main.")) return "main";
  if (normalized.includes("/.vite/build/worker")) return "services";
  if (normalized.includes("webview/")) return "renderer";
  if (normalized.includes("src-tauri") || normalized.includes("tauri")) return "tauri";
  return "unknown";
}

function splitTokens(value: string): string[] {
  return value
    .replace(/[_\-./:]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/g)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3);
}

function scoreLayerAffinity(moduleLayer: SemanticLayer, sourceLayer: SemanticLayer): number {
  if (moduleLayer === sourceLayer) return 16;
  if (moduleLayer === "unknown" || sourceLayer === "unknown") return 2;
  if (moduleLayer === "renderer" && sourceLayer === "services") return 4;
  if (moduleLayer === "services" && sourceLayer === "renderer") return 4;
  if (moduleLayer === "main" && sourceLayer === "tauri") return 5;
  if (moduleLayer === "tauri" && sourceLayer === "main") return 5;
  return -6;
}

function scorePathAlignment(module: SemanticIrModule, symbol: SemanticIrSymbol): number {
  const moduleTokens = new Set(splitTokens(module.modulePath));
  const symbolTokens = splitTokens(symbol.exportedName);
  if (moduleTokens.size === 0 || symbolTokens.length === 0) return 0;
  let hits = 0;
  for (const token of symbolTokens) {
    if (moduleTokens.has(token)) hits += 1;
  }
  return Math.min(14, hits * 4);
}

function computeOwnershipScore(module: SemanticIrModule, symbol: SemanticIrSymbol): number {
  const sourceLayer = inferLayerFromSourceFile(symbol.sourceFile || module.sourceFile);
  const layerScore = scoreLayerAffinity(module.ownerLayer, sourceLayer);
  const pathScore = scorePathAlignment(module, symbol);
  return symbol.confidence * 100 + module.confidence * 35 + layerScore + pathScore;
}

function cloneSymbol(symbol: SemanticIrSymbol): SemanticIrSymbol {
  return {
    symbolKey: symbol.symbolKey,
    sourceSymbol: symbol.sourceSymbol,
    exportedName: symbol.exportedName,
    kind: symbol.kind,
    confidence: symbol.confidence,
    sourceFile: symbol.sourceFile,
    sourceLine: symbol.sourceLine,
    reference: symbol.reference,
    rationale: [...symbol.rationale],
  };
}

function cloneModule(module: SemanticIrModule): SemanticIrModule {
  return {
    modulePath: module.modulePath,
    ownerLayer: module.ownerLayer,
    sourceFile: module.sourceFile,
    confidence: module.confidence,
    symbols: module.symbols.map(cloneSymbol),
    references: [...module.references],
    rationale: [...module.rationale],
  };
}

export function resolveSemanticOwnership(model: SemanticIrModel): OwnershipResolutionResult {
  const modules = model.modules.map(cloneModule);
  const candidatesBySymbolKey = new Map<string, SymbolCandidate[]>();
  let conflicts = 0;

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    for (let symbolIndex = 0; symbolIndex < module.symbols.length; symbolIndex += 1) {
      const symbol = module.symbols[symbolIndex];
      const bucket = candidatesBySymbolKey.get(symbol.symbolKey) ?? [];
      bucket.push({
        moduleIndex,
        symbolIndex,
        score: computeOwnershipScore(module, symbol),
      });
      candidatesBySymbolKey.set(symbol.symbolKey, bucket);
    }
  }

  let reassignedSymbols = 0;
  let droppedSymbols = 0;
  const keepByModule = new Map<number, Set<number>>();
  for (const candidates of candidatesBySymbolKey.values()) {
    if (candidates.length > 1) conflicts += 1;
    const sorted = candidates.sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    if (!winner) continue;
    const winnerSet = keepByModule.get(winner.moduleIndex) ?? new Set<number>();
    winnerSet.add(winner.symbolIndex);
    keepByModule.set(winner.moduleIndex, winnerSet);
    for (const loser of sorted.slice(1)) {
      droppedSymbols += 1;
      if (loser.moduleIndex !== winner.moduleIndex) reassignedSymbols += 1;
    }
  }

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const keepIndexes = keepByModule.get(moduleIndex) ?? new Set<number>();
    const filtered: SemanticIrSymbol[] = [];
    for (let symbolIndex = 0; symbolIndex < module.symbols.length; symbolIndex += 1) {
      if (keepIndexes.has(symbolIndex)) {
        filtered.push(module.symbols[symbolIndex]);
      }
    }

    const byExportName = new Map<string, SemanticIrSymbol>();
    for (const symbol of filtered) {
      const current = byExportName.get(symbol.exportedName);
      if (!current || symbol.confidence > current.confidence) {
        byExportName.set(symbol.exportedName, symbol);
      }
    }
    module.symbols = Array.from(byExportName.values()).sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.exportedName.localeCompare(b.exportedName);
    });
  }

  return {
    model: {
      generatedAtUtc: model.generatedAtUtc,
      modules: modules.sort((a, b) => a.modulePath.localeCompare(b.modulePath)),
    },
    diagnostics: {
      conflicts,
      reassignedSymbols,
      droppedSymbols,
    },
  };
}

