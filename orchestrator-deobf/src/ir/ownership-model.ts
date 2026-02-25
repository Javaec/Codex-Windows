import { ArchetypeId, LayerId } from "../contracts";
import { DomainKind, SemanticIrModel } from "./semantic-ir";
import { isGenericName } from "./name-quality";
import { ARCHETYPE_LAYER_COMPATIBILITY, assertArchetypeLayerCompatibility } from "./ownership-compatibility";

export interface OwnershipScoreBreakdown {
  main: number;
  renderer: number;
  services: number;
  tauri: number;
}

export interface OwnershipRecord {
  symbolKey: string;
  symbolName: string;
  layer: LayerId;
  archetype: ArchetypeId;
  domainKind: DomainKind;
  declarationClusterId: string;
  confidence: number;
  ownerLineageId: string;
  chunkHint: string;
  scores: OwnershipScoreBreakdown;
}

export interface OwnershipModel {
  version: number;
  generatedAtIso: string;
  symbols: OwnershipRecord[];
}

const LAYER_TIE_BREAK_ORDER: LayerId[] = ["services", "renderer", "main", "tauri"];

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

function emptyScores(): OwnershipScoreBreakdown {
  return {
    main: 0.1,
    renderer: 0.1,
    services: 0.1,
    tauri: 0.1,
  };
}

function addLayerScore(scores: OwnershipScoreBreakdown, layer: LayerId, value: number): void {
  if (layer === "main") {
    scores.main += value;
    return;
  }
  if (layer === "renderer") {
    scores.renderer += value;
    return;
  }
  if (layer === "services") {
    scores.services += value;
    return;
  }
  scores.tauri += value;
}

function applyDomainScores(domainKind: DomainKind, scores: OwnershipScoreBreakdown): void {
  if (domainKind === "hook") {
    addLayerScore(scores, "renderer", 1.35);
    return;
  }
  if (domainKind === "ui") {
    addLayerScore(scores, "renderer", 1.25);
    addLayerScore(scores, "services", 0.2);
    return;
  }
  if (domainKind === "store") {
    addLayerScore(scores, "services", 0.95);
    addLayerScore(scores, "renderer", 0.85);
    return;
  }
  if (domainKind === "transport") {
    addLayerScore(scores, "main", 0.95);
    addLayerScore(scores, "tauri", 0.95);
    addLayerScore(scores, "services", 0.25);
    return;
  }
  if (domainKind === "service") {
    addLayerScore(scores, "services", 1.2);
    addLayerScore(scores, "main", 0.15);
    return;
  }
  addLayerScore(scores, "services", 0.75);
  addLayerScore(scores, "renderer", 0.65);
  addLayerScore(scores, "main", 0.55);
  addLayerScore(scores, "tauri", 0.45);
}

function applyNameScores(symbolName: string, scores: OwnershipScoreBreakdown): void {
  const lower = symbolName.toLowerCase();
  if (lower.includes("ipc") || lower.includes("browserwindow") || lower.includes("electron") || lower.includes("menu")) {
    addLayerScore(scores, "main", 1.2);
  }
  if (lower.includes("tauri") || lower.includes("invoke") || lower.includes("rust") || lower.includes("command")) {
    addLayerScore(scores, "tauri", 1.2);
  }
  if (lower.includes("component") || lower.includes("view") || lower.includes("render") || lower.includes("dialog")) {
    addLayerScore(scores, "renderer", 1.05);
  }
  if (lower.includes("api") || lower.includes("http") || lower.includes("client") || lower.includes("repository")) {
    addLayerScore(scores, "services", 0.7);
  }
  if (lower.includes("socket") || lower.includes("channel") || lower.includes("rpc")) {
    addLayerScore(scores, "main", 0.45);
    addLayerScore(scores, "tauri", 0.4);
  }
}

function applyFlowScores(routeFlowScore: number, eventFlowScore: number, scores: OwnershipScoreBreakdown): void {
  if (routeFlowScore > 0.55) {
    addLayerScore(scores, "renderer", 0.55);
    addLayerScore(scores, "services", 0.25);
  }
  if (eventFlowScore > 0.55) {
    addLayerScore(scores, "services", 0.35);
    addLayerScore(scores, "main", 0.3);
  }
}

function applyClusterPrior(clusterId: string, scores: OwnershipScoreBreakdown): void {
  const layers: LayerId[] = ["renderer", "services", "main", "tauri"];
  const index = stableHash(clusterId) % layers.length;
  const preferredLayer = layers[index];
  if (!preferredLayer) {
    return;
  }
  addLayerScore(scores, preferredLayer, 0.28);
}

function applyTransportSplit(
  domainKind: DomainKind,
  symbolKey: string,
  scores: OwnershipScoreBreakdown,
): void {
  if (domainKind !== "transport") {
    return;
  }
  const transportLayer = stableHash(symbolKey) % 2 === 0 ? "main" : "tauri";
  addLayerScore(scores, transportLayer, 0.35);
}

function applyFileHintScores(fileHints: string[], scores: OwnershipScoreBreakdown): void {
  for (const hint of fileHints) {
    const lower = hint.toLowerCase();
    if (lower.includes("renderer") || lower.includes("webview") || lower.includes("react")) {
      addLayerScore(scores, "renderer", 0.02);
    }
    if (lower.includes("main") || lower.includes("node:")) {
      addLayerScore(scores, "main", 0.02);
    }
    if (lower.includes("service") || lower.includes("workspace") || lower.includes("session")) {
      addLayerScore(scores, "services", 0.02);
    }
    if (lower.includes("tauri") || lower.includes("invoke")) {
      addLayerScore(scores, "tauri", 0.02);
    }
  }
}

function scoreForLayer(scores: OwnershipScoreBreakdown, layer: LayerId): number {
  if (layer === "main") {
    return scores.main;
  }
  if (layer === "renderer") {
    return scores.renderer;
  }
  if (layer === "services") {
    return scores.services;
  }
  return scores.tauri;
}

function pickLayerForArchetype(scores: OwnershipScoreBreakdown, archetype: ArchetypeId): { layer: LayerId; confidence: number } {
  const allowedLayers = ARCHETYPE_LAYER_COMPATIBILITY[archetype];
  if (!allowedLayers || allowedLayers.length === 0) {
    throw new Error(`ownership-model: no layer compatibility for archetype ${archetype}`);
  }

  const candidates = allowedLayers
    .map((layer) => ({ layer, score: scoreForLayer(scores, layer) }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return LAYER_TIE_BREAK_ORDER.indexOf(left.layer) - LAYER_TIE_BREAK_ORDER.indexOf(right.layer);
    });

  const best = candidates[0];
  const second = candidates[1];
  if (!best) {
    throw new Error(`ownership-model: no candidate layer for archetype ${archetype}`);
  }

  const total = candidates.reduce((sum, entry) => sum + entry.score, 0.0001);
  const normalized = best.score / total;
  const spread = second ? Math.max(0, best.score - second.score) : best.score;
  return {
    layer: best.layer,
    confidence: clamp(normalized * 0.72 + Math.min(1, spread / 1.8) * 0.28),
  };
}

function mapDomainToArchetype(domainKind: DomainKind): ArchetypeId {
  if (domainKind === "hook") {
    return "hook";
  }
  if (domainKind === "ui") {
    return "ui";
  }
  if (domainKind === "transport") {
    return "transport";
  }
  if (domainKind === "store") {
    return "store";
  }
  return "service";
}

function selectChunkHint(symbolKey: string, symbolName: string): string {
  const tail = symbolKey.split(":").pop();
  if (tail && tail.length > 0 && !isGenericName(tail)) {
    return tail;
  }
  if (!isGenericName(symbolName)) {
    return symbolName;
  }
  return "domainSymbol";
}

export function buildOwnershipModel(semanticIr: SemanticIrModel): OwnershipModel {
  if (semanticIr.domainDeclarations.length === 0) {
    throw new Error("ownership-model: semantic-ir has no domain declarations");
  }

  const declarationBySymbol = new Map<string, (typeof semanticIr.domainDeclarations)[number]>();
  for (const declaration of semanticIr.domainDeclarations) {
    if (declarationBySymbol.has(declaration.symbolKey)) {
      throw new Error(`ownership-model: duplicate declaration for ${declaration.symbolKey}`);
    }
    declarationBySymbol.set(declaration.symbolKey, declaration);
  }

  const fileHints = semanticIr.fileHints.map((hint) => hint.pathHint);
  const symbols: OwnershipRecord[] = [...semanticIr.symbols]
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))
    .map((symbol) => {
      const declaration = declarationBySymbol.get(symbol.symbolKey);
      if (!declaration) {
        throw new Error(`ownership-model: declaration missing for ${symbol.symbolKey}`);
      }
      const scores = emptyScores();
      applyDomainScores(declaration.domainKind, scores);
      applyNameScores(symbol.name, scores);
      applyFlowScores(declaration.routeFlowScore, declaration.eventFlowScore, scores);
      applyClusterPrior(declaration.clusterId, scores);
      applyTransportSplit(declaration.domainKind, symbol.symbolKey, scores);
      applyFileHintScores(fileHints, scores);
      const archetype = mapDomainToArchetype(declaration.domainKind);
      const layerDecision = pickLayerForArchetype(scores, archetype);
      const finalConfidence = clamp(symbol.confidence * 0.7 + layerDecision.confidence * 0.3);
      const ownershipRecord: OwnershipRecord = {
        symbolKey: symbol.symbolKey,
        symbolName: symbol.name,
        layer: layerDecision.layer,
        archetype,
        domainKind: declaration.domainKind,
        declarationClusterId: declaration.clusterId,
        confidence: finalConfidence,
        ownerLineageId: symbol.owner,
        chunkHint: selectChunkHint(symbol.symbolKey, symbol.name),
        scores,
      };
      assertArchetypeLayerCompatibility(ownershipRecord.layer, ownershipRecord.archetype, ownershipRecord.symbolKey);
      return ownershipRecord;
    });

  const seenSymbolKeys = new Set<string>();
  for (const symbol of symbols) {
    if (seenSymbolKeys.has(symbol.symbolKey)) {
      throw new Error(`ownership-model: duplicate ownership record for ${symbol.symbolKey}`);
    }
    seenSymbolKeys.add(symbol.symbolKey);
  }

  return {
    version: 2,
    generatedAtIso: new Date().toISOString(),
    symbols,
  };
}
