import type { OwnershipResolutionResult } from "./ownership-resolver";
import type { SemanticLayer } from "./semantic-ir";
import type { LiftedExportKind } from "./symbol-lifter";
import { normalizeDeobfSourceFile, toProjectRelativeTargetPath } from "./deobfuscation-report";

export interface SemanticAliasHintRow {
  sourceFile: string;
  sourceSymbol: string;
  name: string;
  score: number;
}

export interface SemanticEmitterExportRow {
  name: string;
  sourceSymbol: string;
  kind: LiftedExportKind;
  sourceLine: number;
  confidence: number;
  reference: string;
  rationale: string[];
}

export interface SemanticEmitterModuleRow {
  targetPath: string;
  sourceFile: string;
  ownerLayer: SemanticLayer;
  confidence: number;
  symbols: string[];
  references: string[];
  rationale: string[];
  exports: SemanticEmitterExportRow[];
}

export interface SemanticEmitterModel {
  modules: SemanticEmitterModuleRow[];
  aliasHints: SemanticAliasHintRow[];
  aliasHintBySourceAndSymbol: Map<string, SemanticAliasHintRow>;
}

function splitIdentifierTokens(input: string): string[] {
  const normalized = input
    .replace(/[_\-./:]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return normalized
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function toSafeExportIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) return normalized;
  return "symbol_export";
}

function sanitizeExportName(input: string): string {
  const primary = toSafeExportIdentifier(input);
  if (primary !== "symbol_export") return primary;
  return toSafeExportIdentifier(input.trim().replace(/\s+/g, "_"));
}

function scoreAliasNameQuality(input: string): number {
  let score = 1;
  if (input.length < 4) score -= 0.45;
  if (input.length > 56) score -= 0.3;
  if (/\d{3,}$/.test(input)) score -= 0.35;
  if (/^[a-z]{1,3}$/i.test(input)) score -= 0.5;
  const tokens = splitIdentifierTokens(input).map((token) => token.toLowerCase());
  if (tokens.length <= 1) score -= 0.2;
  if (tokens.length > 5) score -= 0.35;
  if (/(?:value|data|item|object|entry|result|state|handler|runtime|service)$/i.test(input)) {
    score -= 0.3;
  }
  return Math.max(0, Math.min(1, score));
}

function isGenericAliasName(input: string): boolean {
  if (input.length < 5) return true;
  if (/\d{2,}$/.test(input)) return true;
  if (
    /^(?:get|set|use|run|do|make|build|create|update|load|fetch|handle|process|resolve|compute|parse|format|map)[a-z0-9]*$/i.test(
      input,
    )
  ) {
    const tokens = splitIdentifierTokens(input);
    if (tokens.length <= 2 && input.length <= 18) return true;
  }
  return false;
}

function isNoisyAliasToken(token: string): boolean {
  if (token.length <= 2) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^(?:id|ref|tmp|temp|var|misc|unknown|chunk|assets|renderer|main|services|tauri)$/.test(token)) {
    return true;
  }
  return false;
}

function toAliasHintKey(sourceFile: string, sourceSymbol: string): string {
  return `${sourceFile}|${sourceSymbol}`;
}

function validateModuleShape(input: {
  targetPath: string;
  sourceFile: string;
  ownerLayer: SemanticLayer;
}): void {
  if (input.targetPath.length === 0) {
    throw new Error("Semantic emitter model: empty targetPath.");
  }
  if (input.sourceFile.length === 0) {
    throw new Error(`Semantic emitter model: empty sourceFile for ${input.targetPath}.`);
  }
  if (
    input.ownerLayer !== "main" &&
    input.ownerLayer !== "renderer" &&
    input.ownerLayer !== "services" &&
    input.ownerLayer !== "tauri" &&
    input.ownerLayer !== "unknown"
  ) {
    throw new Error(`Semantic emitter model: unsupported owner layer '${input.ownerLayer}' for ${input.targetPath}.`);
  }
}

export function buildSemanticEmitterModel(input: { ownershipResolution: OwnershipResolutionResult }): SemanticEmitterModel {
  const aliasHintBySourceAndSymbol = new Map<string, SemanticAliasHintRow>();
  const targetPathSet = new Set<string>();
  const modules: SemanticEmitterModuleRow[] = [];

  for (const module of input.ownershipResolution.model.modules) {
    const targetPath = toProjectRelativeTargetPath(module.modulePath);
    const sourceFile = normalizeDeobfSourceFile(module.sourceFile);
    validateModuleShape({
      targetPath,
      sourceFile,
      ownerLayer: module.ownerLayer,
    });
    if (targetPathSet.has(targetPath)) {
      throw new Error(`Semantic emitter model: duplicate targetPath '${targetPath}'.`);
    }
    targetPathSet.add(targetPath);

    const exportByName = new Map<string, SemanticEmitterExportRow>();
    for (const symbol of module.symbols) {
      const name = sanitizeExportName(symbol.exportedName);
      if (name === "symbol_export") continue;
      const kind = symbol.kind;
      if (kind !== "class" && kind !== "function" && kind !== "variable") continue;
      const row: SemanticEmitterExportRow = {
        name,
        sourceSymbol: symbol.sourceSymbol,
        kind,
        sourceLine: symbol.sourceLine,
        confidence: symbol.confidence,
        reference: symbol.reference.trim(),
        rationale: [...symbol.rationale].sort((a, b) => a.localeCompare(b)),
      };
      const current = exportByName.get(name);
      if (!current || row.confidence > current.confidence) {
        exportByName.set(name, row);
      }

      const sourceSymbol = symbol.sourceSymbol.trim();
      if (sourceSymbol.length === 0) continue;
      if (kind !== "class" && kind !== "function") continue;
      if (row.confidence < 0.95) continue;
      if (isGenericAliasName(name)) continue;
      const aliasTokens = splitIdentifierTokens(name).map((token) => token.toLowerCase());
      if (aliasTokens.length === 0 || aliasTokens.length > 5) continue;
      if (aliasTokens.some((token) => isNoisyAliasToken(token))) continue;
      const quality = scoreAliasNameQuality(name);
      if (quality < 0.86) continue;
      const aliasScore = row.confidence * 2 + quality;
      const key = toAliasHintKey(sourceFile, sourceSymbol);
      const currentHint = aliasHintBySourceAndSymbol.get(key);
      if (!currentHint || aliasScore > currentHint.score) {
        aliasHintBySourceAndSymbol.set(key, {
          sourceFile,
          sourceSymbol,
          name,
          score: aliasScore,
        });
      }
    }

    const exports = Array.from(exportByName.values()).sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });

    modules.push({
      targetPath,
      sourceFile,
      ownerLayer: module.ownerLayer,
      confidence: module.confidence,
      symbols: exports.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
      references: [...module.references]
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .sort((a, b) => a.localeCompare(b)),
      rationale: [...module.rationale]
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .sort((a, b) => a.localeCompare(b)),
      exports,
    });
  }

  modules.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  const aliasHints = Array.from(aliasHintBySourceAndSymbol.values()).sort((a, b) => {
    const sourceCmp = a.sourceFile.localeCompare(b.sourceFile);
    if (sourceCmp !== 0) return sourceCmp;
    const symbolCmp = a.sourceSymbol.localeCompare(b.sourceSymbol);
    if (symbolCmp !== 0) return symbolCmp;
    return b.score - a.score;
  });

  return {
    modules,
    aliasHints,
    aliasHintBySourceAndSymbol,
  };
}

export function resolveSemanticAliasHint(
  model: SemanticEmitterModel,
  input: { sourceFile: string; sourceSymbol: string },
): string | undefined {
  const sourceFile = normalizeDeobfSourceFile(input.sourceFile);
  if (sourceFile.length === 0) return undefined;
  const sourceSymbol = input.sourceSymbol.trim();
  if (sourceSymbol.length === 0) return undefined;
  return model.aliasHintBySourceAndSymbol.get(toAliasHintKey(sourceFile, sourceSymbol))?.name;
}
