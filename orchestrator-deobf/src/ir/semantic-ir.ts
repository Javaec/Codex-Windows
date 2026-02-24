import { createHash } from "node:crypto";
import { ToolWeights } from "../contracts";
import { EvidenceRecord, EvidenceStoreModel } from "./evidence-store";
import { isGenericName, scoreNameQuality } from "./name-quality";

export type DomainKind = "service" | "use-case" | "store" | "hook" | "transport" | "ui";
export type DomainArchetype = "hook" | "service" | "ui" | "transport" | "store";

export interface SemanticFileHint {
  pathHint: string;
  confidence: number;
  evidenceIds: string[];
  provenance: string[];
}

export interface SemanticSymbol {
  symbolKey: string;
  owner: string;
  name: string;
  confidence: number;
  quality: number;
  alternatives: string[];
  evidenceIds: string[];
  provenance: string[];
  domainKind: DomainKind;
  preferredArchetype: DomainArchetype;
  declarationClusterId: string;
  routeFlowScore: number;
  eventFlowScore: number;
}

export interface SemanticCallEdge {
  edge: string;
  caller: string;
  callee: string;
  confidence: number;
  evidenceIds: string[];
  provenance: string[];
  owners: string[];
}

export interface SemanticStateKey {
  key: string;
  confidence: number;
  evidenceIds: string[];
  provenance: string[];
  owners: string[];
  tokens: string[];
}

export interface SemanticSourceMapHint {
  sourcePath: string;
  confidence: number;
  evidenceIds: string[];
  provenance: string[];
}

export interface SemanticDomainDeclaration {
  declarationId: string;
  symbolKey: string;
  symbolName: string;
  ownerLineageId: string;
  domainKind: DomainKind;
  preferredArchetype: DomainArchetype;
  clusterId: string;
  callNeighbours: string[];
  stateSignals: string[];
  routeFlowScore: number;
  eventFlowScore: number;
  confidence: number;
}

export interface SemanticDeclarationCluster {
  clusterId: string;
  ownerLineageId: string;
  domainKind: DomainKind;
  preferredArchetype: DomainArchetype;
  symbolKeys: string[];
  callEdgeCount: number;
  stateSignalCount: number;
  routeFlowScore: number;
  eventFlowScore: number;
  cohesionScore: number;
}

export interface SemanticIrModel {
  version: number;
  generatedAtIso: string;
  fileHints: SemanticFileHint[];
  symbols: SemanticSymbol[];
  callEdges: SemanticCallEdge[];
  stateKeys: SemanticStateKey[];
  sourceMaps: SemanticSourceMapHint[];
  domainDeclarations: SemanticDomainDeclaration[];
  declarationClusters: SemanticDeclarationCluster[];
}

interface AggregatedCandidate {
  value: string;
  score: number;
  evidenceIds: Set<string>;
  provenance: Set<string>;
  owners: Set<string>;
}

interface SymbolGraphContext {
  adjacency: Map<string, Set<string>>;
  reverseAdjacency: Map<string, Set<string>>;
}

const ROUTE_SIGNAL_TOKENS = new Set<string>(["route", "router", "path", "screen", "page", "navigate", "url"]);
const EVENT_SIGNAL_TOKENS = new Set<string>([
  "event",
  "events",
  "emit",
  "listener",
  "subscribe",
  "publish",
  "dispatch",
  "channel",
]);

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

function normalizePathHint(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^webpack:\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  return normalized;
}

function toolWeight(tool: string, weights: ToolWeights): number {
  if (tool === "asar") {
    return weights.asar;
  }
  if (tool === "webcrack") {
    return weights.webcrack;
  }
  if (tool === "wakaru") {
    return weights.wakaru;
  }
  if (tool === "javascript-deobfuscator") {
    return weights.javascriptDeobfuscator;
  }
  if (tool === "synchrony") {
    return weights.synchrony;
  }
  if (tool === "unwebpack-sourcemap") {
    return weights.unwebpackSourcemap;
  }
  return 0.5;
}

function aggregateByValue(records: EvidenceRecord[], weights: ToolWeights): Map<string, AggregatedCandidate> {
  const sink = new Map<string, AggregatedCandidate>();
  for (const record of records) {
    const increment = record.confidence * toolWeight(record.provenance.tool, weights);
    const existing = sink.get(record.value);
    if (existing) {
      existing.score += increment;
      existing.evidenceIds.add(record.id);
      existing.provenance.add(record.provenance.tool);
      existing.owners.add(record.owner);
      continue;
    }
    sink.set(record.value, {
      value: record.value,
      score: increment,
      evidenceIds: new Set<string>([record.id]),
      provenance: new Set<string>([record.provenance.tool]),
      owners: new Set<string>([record.owner]),
    });
  }
  return sink;
}

function aggregateCollections(records: EvidenceRecord[], weights: ToolWeights): AggregatedCandidate[] {
  const aggregated = aggregateByValue(records, weights);
  return [...aggregated.values()].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.value.localeCompare(right.value);
  });
}

function tokenizeSignal(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, " ")
    .split(/[.\s_:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const unique = new Set<string>(tokens);
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function containsSignalToken(tokens: string[], dictionary: Set<string>): boolean {
  for (const token of tokens) {
    if (dictionary.has(token)) {
      return true;
    }
  }
  return false;
}

function pickPreferredArchetype(domainKind: DomainKind): DomainArchetype {
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

function mergeSymbolGroup(groupRecords: EvidenceRecord[], weights: ToolWeights): SemanticSymbol {
  const candidates = aggregateCollections(groupRecords, weights).map((candidate) => {
    const quality = scoreNameQuality(candidate.value);
    const genericPenalty = isGenericName(candidate.value) ? 0.55 : 1;
    return {
      ...candidate,
      quality,
      weightedScore: candidate.score * quality * genericPenalty,
    };
  });

  candidates.sort((left, right) => {
    if (left.weightedScore !== right.weightedScore) {
      return right.weightedScore - left.weightedScore;
    }
    if (left.quality !== right.quality) {
      return right.quality - left.quality;
    }
    return left.value.localeCompare(right.value);
  });

  const winner = candidates[0];
  if (!winner) {
    throw new Error("mergeSymbolGroup: no symbol candidates");
  }
  const firstRecord = groupRecords[0];
  if (!firstRecord) {
    throw new Error("mergeSymbolGroup: empty record group");
  }
  return {
    symbolKey: `${firstRecord.owner}:${firstRecord.anchor}`,
    owner: firstRecord.owner,
    name: winner.value,
    confidence: clamp(winner.weightedScore),
    quality: winner.quality,
    alternatives: candidates.slice(1, 5).map((candidate) => candidate.value),
    evidenceIds: [...winner.evidenceIds].sort((left, right) => left.localeCompare(right)),
    provenance: [...winner.provenance].sort((left, right) => left.localeCompare(right)),
    domainKind: "use-case",
    preferredArchetype: "service",
    declarationClusterId: "cluster-unassigned",
    routeFlowScore: 0,
    eventFlowScore: 0,
  };
}

function buildSymbolGroups(records: EvidenceRecord[]): Map<string, EvidenceRecord[]> {
  const groups = new Map<string, EvidenceRecord[]>();
  for (const record of records) {
    if (record.kind !== "symbol_hint") {
      continue;
    }
    const key = `${record.owner}::${record.anchor}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
      continue;
    }
    groups.set(key, [record]);
  }
  return groups;
}

function buildOwnerNameIndex(symbols: SemanticSymbol[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const symbol of symbols) {
    const key = `${symbol.owner}::${symbol.name.toLowerCase()}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(symbol.symbolKey);
      continue;
    }
    index.set(key, [symbol.symbolKey]);
  }
  for (const [key, value] of index.entries()) {
    index.set(
      key,
      [...value].sort((left, right) => left.localeCompare(right)),
    );
  }
  return index;
}

function buildGlobalNameIndex(symbols: SemanticSymbol[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const existing = index.get(key);
    if (existing) {
      existing.push(symbol.symbolKey);
      continue;
    }
    index.set(key, [symbol.symbolKey]);
  }
  for (const [key, value] of index.entries()) {
    index.set(
      key,
      [...value].sort((left, right) => left.localeCompare(right)),
    );
  }
  return index;
}

function addDirectedEdge(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  if (from === to) {
    return;
  }
  const existing = adjacency.get(from);
  if (existing) {
    existing.add(to);
    return;
  }
  adjacency.set(from, new Set<string>([to]));
}

function buildSymbolGraph(symbols: SemanticSymbol[], callEdges: SemanticCallEdge[]): SymbolGraphContext {
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();
  const ownerNameIndex = buildOwnerNameIndex(symbols);
  const globalNameIndex = buildGlobalNameIndex(symbols);

  for (const edge of callEdges) {
    const callerName = edge.caller.toLowerCase();
    const calleeName = edge.callee.toLowerCase();
    let connected = false;
    for (const owner of edge.owners) {
      const callers = ownerNameIndex.get(`${owner}::${callerName}`) ?? [];
      const callees = ownerNameIndex.get(`${owner}::${calleeName}`) ?? [];
      for (const caller of callers) {
        for (const callee of callees) {
          addDirectedEdge(adjacency, caller, callee);
          addDirectedEdge(reverseAdjacency, callee, caller);
          connected = true;
        }
      }
    }
    if (connected) {
      continue;
    }
    const globalCallers = globalNameIndex.get(callerName) ?? [];
    const globalCallees = globalNameIndex.get(calleeName) ?? [];
    if (globalCallers.length === 1 && globalCallees.length === 1) {
      const caller = globalCallers[0];
      const callee = globalCallees[0];
      if (caller && callee) {
        addDirectedEdge(adjacency, caller, callee);
        addDirectedEdge(reverseAdjacency, callee, caller);
      }
    }
  }
  return {
    adjacency,
    reverseAdjacency,
  };
}

function buildOwnerStateSignals(stateKeys: SemanticStateKey[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const stateKey of stateKeys) {
    for (const owner of stateKey.owners) {
      const existing = map.get(owner) ?? new Set<string>();
      for (const token of stateKey.tokens) {
        existing.add(token);
      }
      map.set(owner, existing);
    }
  }
  return map;
}

function scoreRouteFlow(symbolName: string, neighbourNames: string[], ownerStateSignals: string[]): number {
  const symbolTokens = tokenizeSignal(symbolName);
  const routeByName = containsSignalToken(symbolTokens, ROUTE_SIGNAL_TOKENS) ? 1 : 0;
  const routeNeighbours = neighbourNames.map((name) => tokenizeSignal(name));
  const routeByCalls =
    routeNeighbours.length === 0
      ? 0
      : routeNeighbours.filter((tokens) => containsSignalToken(tokens, ROUTE_SIGNAL_TOKENS)).length / routeNeighbours.length;
  const routeByState = ownerStateSignals.some((token) => ROUTE_SIGNAL_TOKENS.has(token)) ? 1 : 0;
  return clamp(routeByName * 0.4 + routeByCalls * 0.35 + routeByState * 0.25);
}

function scoreEventFlow(symbolName: string, neighbourNames: string[], ownerStateSignals: string[]): number {
  const symbolTokens = tokenizeSignal(symbolName);
  const eventByName = containsSignalToken(symbolTokens, EVENT_SIGNAL_TOKENS) ? 1 : 0;
  const eventNeighbours = neighbourNames.map((name) => tokenizeSignal(name));
  const eventByCalls =
    eventNeighbours.length === 0
      ? 0
      : eventNeighbours.filter((tokens) => containsSignalToken(tokens, EVENT_SIGNAL_TOKENS)).length / eventNeighbours.length;
  const eventByState = ownerStateSignals.some((token) => EVENT_SIGNAL_TOKENS.has(token)) ? 1 : 0;
  return clamp(eventByName * 0.4 + eventByCalls * 0.3 + eventByState * 0.3);
}

function inferDomainKind(
  symbolKey: string,
  symbolName: string,
  stateSignalCount: number,
  routeFlowScore: number,
  eventFlowScore: number,
  outDegree: number,
  inDegree: number,
): DomainKind {
  const lower = symbolName.toLowerCase();
  const genericSymbol = isGenericName(symbolName) || lower.length <= 4;
  if (lower.startsWith("use")) {
    return "hook";
  }
  if (lower.includes("store") || lower.includes("state") || lower.includes("cache") || lower.includes("reducer")) {
    return "store";
  }
  if (
    lower.includes("ipc") ||
    lower.includes("rpc") ||
    lower.includes("socket") ||
    lower.includes("channel") ||
    lower.includes("bridge") ||
    lower.includes("transport") ||
    lower.includes("invoke")
  ) {
    return "transport";
  }
  if (
    lower.includes("component") ||
    lower.includes("view") ||
    lower.includes("render") ||
    lower.includes("panel") ||
    lower.includes("dialog") ||
    lower.includes("page")
  ) {
    return "ui";
  }
  if (
    lower.includes("service") ||
    lower.includes("provider") ||
    lower.includes("manager") ||
    lower.includes("repository") ||
    lower.includes("client")
  ) {
    return "service";
  }
  if (
    lower.includes("action") ||
    lower.includes("command") ||
    lower.includes("workflow") ||
    lower.includes("handler") ||
    lower.includes("orchestr")
  ) {
    return "use-case";
  }
  if (routeFlowScore > 0.55 && eventFlowScore > 0.4) {
    return "use-case";
  }
  if (eventFlowScore > 0.62 || outDegree + inDegree > 4) {
    return "service";
  }
  if (genericSymbol) {
    if (routeFlowScore > 0.5) {
      return "ui";
    }
    if (eventFlowScore > 0.5) {
      return "transport";
    }
    if (stateSignalCount > 0 && outDegree <= 2) {
      return "store";
    }
    const candidates: DomainKind[] = ["service", "use-case", "store", "transport", "ui", "hook"];
    const hashed = stableHash(`${symbolKey}|${stateSignalCount}|${outDegree}|${inDegree}`);
    return candidates[hashed % candidates.length] ?? "use-case";
  }
  return "use-case";
}

function pickStateSignalsForSymbol(symbolName: string, ownerSignals: Set<string>): string[] {
  const symbolTokens = tokenizeSignal(symbolName);
  const candidates = [...ownerSignals].sort((left, right) => left.localeCompare(right));
  const flowSignals = candidates.filter((token) => ROUTE_SIGNAL_TOKENS.has(token) || EVENT_SIGNAL_TOKENS.has(token));
  if (flowSignals.length > 0) {
    return flowSignals.slice(0, 8);
  }
  const specific = candidates.filter((token) =>
    symbolTokens.some((symbolToken) => token.includes(symbolToken) || symbolToken.includes(token)),
  );
  if (specific.length > 0) {
    return specific.slice(0, 8);
  }
  return candidates.slice(0, 4);
}

function sanitizeOwnerToken(owner: string): string {
  const normalized = owner
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (normalized.length === 0) {
    return "lineage";
  }
  return normalized;
}

function componentId(owner: string, domainKind: DomainKind, symbolKeys: string[]): string {
  const digest = createHash("sha1")
    .update(owner)
    .update("|")
    .update(domainKind)
    .update("|")
    .update(symbolKeys.join("|"))
    .digest("hex")
    .slice(0, 10);
  return `cluster-${sanitizeOwnerToken(owner)}-${domainKind}-${digest}`;
}

function signalOverlap(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  if (intersection === 0) {
    return 0;
  }
  const union = new Set<string>([...leftSet, ...rightSet]).size;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function linkWeight(
  leftKey: string,
  rightKey: string,
  graph: SymbolGraphContext,
  stateSignalsBySymbol: Map<string, string[]>,
  routeFlowBySymbol: Map<string, number>,
  eventFlowBySymbol: Map<string, number>,
): number {
  let weight = 0;
  if (graph.adjacency.get(leftKey)?.has(rightKey) || graph.adjacency.get(rightKey)?.has(leftKey)) {
    weight += 0.7;
  }
  const leftSignals = stateSignalsBySymbol.get(leftKey) ?? [];
  const rightSignals = stateSignalsBySymbol.get(rightKey) ?? [];
  const overlap = signalOverlap(leftSignals, rightSignals);
  weight += overlap * 0.25;

  const leftRoute = routeFlowBySymbol.get(leftKey) ?? 0;
  const rightRoute = routeFlowBySymbol.get(rightKey) ?? 0;
  if (leftRoute > 0.45 && rightRoute > 0.45 && Math.abs(leftRoute - rightRoute) < 0.28) {
    weight += 0.1;
  }

  const leftEvent = eventFlowBySymbol.get(leftKey) ?? 0;
  const rightEvent = eventFlowBySymbol.get(rightKey) ?? 0;
  if (leftEvent > 0.45 && rightEvent > 0.45 && Math.abs(leftEvent - rightEvent) < 0.28) {
    weight += 0.1;
  }
  return weight;
}

function buildDeclarationClusters(
  declarations: Array<Omit<SemanticDomainDeclaration, "clusterId">>,
  graph: SymbolGraphContext,
): {
  clusters: SemanticDeclarationCluster[];
  declarationClusterMap: Map<string, string>;
} {
  const byOwnerAndDomain = new Map<string, Array<Omit<SemanticDomainDeclaration, "clusterId">>>();
  for (const declaration of declarations) {
    const key = `${declaration.ownerLineageId}::${declaration.domainKind}`;
    const existing = byOwnerAndDomain.get(key);
    if (existing) {
      existing.push(declaration);
      continue;
    }
    byOwnerAndDomain.set(key, [declaration]);
  }

  const stateSignalsBySymbol = new Map<string, string[]>();
  const routeFlowBySymbol = new Map<string, number>();
  const eventFlowBySymbol = new Map<string, number>();
  for (const declaration of declarations) {
    stateSignalsBySymbol.set(declaration.symbolKey, declaration.stateSignals);
    routeFlowBySymbol.set(declaration.symbolKey, declaration.routeFlowScore);
    eventFlowBySymbol.set(declaration.symbolKey, declaration.eventFlowScore);
  }

  const clusters: SemanticDeclarationCluster[] = [];
  const declarationClusterMap = new Map<string, string>();

  const groupedKeys = [...byOwnerAndDomain.keys()].sort((left, right) => left.localeCompare(right));
  for (const groupedKey of groupedKeys) {
    const group = byOwnerAndDomain.get(groupedKey);
    if (!group) {
      continue;
    }
    const [ownerLineageId, domainKindRaw] = groupedKey.split("::");
    const domainKind = domainKindRaw as DomainKind;
    const symbolKeys = group.map((entry) => entry.symbolKey).sort((left, right) => left.localeCompare(right));
    const visited = new Set<string>();
    const rawComponents: string[][] = [];

    for (const start of symbolKeys) {
      if (visited.has(start)) {
        continue;
      }
      const queue: string[] = [start];
      const component = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current)) {
          continue;
        }
        visited.add(current);
        component.add(current);
        for (const candidate of symbolKeys) {
          if (candidate === current || visited.has(candidate)) {
            continue;
          }
          const weight = linkWeight(
            current,
            candidate,
            graph,
            stateSignalsBySymbol,
            routeFlowBySymbol,
            eventFlowBySymbol,
          );
          if (weight >= 0.35) {
            queue.push(candidate);
          }
        }
      }
      rawComponents.push([...component].sort((left, right) => left.localeCompare(right)));
    }

    const finalComponents: string[][] = [];
    const fallbackBuckets = new Map<string, string[]>();
    for (const componentKeys of rawComponents) {
      if (componentKeys.length > 1) {
        finalComponents.push(componentKeys);
        continue;
      }
      const symbolKey = componentKeys[0];
      if (!symbolKey) {
        continue;
      }
      const routeBucket = Math.min(3, Math.floor((routeFlowBySymbol.get(symbolKey) ?? 0) * 4));
      const eventBucket = Math.min(3, Math.floor((eventFlowBySymbol.get(symbolKey) ?? 0) * 4));
      const stateBucket = (stateSignalsBySymbol.get(symbolKey) ?? []).length > 0 ? "state" : "no-state";
      const bucketKey = `${stateBucket}:${routeBucket}:${eventBucket}`;
      const existing = fallbackBuckets.get(bucketKey);
      if (existing) {
        existing.push(symbolKey);
        continue;
      }
      fallbackBuckets.set(bucketKey, [symbolKey]);
    }

    const fallbackKeys = [...fallbackBuckets.keys()].sort((left, right) => left.localeCompare(right));
    for (const fallbackKey of fallbackKeys) {
      const symbolsInBucket = fallbackBuckets.get(fallbackKey) ?? [];
      const ordered = [...symbolsInBucket].sort((left, right) => left.localeCompare(right));
      for (let offset = 0; offset < ordered.length; offset += 6) {
        finalComponents.push(ordered.slice(offset, offset + 6));
      }
    }

    for (const componentKeys of finalComponents) {
      const clusterId = componentId(ownerLineageId ?? "lineage", domainKind, componentKeys);
      const callEdgeCount = componentKeys.reduce((total, symbolKey) => {
        const outgoing = graph.adjacency.get(symbolKey) ?? new Set<string>();
        const internal = [...outgoing].filter((target) => componentKeys.includes(target)).length;
        return total + internal;
      }, 0);
      const stateSignals = new Set<string>();
      let routeFlowTotal = 0;
      let eventFlowTotal = 0;
      for (const symbolKey of componentKeys) {
        for (const signal of stateSignalsBySymbol.get(symbolKey) ?? []) {
          stateSignals.add(signal);
        }
        routeFlowTotal += routeFlowBySymbol.get(symbolKey) ?? 0;
        eventFlowTotal += eventFlowBySymbol.get(symbolKey) ?? 0;
        declarationClusterMap.set(symbolKey, clusterId);
      }
      const routeFlowScore = componentKeys.length === 0 ? 0 : clamp(routeFlowTotal / componentKeys.length);
      const eventFlowScore = componentKeys.length === 0 ? 0 : clamp(eventFlowTotal / componentKeys.length);
      const density =
        componentKeys.length <= 1 ? 1 : clamp(callEdgeCount / (componentKeys.length * (componentKeys.length - 1)));
      const cohesionScore = clamp(density * 0.65 + (stateSignals.size > 0 ? 0.2 : 0) + routeFlowScore * 0.075 + eventFlowScore * 0.075);

      clusters.push({
        clusterId,
        ownerLineageId: ownerLineageId ?? "lineage",
        domainKind,
        preferredArchetype: pickPreferredArchetype(domainKind),
        symbolKeys: componentKeys,
        callEdgeCount,
        stateSignalCount: stateSignals.size,
        routeFlowScore,
        eventFlowScore,
        cohesionScore,
      });
    }
  }

  return {
    clusters: clusters.sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
    declarationClusterMap,
  };
}

export function buildSemanticIr(evidenceStore: EvidenceStoreModel, weights: ToolWeights): SemanticIrModel {
  const fileHints = aggregateCollections(
    evidenceStore.records
      .filter((record) => record.kind === "file_hint")
      .map((record) => ({ ...record, value: normalizePathHint(record.value) })),
    weights,
  ).map((candidate) => ({
    pathHint: candidate.value,
    confidence: clamp(candidate.score),
    evidenceIds: [...candidate.evidenceIds].sort((left, right) => left.localeCompare(right)),
    provenance: [...candidate.provenance].sort((left, right) => left.localeCompare(right)),
  }));

  const symbolGroups = buildSymbolGroups(evidenceStore.records);
  const baseSymbols = [...symbolGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, records]) => mergeSymbolGroup(records, weights));

  const callEdges = aggregateCollections(
    evidenceStore.records.filter((record) => record.kind === "call_edge"),
    weights,
  ).map((candidate) => {
    const [caller, callee] = candidate.value.split("->");
    return {
      edge: candidate.value,
      caller: caller ?? "unknownCaller",
      callee: callee ?? "unknownCallee",
      confidence: clamp(candidate.score),
      evidenceIds: [...candidate.evidenceIds].sort((left, right) => left.localeCompare(right)),
      provenance: [...candidate.provenance].sort((left, right) => left.localeCompare(right)),
      owners: [...candidate.owners].sort((left, right) => left.localeCompare(right)),
    };
  });

  const stateKeys = aggregateCollections(
    evidenceStore.records.filter((record) => record.kind === "state_key"),
    weights,
  ).map((candidate) => ({
    key: candidate.value,
    confidence: clamp(candidate.score),
    evidenceIds: [...candidate.evidenceIds].sort((left, right) => left.localeCompare(right)),
    provenance: [...candidate.provenance].sort((left, right) => left.localeCompare(right)),
    owners: [...candidate.owners].sort((left, right) => left.localeCompare(right)),
    tokens: tokenizeSignal(candidate.value),
  }));

  const sourceMaps = aggregateCollections(
    evidenceStore.records
      .filter((record) => record.kind === "source_map")
      .map((record) => ({ ...record, value: normalizePathHint(record.value) })),
    weights,
  ).map((candidate) => ({
    sourcePath: candidate.value,
    confidence: clamp(candidate.score),
    evidenceIds: [...candidate.evidenceIds].sort((left, right) => left.localeCompare(right)),
    provenance: [...candidate.provenance].sort((left, right) => left.localeCompare(right)),
  }));

  const symbolByKey = new Map<string, SemanticSymbol>();
  for (const symbol of baseSymbols) {
    symbolByKey.set(symbol.symbolKey, symbol);
  }

  const symbolGraph = buildSymbolGraph(baseSymbols, callEdges);
  const ownerStateSignals = buildOwnerStateSignals(stateKeys);

  const declarationsBase: Array<Omit<SemanticDomainDeclaration, "clusterId">> = [];
  const enrichedSymbols = [...baseSymbols]
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))
    .map((symbol) => {
      const neighbours = [...(symbolGraph.adjacency.get(symbol.symbolKey) ?? new Set<string>())]
        .map((symbolKey) => symbolByKey.get(symbolKey)?.name ?? "unknownSymbol")
        .sort((left, right) => left.localeCompare(right));
      const ownerSignals = ownerStateSignals.get(symbol.owner) ?? new Set<string>();
      const pickedStateSignals = pickStateSignalsForSymbol(symbol.name, ownerSignals);
      const routeFlowScore = scoreRouteFlow(symbol.name, neighbours, pickedStateSignals);
      const eventFlowScore = scoreEventFlow(symbol.name, neighbours, pickedStateSignals);
      const outDegree = symbolGraph.adjacency.get(symbol.symbolKey)?.size ?? 0;
      const inDegree = symbolGraph.reverseAdjacency.get(symbol.symbolKey)?.size ?? 0;
      const domainKind = inferDomainKind(
        symbol.symbolKey,
        symbol.name,
        pickedStateSignals.length,
        routeFlowScore,
        eventFlowScore,
        outDegree,
        inDegree,
      );
      const preferredArchetype = pickPreferredArchetype(domainKind);
      declarationsBase.push({
        declarationId: `${symbol.symbolKey}::${domainKind}`,
        symbolKey: symbol.symbolKey,
        symbolName: symbol.name,
        ownerLineageId: symbol.owner,
        domainKind,
        preferredArchetype,
        callNeighbours: neighbours.slice(0, 12),
        stateSignals: pickedStateSignals,
        routeFlowScore,
        eventFlowScore,
        confidence: clamp(symbol.confidence * 0.7 + Math.max(routeFlowScore, eventFlowScore) * 0.3),
      });
      return {
        ...symbol,
        domainKind,
        preferredArchetype,
        routeFlowScore,
        eventFlowScore,
      };
    });

  const { clusters, declarationClusterMap } = buildDeclarationClusters(declarationsBase, symbolGraph);

  const domainDeclarations = declarationsBase
    .map((declaration) => {
      const clusterId = declarationClusterMap.get(declaration.symbolKey);
      if (!clusterId) {
        throw new Error(`Missing declaration cluster for symbol ${declaration.symbolKey}`);
      }
      return {
        ...declaration,
        clusterId,
      };
    })
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  const symbols = enrichedSymbols
    .map((symbol) => {
      const declarationClusterId = declarationClusterMap.get(symbol.symbolKey);
      if (!declarationClusterId) {
        throw new Error(`Missing symbol cluster for ${symbol.symbolKey}`);
      }
      return {
        ...symbol,
        declarationClusterId,
      };
    })
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  return {
    version: 2,
    generatedAtIso: new Date().toISOString(),
    fileHints,
    symbols,
    callEdges,
    stateKeys,
    sourceMaps,
    domainDeclarations,
    declarationClusters: clusters,
  };
}
