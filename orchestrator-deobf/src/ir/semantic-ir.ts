import { createHash } from "node:crypto";
import { ToolWeights } from "../contracts";
import { EvidenceRecord, EvidenceStoreModel } from "./evidence-store";
import { isGenericName, isIdentifierName, scoreNameQuality } from "./name-quality";
import { ObfuscationProfileDescriptor } from "./obfuscation-profile";

export type DomainKind = "service" | "usecase" | "store" | "hook" | "transport" | "ui";
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

export interface SemanticDomainEntity {
  entityId: string;
  clusterId: string;
  ownerLineageId: string;
  kind: DomainKind;
  preferredArchetype: DomainArchetype;
  symbolKeys: string[];
  exportSymbols: string[];
  importEntityIds: string[];
  confidence: number;
}

export type SemanticProvenanceNodeType = "symbol" | "evidence" | "tool" | "ownership";
export type SemanticProvenanceEdgeType = "named_by" | "provided_by" | "supports_ownership";

export interface SemanticSymbolProvenanceNode {
  nodeId: string;
  nodeType: SemanticProvenanceNodeType;
  label: string;
  confidence: number;
}

export interface SemanticSymbolProvenanceEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: SemanticProvenanceEdgeType;
  confidence: number;
  evidenceIds: string[];
}

export interface SemanticSymbolProvenanceGraph {
  nodes: SemanticSymbolProvenanceNode[];
  edges: SemanticSymbolProvenanceEdge[];
}

export type SemanticExportContractNodeType = "module" | "symbol";
export type SemanticExportContractEdgeType = "exports" | "imports";

export interface SemanticExportContractNode {
  nodeId: string;
  nodeType: SemanticExportContractNodeType;
  label: string;
  ownerLineageId: string;
  layerHint: string;
  archetype: DomainArchetype;
  symbolKey: string;
}

export interface SemanticExportContractEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: SemanticExportContractEdgeType;
  confidence: number;
  evidenceIds: string[];
}

export interface SemanticExportContractGraph {
  nodes: SemanticExportContractNode[];
  edges: SemanticExportContractEdge[];
}

export type SemanticSymbolRole = "orchestrator" | "parser" | "store" | "transport" | "ui";
export type SemanticApiShape =
  | "sync-function"
  | "async-function"
  | "class-constructor"
  | "state-accessor"
  | "event-handler"
  | "factory";
export type SemanticMutationProfile = "pure" | "local-mutation" | "state-mutation" | "io-mutation";

export interface SemanticIoSignature {
  symbolKey: string;
  parameterCount: number;
  parameterHints: string[];
  returnHint: string;
  apiShape: SemanticApiShape;
}

export interface SemanticSideEffects {
  symbolKey: string;
  mutatesState: boolean;
  emitsEvents: boolean;
  performsIo: boolean;
  touchesUi: boolean;
  invokesTransport: boolean;
  tags: string[];
}

export interface SemanticCallGraphNeighborhood {
  symbolKey: string;
  incomingCount: number;
  outgoingCount: number;
  neighbourKeys: string[];
  neighbourNames: string[];
}

export interface SemanticDeclarationFingerprint {
  symbolKey: string;
  symbolName: string;
  role: SemanticSymbolRole;
  roleSignalScores: Record<SemanticSymbolRole, number>;
  roleConsensusSignals: string[];
  ioSignature: SemanticIoSignature;
  sideEffects: SemanticSideEffects;
  stateKeys: string[];
  callGraphNeighborhood: SemanticCallGraphNeighborhood;
  mutationProfile: SemanticMutationProfile;
  confidence: number;
  evidenceIds: string[];
}

export type SemanticRoleGraphNodeType = "symbol" | "role";

export interface SemanticRoleGraphNode {
  nodeId: string;
  nodeType: SemanticRoleGraphNodeType;
  label: string;
  confidence: number;
}

export interface SemanticRoleGraphEdge {
  fromNodeId: string;
  toNodeId: string;
  role: SemanticSymbolRole;
  confidence: number;
  signals: string[];
}

export interface SemanticRoleResolution {
  symbolKey: string;
  resolvedRole: SemanticSymbolRole;
  consensusScore: number;
  signalScores: Record<SemanticSymbolRole, number>;
  consensusSignals: string[];
}

export interface SemanticSymbolRoleGraph {
  nodes: SemanticRoleGraphNode[];
  edges: SemanticRoleGraphEdge[];
  resolutions: SemanticRoleResolution[];
}

export interface SemanticEvidenceLedgerCandidate {
  name: string;
  score: number;
  quality: number;
  supportCount: number;
  evidenceIds: string[];
  provenance: string[];
  conflictPenalty: number;
}

export interface SemanticEvidenceLedgerEntry {
  symbolKey: string;
  winnerName: string;
  winnerScore: number;
  conflictResolvedBy: string;
  candidates: SemanticEvidenceLedgerCandidate[];
}

export interface SemanticEvidenceLedger {
  entries: SemanticEvidenceLedgerEntry[];
}

export interface SemanticIrCoreModel {
  fileHints: SemanticFileHint[];
  symbols: SemanticSymbol[];
  callEdges: SemanticCallEdge[];
  stateKeys: SemanticStateKey[];
  sourceMaps: SemanticSourceMapHint[];
  domainDeclarations: SemanticDomainDeclaration[];
  declarationClusters: SemanticDeclarationCluster[];
}

export interface SemanticIrModel {
  version: number;
  generatedAtIso: string;
  obfuscationProfile: ObfuscationProfileDescriptor;
  fileHints: SemanticFileHint[];
  symbols: SemanticSymbol[];
  callEdges: SemanticCallEdge[];
  stateKeys: SemanticStateKey[];
  sourceMaps: SemanticSourceMapHint[];
  domainDeclarations: SemanticDomainDeclaration[];
  declarationClusters: SemanticDeclarationCluster[];
  domainEntities: SemanticDomainEntity[];
  symbolProvenanceGraph: SemanticSymbolProvenanceGraph;
  exportContractGraph: SemanticExportContractGraph;
  declarationFingerprints: SemanticDeclarationFingerprint[];
  symbolRoleGraph: SemanticSymbolRoleGraph;
  evidenceLedger: SemanticEvidenceLedger;
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

interface ResolvedCallEdge {
  callerKey: string;
  calleeKey: string;
  confidence: number;
  evidenceIds: string[];
}

interface ParsedIoSignatureHint {
  parameterCount: number;
  parameterHints: string[];
  returnHint: string;
  signature: string;
  confidence: number;
  evidenceId: string;
}

interface RoleConsensusResult {
  resolvedRole: SemanticSymbolRole;
  signalScores: Record<SemanticSymbolRole, number>;
  consensusScore: number;
  consensusSignals: string[];
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
const PARSER_SIGNAL_TOKENS = new Set<string>([
  "parse",
  "decode",
  "encode",
  "serialize",
  "deserialize",
  "tokenize",
  "scan",
]);
const STORE_SIGNAL_TOKENS = new Set<string>(["state", "store", "cache", "session", "snapshot", "persist"]);
const TRANSPORT_SIGNAL_TOKENS = new Set<string>([
  "ipc",
  "rpc",
  "transport",
  "channel",
  "bridge",
  "socket",
  "invoke",
]);
const UI_SIGNAL_TOKENS = new Set<string>([
  "ui",
  "view",
  "render",
  "component",
  "screen",
  "dialog",
  "layout",
]);
const ORCHESTRATOR_SIGNAL_TOKENS = new Set<string>([
  "orchestrate",
  "bootstrap",
  "initialize",
  "handle",
  "dispatch",
  "process",
  "run",
  "execute",
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
    domainKind: "usecase",
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

function resolveCallEdgesToSymbolKeys(symbols: SemanticSymbol[], callEdges: SemanticCallEdge[]): ResolvedCallEdge[] {
  const ownerNameIndex = buildOwnerNameIndex(symbols);
  const globalNameIndex = buildGlobalNameIndex(symbols);
  const merged = new Map<string, ResolvedCallEdge>();

  for (const edge of callEdges) {
    const callerName = edge.caller.toLowerCase();
    const calleeName = edge.callee.toLowerCase();
    const directPairs: Array<{ callerKey: string; calleeKey: string }> = [];

    for (const owner of edge.owners) {
      const callers = ownerNameIndex.get(`${owner}::${callerName}`) ?? [];
      const callees = ownerNameIndex.get(`${owner}::${calleeName}`) ?? [];
      for (const callerKey of callers) {
        for (const calleeKey of callees) {
          directPairs.push({ callerKey, calleeKey });
        }
      }
    }

    if (directPairs.length === 0) {
      const globalCallers = globalNameIndex.get(callerName) ?? [];
      const globalCallees = globalNameIndex.get(calleeName) ?? [];
      if (globalCallers.length === 1 && globalCallees.length === 1) {
        const callerKey = globalCallers[0];
        const calleeKey = globalCallees[0];
        if (callerKey && calleeKey) {
          directPairs.push({ callerKey, calleeKey });
        }
      }
    }

    for (const pair of directPairs) {
      if (pair.callerKey === pair.calleeKey) {
        continue;
      }
      const key = `${pair.callerKey}->${pair.calleeKey}`;
      const existing = merged.get(key);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, edge.confidence);
        existing.evidenceIds = [...new Set<string>([...existing.evidenceIds, ...edge.evidenceIds])].sort((left, right) =>
          left.localeCompare(right),
        );
        continue;
      }
      merged.set(key, {
        callerKey: pair.callerKey,
        calleeKey: pair.calleeKey,
        confidence: edge.confidence,
        evidenceIds: [...edge.evidenceIds].sort((left, right) => left.localeCompare(right)),
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (left.callerKey !== right.callerKey) {
      return left.callerKey.localeCompare(right.callerKey);
    }
    return left.calleeKey.localeCompare(right.calleeKey);
  });
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
  const resolvedEdges = resolveCallEdgesToSymbolKeys(symbols, callEdges);
  for (const edge of resolvedEdges) {
    addDirectedEdge(adjacency, edge.callerKey, edge.calleeKey);
    addDirectedEdge(reverseAdjacency, edge.calleeKey, edge.callerKey);
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
    return "usecase";
  }
  if (routeFlowScore > 0.55 && eventFlowScore > 0.4) {
    return "usecase";
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
    const candidates: DomainKind[] = ["service", "usecase", "store", "transport", "ui", "hook"];
    const hashed = stableHash(`${symbolKey}|${stateSignalCount}|${outDegree}|${inDegree}`);
    return candidates[hashed % candidates.length] ?? "usecase";
  }
  return "usecase";
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

function inferLayerHint(domainKind: DomainKind): string {
  if (domainKind === "hook" || domainKind === "ui") {
    return "renderer";
  }
  if (domainKind === "transport") {
    return "main";
  }
  if (domainKind === "store" || domainKind === "service" || domainKind === "usecase") {
    return "services";
  }
  return "services";
}

function buildDomainEntities(core: SemanticIrCoreModel, resolvedCallEdges: ResolvedCallEdge[]): SemanticDomainEntity[] {
  const declarationBySymbol = new Map<string, SemanticDomainDeclaration>();
  for (const declaration of core.domainDeclarations) {
    declarationBySymbol.set(declaration.symbolKey, declaration);
  }
  const symbolByKey = new Map<string, SemanticSymbol>();
  for (const symbol of core.symbols) {
    symbolByKey.set(symbol.symbolKey, symbol);
  }

  const symbolToEntityId = new Map<string, string>();
  for (const cluster of core.declarationClusters) {
    const entityId = `entity:${cluster.clusterId}`;
    for (const symbolKey of cluster.symbolKeys) {
      symbolToEntityId.set(symbolKey, entityId);
    }
  }

  const importEdgesByEntity = new Map<string, Set<string>>();
  for (const edge of resolvedCallEdges) {
    const fromEntity = symbolToEntityId.get(edge.callerKey);
    const toEntity = symbolToEntityId.get(edge.calleeKey);
    if (!fromEntity || !toEntity || fromEntity === toEntity) {
      continue;
    }
    const existing = importEdgesByEntity.get(fromEntity);
    if (existing) {
      existing.add(toEntity);
      continue;
    }
    importEdgesByEntity.set(fromEntity, new Set<string>([toEntity]));
  }

  return [...core.declarationClusters]
    .sort((left, right) => left.clusterId.localeCompare(right.clusterId))
    .map((cluster) => {
      const symbolKeys = [...cluster.symbolKeys].sort((left, right) => left.localeCompare(right));
      const declarations = symbolKeys
        .map((symbolKey) => declarationBySymbol.get(symbolKey))
        .filter((declaration): declaration is SemanticDomainDeclaration => Boolean(declaration));
      const confidenceBase =
        declarations.length === 0
          ? cluster.cohesionScore
          : declarations.reduce((sum, declaration) => sum + declaration.confidence, 0) / declarations.length;
      const exportSymbols = symbolKeys
        .map((symbolKey) => symbolByKey.get(symbolKey)?.name ?? symbolKey)
        .sort((left, right) => left.localeCompare(right));
      const entityId = `entity:${cluster.clusterId}`;
      const importEntityIds = [...(importEdgesByEntity.get(entityId) ?? new Set<string>())].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        entityId,
        clusterId: cluster.clusterId,
        ownerLineageId: cluster.ownerLineageId,
        kind: cluster.domainKind,
        preferredArchetype: cluster.preferredArchetype,
        symbolKeys,
        exportSymbols,
        importEntityIds,
        confidence: clamp(confidenceBase * 0.82 + cluster.cohesionScore * 0.18),
      };
    });
}

function buildSymbolProvenanceGraph(
  core: SemanticIrCoreModel,
  evidenceStore: EvidenceStoreModel,
): SemanticSymbolProvenanceGraph {
  const nodesById = new Map<string, SemanticSymbolProvenanceNode>();
  const edgesById = new Map<string, SemanticSymbolProvenanceEdge>();

  const declarationBySymbol = new Map<string, SemanticDomainDeclaration>();
  for (const declaration of core.domainDeclarations) {
    declarationBySymbol.set(declaration.symbolKey, declaration);
  }
  const recordById = new Map<string, EvidenceRecord>();
  for (const record of evidenceStore.records) {
    recordById.set(record.id, record);
  }

  const ownershipSignalByOwner = new Map<string, EvidenceRecord[]>();
  for (const record of evidenceStore.records) {
    if (record.kind !== "call_edge" && record.kind !== "state_key") {
      continue;
    }
    const existing = ownershipSignalByOwner.get(record.owner);
    if (existing) {
      existing.push(record);
      continue;
    }
    ownershipSignalByOwner.set(record.owner, [record]);
  }
  for (const [owner, records] of ownershipSignalByOwner.entries()) {
    const ordered = [...records]
      .sort((left, right) => {
        if (left.confidence !== right.confidence) {
          return right.confidence - left.confidence;
        }
        return left.id.localeCompare(right.id);
      })
      .slice(0, 16);
    ownershipSignalByOwner.set(owner, ordered);
  }

  const registerNode = (node: SemanticSymbolProvenanceNode): void => {
    const existing = nodesById.get(node.nodeId);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, node.confidence);
      return;
    }
    nodesById.set(node.nodeId, node);
  };

  const registerEdge = (edge: SemanticSymbolProvenanceEdge): void => {
    const key = `${edge.fromNodeId}::${edge.toNodeId}::${edge.edgeType}`;
    const existing = edgesById.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, edge.confidence);
      existing.evidenceIds = [...new Set<string>([...existing.evidenceIds, ...edge.evidenceIds])].sort((left, right) =>
        left.localeCompare(right),
      );
      return;
    }
    edgesById.set(key, edge);
  };

  for (const symbol of core.symbols) {
    const symbolNodeId = `symbol:${symbol.symbolKey}`;
    registerNode({
      nodeId: symbolNodeId,
      nodeType: "symbol",
      label: symbol.name,
      confidence: symbol.confidence,
    });

    const declaration = declarationBySymbol.get(symbol.symbolKey);
    const ownershipLabel = declaration
      ? `${declaration.domainKind}/${declaration.preferredArchetype}`
      : `${symbol.domainKind}/${symbol.preferredArchetype}`;
    const ownershipConfidence = declaration ? declaration.confidence : symbol.confidence;
    const ownershipNodeId = `ownership:${symbol.symbolKey}`;
    registerNode({
      nodeId: ownershipNodeId,
      nodeType: "ownership",
      label: ownershipLabel,
      confidence: ownershipConfidence,
    });
    registerEdge({
      fromNodeId: symbolNodeId,
      toNodeId: ownershipNodeId,
      edgeType: "supports_ownership",
      confidence: ownershipConfidence,
      evidenceIds: [...symbol.evidenceIds].sort((left, right) => left.localeCompare(right)),
    });

    const symbolEvidence = symbol.evidenceIds
      .map((evidenceId) => recordById.get(evidenceId))
      .filter((record): record is EvidenceRecord => Boolean(record))
      .slice(0, 12);
    for (const record of symbolEvidence) {
      const evidenceNodeId = `evidence:${record.id}`;
      registerNode({
        nodeId: evidenceNodeId,
        nodeType: "evidence",
        label: `${record.kind}:${record.anchor}`,
        confidence: record.confidence,
      });
      registerEdge({
        fromNodeId: symbolNodeId,
        toNodeId: evidenceNodeId,
        edgeType: "named_by",
        confidence: record.confidence,
        evidenceIds: [record.id],
      });

      const toolNodeId = `tool:${record.provenance.tool}`;
      registerNode({
        nodeId: toolNodeId,
        nodeType: "tool",
        label: record.provenance.tool,
        confidence: 1,
      });
      registerEdge({
        fromNodeId: evidenceNodeId,
        toNodeId: toolNodeId,
        edgeType: "provided_by",
        confidence: record.confidence,
        evidenceIds: [record.id],
      });
    }

    const ownershipSignals = ownershipSignalByOwner.get(symbol.owner) ?? [];
    for (const record of ownershipSignals.slice(0, 8)) {
      const evidenceNodeId = `evidence:${record.id}`;
      registerNode({
        nodeId: evidenceNodeId,
        nodeType: "evidence",
        label: `${record.kind}:${record.anchor}`,
        confidence: record.confidence,
      });
      registerEdge({
        fromNodeId: ownershipNodeId,
        toNodeId: evidenceNodeId,
        edgeType: "supports_ownership",
        confidence: record.confidence,
        evidenceIds: [record.id],
      });
      const toolNodeId = `tool:${record.provenance.tool}`;
      registerNode({
        nodeId: toolNodeId,
        nodeType: "tool",
        label: record.provenance.tool,
        confidence: 1,
      });
      registerEdge({
        fromNodeId: evidenceNodeId,
        toNodeId: toolNodeId,
        edgeType: "provided_by",
        confidence: record.confidence,
        evidenceIds: [record.id],
      });
    }
  }

  return {
    nodes: [...nodesById.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...edgesById.values()].sort((left, right) => {
      if (left.fromNodeId !== right.fromNodeId) {
        return left.fromNodeId.localeCompare(right.fromNodeId);
      }
      if (left.toNodeId !== right.toNodeId) {
        return left.toNodeId.localeCompare(right.toNodeId);
      }
      return left.edgeType.localeCompare(right.edgeType);
    }),
  };
}

function buildExportContractGraph(
  core: SemanticIrCoreModel,
  resolvedCallEdges: ResolvedCallEdge[],
): SemanticExportContractGraph {
  const nodesById = new Map<string, SemanticExportContractNode>();
  const edgesById = new Map<string, SemanticExportContractEdge>();
  const symbolByKey = new Map<string, SemanticSymbol>();
  for (const symbol of core.symbols) {
    symbolByKey.set(symbol.symbolKey, symbol);
  }
  const declarationBySymbol = new Map<string, SemanticDomainDeclaration>();
  for (const declaration of core.domainDeclarations) {
    declarationBySymbol.set(declaration.symbolKey, declaration);
  }
  const moduleBySymbol = new Map<string, string>();

  const registerNode = (node: SemanticExportContractNode): void => {
    if (!nodesById.has(node.nodeId)) {
      nodesById.set(node.nodeId, node);
    }
  };
  const registerEdge = (edge: SemanticExportContractEdge): void => {
    const key = `${edge.fromNodeId}::${edge.toNodeId}::${edge.edgeType}`;
    const existing = edgesById.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, edge.confidence);
      existing.evidenceIds = [...new Set<string>([...existing.evidenceIds, ...edge.evidenceIds])].sort((left, right) =>
        left.localeCompare(right),
      );
      return;
    }
    edgesById.set(key, edge);
  };

  for (const cluster of [...core.declarationClusters].sort((left, right) => left.clusterId.localeCompare(right.clusterId))) {
    const moduleNodeId = `module:${cluster.clusterId}`;
    registerNode({
      nodeId: moduleNodeId,
      nodeType: "module",
      label: cluster.clusterId,
      ownerLineageId: cluster.ownerLineageId,
      layerHint: inferLayerHint(cluster.domainKind),
      archetype: cluster.preferredArchetype,
      symbolKey: "",
    });
    const symbolKeys = [...cluster.symbolKeys].sort((left, right) => left.localeCompare(right));
    for (const symbolKey of symbolKeys) {
      moduleBySymbol.set(symbolKey, moduleNodeId);
      const symbol = symbolByKey.get(symbolKey);
      const declaration = declarationBySymbol.get(symbolKey);
      const symbolNodeId = `symbol:${symbolKey}`;
      registerNode({
        nodeId: symbolNodeId,
        nodeType: "symbol",
        label: symbol ? symbol.name : symbolKey,
        ownerLineageId: declaration ? declaration.ownerLineageId : cluster.ownerLineageId,
        layerHint: inferLayerHint(declaration ? declaration.domainKind : cluster.domainKind),
        archetype: declaration ? declaration.preferredArchetype : cluster.preferredArchetype,
        symbolKey,
      });
      registerEdge({
        fromNodeId: moduleNodeId,
        toNodeId: symbolNodeId,
        edgeType: "exports",
        confidence: symbol ? symbol.confidence : 0.42,
        evidenceIds: symbol ? [...symbol.evidenceIds] : [],
      });
    }
  }

  for (const edge of resolvedCallEdges) {
    const fromModule = moduleBySymbol.get(edge.callerKey);
    const toModule = moduleBySymbol.get(edge.calleeKey);
    if (!fromModule || !toModule || fromModule === toModule) {
      continue;
    }
    registerEdge({
      fromNodeId: fromModule,
      toNodeId: toModule,
      edgeType: "imports",
      confidence: edge.confidence,
      evidenceIds: edge.evidenceIds,
    });
  }

  return {
    nodes: [...nodesById.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...edgesById.values()].sort((left, right) => {
      if (left.fromNodeId !== right.fromNodeId) {
        return left.fromNodeId.localeCompare(right.fromNodeId);
      }
      if (left.toNodeId !== right.toNodeId) {
        return left.toNodeId.localeCompare(right.toNodeId);
      }
      return left.edgeType.localeCompare(right.edgeType);
    }),
  };
}

function normalizeProvenanceTool(tool: string): string {
  const lower = tool.toLowerCase();
  if (lower.includes("webcrack")) {
    return "webcrack";
  }
  if (lower.includes("wakaru")) {
    return "wakaru";
  }
  if (lower.includes("javascript-deobfuscator")) {
    return "javascript-deobfuscator";
  }
  if (lower.includes("synchrony")) {
    return "synchrony";
  }
  if (lower.includes("unwebpack")) {
    return "unwebpack-sourcemap";
  }
  if (lower.includes("asar")) {
    return "asar";
  }
  return "asar";
}

const LEDGER_PROVENANCE_WEIGHTS: Readonly<Record<string, number>> = {
  asar: 0.78,
  webcrack: 1,
  wakaru: 0.96,
  "javascript-deobfuscator": 0.9,
  synchrony: 0.88,
  "unwebpack-sourcemap": 0.92,
};

function buildIoHintBySymbolKey(evidenceStore: EvidenceStoreModel): ReadonlyMap<string, ParsedIoSignatureHint[]> {
  const bySymbolKey = new Map<string, ParsedIoSignatureHint[]>();
  for (const record of evidenceStore.records) {
    if (record.kind !== "io_signature") {
      continue;
    }
    const symbolKey = `${record.owner}:${record.anchor}`;
    let parsed: { parameterCount?: unknown; parameterNames?: unknown; returnHint?: unknown; signature?: unknown } = {};
    try {
      parsed = JSON.parse(record.value) as { parameterCount?: unknown; parameterNames?: unknown; returnHint?: unknown; signature?: unknown };
    } catch {
      parsed = {};
    }
    const parameterNames = Array.isArray(parsed.parameterNames)
      ? parsed.parameterNames.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    const parameterCountRaw = typeof parsed.parameterCount === "number" && Number.isFinite(parsed.parameterCount)
      ? Math.trunc(parsed.parameterCount)
      : parameterNames.length;
    const parameterCount = Math.max(0, Math.min(24, parameterCountRaw));
    const returnHint = typeof parsed.returnHint === "string" && parsed.returnHint.length > 0
      ? parsed.returnHint
      : "unknown";
    const signature = typeof parsed.signature === "string" && parsed.signature.length > 0
      ? parsed.signature
      : `${record.value}()`;
    const hint: ParsedIoSignatureHint = {
      parameterCount,
      parameterHints: parameterNames.slice(0, 8),
      returnHint,
      signature,
      confidence: record.confidence,
      evidenceId: record.id,
    };
    const existing = bySymbolKey.get(symbolKey);
    if (existing) {
      existing.push(hint);
      continue;
    }
    bySymbolKey.set(symbolKey, [hint]);
  }
  for (const [symbolKey, hints] of bySymbolKey.entries()) {
    bySymbolKey.set(symbolKey, [...hints].sort((left, right) => right.confidence - left.confidence));
  }
  return bySymbolKey;
}

function buildStateKeysByOwner(core: SemanticIrCoreModel): ReadonlyMap<string, string[]> {
  const byOwner = new Map<string, Set<string>>();
  for (const stateKey of core.stateKeys) {
    for (const owner of stateKey.owners) {
      const existing = byOwner.get(owner) ?? new Set<string>();
      existing.add(stateKey.key);
      byOwner.set(owner, existing);
    }
  }
  const normalized = new Map<string, string[]>();
  for (const [owner, keys] of byOwner.entries()) {
    normalized.set(owner, [...keys].sort((left, right) => left.localeCompare(right)));
  }
  return normalized;
}

function buildCallGraphNeighborhoodBySymbol(
  symbols: SemanticSymbol[],
  resolvedCallEdges: ResolvedCallEdge[],
): ReadonlyMap<string, SemanticCallGraphNeighborhood> {
  const outgoingBySymbol = new Map<string, Set<string>>();
  const incomingBySymbol = new Map<string, Set<string>>();
  for (const edge of resolvedCallEdges) {
    const outgoing = outgoingBySymbol.get(edge.callerKey) ?? new Set<string>();
    outgoing.add(edge.calleeKey);
    outgoingBySymbol.set(edge.callerKey, outgoing);

    const incoming = incomingBySymbol.get(edge.calleeKey) ?? new Set<string>();
    incoming.add(edge.callerKey);
    incomingBySymbol.set(edge.calleeKey, incoming);
  }
  const symbolNameByKey = new Map(symbols.map((symbol) => [symbol.symbolKey, symbol.name]));
  const neighborhoodBySymbol = new Map<string, SemanticCallGraphNeighborhood>();
  for (const symbol of symbols) {
    const outgoing = [...(outgoingBySymbol.get(symbol.symbolKey) ?? new Set<string>())].sort((left, right) =>
      left.localeCompare(right),
    );
    const incoming = [...(incomingBySymbol.get(symbol.symbolKey) ?? new Set<string>())].sort((left, right) =>
      left.localeCompare(right),
    );
    const mergedNeighbours = [...new Set<string>([...incoming, ...outgoing])].sort((left, right) => left.localeCompare(right));
    const neighbourNames = mergedNeighbours
      .map((symbolKey) => symbolNameByKey.get(symbolKey) ?? symbolKey)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 12);
    neighborhoodBySymbol.set(symbol.symbolKey, {
      symbolKey: symbol.symbolKey,
      incomingCount: incoming.length,
      outgoingCount: outgoing.length,
      neighbourKeys: mergedNeighbours,
      neighbourNames,
    });
  }
  return neighborhoodBySymbol;
}

function inferApiShape(
  symbolName: string,
  role: SemanticSymbolRole,
  returnHint: string,
  parameterCount: number,
): SemanticApiShape {
  const lower = symbolName.toLowerCase();
  if (/^[A-Z]/.test(symbolName)) {
    return "class-constructor";
  }
  if (lower.startsWith("on") || lower.startsWith("handle") || lower.includes("listener")) {
    return "event-handler";
  }
  if (role === "store" && (lower.startsWith("get") || lower.startsWith("set") || lower.includes("state"))) {
    return "state-accessor";
  }
  if (lower.startsWith("create") || lower.startsWith("build") || lower.startsWith("make")) {
    return "factory";
  }
  if (lower.startsWith("async") || returnHint.toLowerCase().includes("promise")) {
    return "async-function";
  }
  if (parameterCount === 0 && role === "parser" && returnHint.toLowerCase() === "object") {
    return "factory";
  }
  return "sync-function";
}

function inferSideEffects(
  symbol: SemanticSymbol,
  stateKeys: string[],
  neighborhood: SemanticCallGraphNeighborhood,
): SemanticSideEffects {
  const lower = symbol.name.toLowerCase();
  const mutatesState =
    stateKeys.length > 0 &&
    (symbol.domainKind === "store" || lower.includes("set") || lower.includes("update") || lower.includes("save"));
  const emitsEvents = symbol.eventFlowScore >= 0.45 || lower.includes("emit") || lower.includes("dispatch") || lower.includes("publish");
  const performsIo =
    lower.includes("fetch") ||
    lower.includes("request") ||
    lower.includes("load") ||
    lower.includes("read") ||
    lower.includes("write") ||
    lower.includes("http") ||
    lower.includes("fs");
  const touchesUi = symbol.domainKind === "ui" || symbol.domainKind === "hook" || lower.includes("render") || lower.includes("view");
  const invokesTransport =
    symbol.domainKind === "transport" ||
    lower.includes("ipc") ||
    lower.includes("rpc") ||
    lower.includes("invoke") ||
    lower.includes("channel");
  const tags = [
    mutatesState ? "mutates-state" : "",
    emitsEvents ? "emits-events" : "",
    performsIo ? "performs-io" : "",
    touchesUi ? "touches-ui" : "",
    invokesTransport ? "invokes-transport" : "",
    neighborhood.outgoingCount > neighborhood.incomingCount + 1 ? "high-out-degree" : "",
  ]
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return {
    symbolKey: symbol.symbolKey,
    mutatesState,
    emitsEvents,
    performsIo,
    touchesUi,
    invokesTransport,
    tags,
  };
}

function inferMutationProfile(sideEffects: SemanticSideEffects): SemanticMutationProfile {
  if (sideEffects.invokesTransport || sideEffects.performsIo) {
    return "io-mutation";
  }
  if (sideEffects.mutatesState) {
    return "state-mutation";
  }
  if (sideEffects.emitsEvents || sideEffects.touchesUi) {
    return "local-mutation";
  }
  return "pure";
}

function resolveRoleConsensus(
  symbol: SemanticSymbol,
  ioSignature: SemanticIoSignature,
  sideEffects: SemanticSideEffects,
  neighborhood: SemanticCallGraphNeighborhood,
  stateKeys: string[],
): RoleConsensusResult {
  const tokens = tokenizeSignal(`${symbol.name} ${stateKeys.join(" ")}`);
  const score: Record<SemanticSymbolRole, number> = {
    orchestrator: 0.08,
    parser: 0.08,
    store: 0.08,
    transport: 0.08,
    ui: 0.08,
  };
  const consensusSignals: string[] = [];

  if (tokens.some((token) => PARSER_SIGNAL_TOKENS.has(token))) {
    score.parser += 0.52;
    consensusSignals.push("parser-tokens");
  }
  if (tokens.some((token) => STORE_SIGNAL_TOKENS.has(token)) || stateKeys.length > 0) {
    score.store += 0.56;
    consensusSignals.push("state-signals");
  }
  if (tokens.some((token) => TRANSPORT_SIGNAL_TOKENS.has(token)) || sideEffects.invokesTransport) {
    score.transport += 0.62;
    consensusSignals.push("transport-signals");
  }
  if (tokens.some((token) => UI_SIGNAL_TOKENS.has(token)) || sideEffects.touchesUi || symbol.routeFlowScore >= 0.5) {
    score.ui += 0.58;
    consensusSignals.push("ui-signals");
  }
  if (
    tokens.some((token) => ORCHESTRATOR_SIGNAL_TOKENS.has(token)) ||
    neighborhood.outgoingCount > neighborhood.incomingCount + 1
  ) {
    score.orchestrator += 0.54;
    consensusSignals.push("orchestration-flow");
  }

  if (symbol.domainKind === "store") {
    score.store += 0.48;
  }
  if (symbol.domainKind === "transport") {
    score.transport += 0.48;
  }
  if (symbol.domainKind === "ui" || symbol.domainKind === "hook") {
    score.ui += 0.42;
  }
  if (symbol.domainKind === "service" || symbol.domainKind === "usecase") {
    score.orchestrator += 0.24;
  }

  if (ioSignature.apiShape === "event-handler") {
    score.orchestrator += 0.24;
    score.ui += 0.12;
  }
  if (ioSignature.apiShape === "factory") {
    score.parser += 0.2;
  }
  if (sideEffects.emitsEvents) {
    score.orchestrator += 0.18;
    score.transport += 0.12;
  }

  const ranked = (Object.keys(score) as SemanticSymbolRole[])
    .map((role) => ({ role, score: score[role] }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.role.localeCompare(right.role);
    });
  const winner = ranked[0];
  const second = ranked[1];
  if (!winner) {
    throw new Error(`resolveRoleConsensus: missing role scores for ${symbol.symbolKey}`);
  }
  const totalScore = ranked.reduce((sum, entry) => sum + entry.score, 0.0001);
  const spread = second ? Math.max(0, winner.score - second.score) : winner.score;
  const consensusScore = clamp((winner.score / totalScore) * 0.74 + Math.min(1, spread / 1.4) * 0.26);
  return {
    resolvedRole: winner.role,
    signalScores: score,
    consensusScore,
    consensusSignals: [...new Set<string>(consensusSignals)].sort((left, right) => left.localeCompare(right)),
  };
}

function buildDeclarationFingerprints(
  core: SemanticIrCoreModel,
  evidenceStore: EvidenceStoreModel,
  resolvedCallEdges: ResolvedCallEdge[],
): SemanticDeclarationFingerprint[] {
  const declarationBySymbol = new Map(core.domainDeclarations.map((declaration) => [declaration.symbolKey, declaration]));
  const ioHintsBySymbolKey = buildIoHintBySymbolKey(evidenceStore);
  const stateKeysByOwner = buildStateKeysByOwner(core);
  const neighborhoods = buildCallGraphNeighborhoodBySymbol(core.symbols, resolvedCallEdges);
  const fingerprints: SemanticDeclarationFingerprint[] = [];

  for (const symbol of [...core.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))) {
    const declaration = declarationBySymbol.get(symbol.symbolKey);
    const ioHints = ioHintsBySymbolKey.get(symbol.symbolKey) ?? [];
    const bestIo = ioHints[0];
    const parameterCount = bestIo ? bestIo.parameterCount : 0;
    const parameterHints = bestIo ? bestIo.parameterHints : [];
    const returnHint = bestIo ? bestIo.returnHint : "unknown";
    const initialRole: SemanticSymbolRole = symbol.domainKind === "store"
      ? "store"
      : symbol.domainKind === "transport"
        ? "transport"
        : symbol.domainKind === "ui" || symbol.domainKind === "hook"
          ? "ui"
          : "orchestrator";
    const ioSignature: SemanticIoSignature = {
      symbolKey: symbol.symbolKey,
      parameterCount,
      parameterHints,
      returnHint,
      apiShape: inferApiShape(symbol.name, initialRole, returnHint, parameterCount),
    };
    const neighborhood = neighborhoods.get(symbol.symbolKey) ?? {
      symbolKey: symbol.symbolKey,
      incomingCount: 0,
      outgoingCount: 0,
      neighbourKeys: [],
      neighbourNames: [],
    };
    const ownerStateKeys = stateKeysByOwner.get(symbol.owner) ?? [];
    const declarationSignals = declaration ? declaration.stateSignals : [];
    const stateKeys = [...new Set<string>([...ownerStateKeys, ...declarationSignals])].sort((left, right) =>
      left.localeCompare(right),
    );
    const sideEffects = inferSideEffects(symbol, stateKeys, neighborhood);
    const roleConsensus = resolveRoleConsensus(symbol, ioSignature, sideEffects, neighborhood, stateKeys);
    const resolvedIoSignature: SemanticIoSignature = {
      ...ioSignature,
      apiShape: inferApiShape(symbol.name, roleConsensus.resolvedRole, returnHint, parameterCount),
    };
    const evidenceIds = [...new Set<string>([...symbol.evidenceIds, ...(bestIo ? [bestIo.evidenceId] : [])])].sort((left, right) =>
      left.localeCompare(right),
    );
    fingerprints.push({
      symbolKey: symbol.symbolKey,
      symbolName: symbol.name,
      role: roleConsensus.resolvedRole,
      roleSignalScores: roleConsensus.signalScores,
      roleConsensusSignals: roleConsensus.consensusSignals,
      ioSignature: resolvedIoSignature,
      sideEffects,
      stateKeys: stateKeys.slice(0, 24),
      callGraphNeighborhood: neighborhood,
      mutationProfile: inferMutationProfile(sideEffects),
      confidence: clamp(Math.max(symbol.confidence, roleConsensus.consensusScore * 0.88)),
      evidenceIds,
    });
  }

  return fingerprints;
}

function buildSymbolRoleGraph(fingerprints: SemanticDeclarationFingerprint[]): SemanticSymbolRoleGraph {
  const roleNodes: SemanticRoleGraphNode[] = ([
    "orchestrator",
    "parser",
    "store",
    "transport",
    "ui",
  ] as SemanticSymbolRole[]).map((role) => ({
    nodeId: `role:${role}`,
    nodeType: "role",
    label: role,
    confidence: 1,
  }));

  const symbolNodes: SemanticRoleGraphNode[] = fingerprints.map((fingerprint) => ({
    nodeId: `symbol:${fingerprint.symbolKey}`,
    nodeType: "symbol",
    label: fingerprint.symbolName,
    confidence: fingerprint.confidence,
  }));

  const edges: SemanticRoleGraphEdge[] = [];
  const resolutions: SemanticRoleResolution[] = [];
  for (const fingerprint of fingerprints) {
    for (const role of Object.keys(fingerprint.roleSignalScores) as SemanticSymbolRole[]) {
      const score = clamp(fingerprint.roleSignalScores[role] / 2.2);
      if (score < 0.12) {
        continue;
      }
      edges.push({
        fromNodeId: `symbol:${fingerprint.symbolKey}`,
        toNodeId: `role:${role}`,
        role,
        confidence: score,
        signals: fingerprint.roleConsensusSignals,
      });
    }
    resolutions.push({
      symbolKey: fingerprint.symbolKey,
      resolvedRole: fingerprint.role,
      consensusScore: fingerprint.confidence,
      signalScores: fingerprint.roleSignalScores,
      consensusSignals: fingerprint.roleConsensusSignals,
    });
  }

  edges.sort((left, right) => {
    if (left.fromNodeId !== right.fromNodeId) {
      return left.fromNodeId.localeCompare(right.fromNodeId);
    }
    return left.toNodeId.localeCompare(right.toNodeId);
  });
  resolutions.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  return {
    nodes: [...roleNodes, ...symbolNodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges,
    resolutions,
  };
}

function buildEvidenceLedger(core: SemanticIrCoreModel, evidenceStore: EvidenceStoreModel): SemanticEvidenceLedger {
  const recordsBySymbolKey = new Map<string, EvidenceRecord[]>();
  for (const record of evidenceStore.records) {
    if (record.kind !== "symbol_hint") {
      continue;
    }
    const symbolKey = `${record.owner}:${record.anchor}`;
    const existing = recordsBySymbolKey.get(symbolKey);
    if (existing) {
      existing.push(record);
      continue;
    }
    recordsBySymbolKey.set(symbolKey, [record]);
  }

  const entries: SemanticEvidenceLedgerEntry[] = [];
  for (const symbol of [...core.symbols].sort((left, right) => left.symbolKey.localeCompare(right.symbolKey))) {
    const records = recordsBySymbolKey.get(symbol.symbolKey) ?? [];
    const candidateByName = new Map<string, {
      score: number;
      quality: number;
      supportCount: number;
      evidenceIds: Set<string>;
      provenance: Set<string>;
      conflictPenalty: number;
    }>();

    for (const record of records) {
      const name = record.value;
      const quality = scoreNameQuality(name);
      const normalizedTool = normalizeProvenanceTool(record.provenance.tool);
      const toolWeight = LEDGER_PROVENANCE_WEIGHTS[normalizedTool] ?? 0.78;
      const genericPenalty = isGenericName(name) ? 0.14 : 0;
      const increment = record.confidence * toolWeight + quality * 0.15 - genericPenalty;
      const existing = candidateByName.get(name);
      if (existing) {
        existing.score += increment;
        existing.supportCount += 1;
        existing.quality = Math.max(existing.quality, quality);
        existing.evidenceIds.add(record.id);
        existing.provenance.add(normalizedTool);
        existing.conflictPenalty = Math.max(existing.conflictPenalty, genericPenalty);
        continue;
      }
      candidateByName.set(name, {
        score: increment,
        quality,
        supportCount: 1,
        evidenceIds: new Set<string>([record.id]),
        provenance: new Set<string>([normalizedTool]),
        conflictPenalty: genericPenalty,
      });
    }

    const candidates: SemanticEvidenceLedgerCandidate[] = [...candidateByName.entries()]
      .map(([name, candidate]) => {
        const evidenceBoost = Math.min(0.12, candidate.evidenceIds.size * 0.012);
        const provenanceBoost = Math.min(0.1, candidate.provenance.size * 0.02);
        const normalizedScore = clamp(candidate.score * 0.62 + candidate.quality * 0.3 + evidenceBoost + provenanceBoost);
        return {
          name,
          score: normalizedScore,
          quality: candidate.quality,
          supportCount: candidate.supportCount,
          evidenceIds: [...candidate.evidenceIds].sort((left, right) => left.localeCompare(right)),
          provenance: [...candidate.provenance].sort((left, right) => left.localeCompare(right)),
          conflictPenalty: candidate.conflictPenalty,
        };
      })
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.quality !== right.quality) {
          return right.quality - left.quality;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 12);

    const winner = candidates[0];
    if (!winner) {
      entries.push({
        symbolKey: symbol.symbolKey,
        winnerName: symbol.name,
        winnerScore: clamp(symbol.confidence * 0.7 + symbol.quality * 0.3),
        conflictResolvedBy: "fallback:semantic-symbol-winner",
        candidates: [
          {
            name: symbol.name,
            score: clamp(symbol.confidence * 0.7 + symbol.quality * 0.3),
            quality: symbol.quality,
            supportCount: 1,
            evidenceIds: [...symbol.evidenceIds].sort((left, right) => left.localeCompare(right)),
            provenance: [...symbol.provenance].sort((left, right) => left.localeCompare(right)),
            conflictPenalty: isGenericName(symbol.name) ? 0.14 : 0,
          },
        ],
      });
      continue;
    }

    entries.push({
      symbolKey: symbol.symbolKey,
      winnerName: winner.name,
      winnerScore: winner.score,
      conflictResolvedBy: "score>quality>lexicographic",
      candidates,
    });
  }

  return {
    entries,
  };
}

function applyEvidenceLedgerWinners(
  symbols: SemanticSymbol[],
  evidenceLedger: SemanticEvidenceLedger,
): SemanticSymbol[] {
  const ledgerBySymbolKey = new Map(evidenceLedger.entries.map((entry) => [entry.symbolKey, entry]));
  const updated = symbols.map((symbol) => {
    const ledgerEntry = ledgerBySymbolKey.get(symbol.symbolKey);
    if (!ledgerEntry) {
      return symbol;
    }
    if (ledgerEntry.winnerName === symbol.name || !isIdentifierName(ledgerEntry.winnerName)) {
      return symbol;
    }
    const winnerQuality = scoreNameQuality(ledgerEntry.winnerName);
    const currentQuality = scoreNameQuality(symbol.name);
    const genericUpgrade = isGenericName(symbol.name) && !isGenericName(ledgerEntry.winnerName);
    const qualityUpgrade = winnerQuality >= currentQuality + 0.04;
    const scoreUpgrade = ledgerEntry.winnerScore >= symbol.confidence * 0.86;
    if (!genericUpgrade && !qualityUpgrade && !scoreUpgrade) {
      return symbol;
    }
    const alternatives = [
      ...new Set<string>([
        ...ledgerEntry.candidates.map((candidate) => candidate.name),
        ...symbol.alternatives,
        symbol.name,
      ]),
    ]
      .filter((entry) => entry !== ledgerEntry.winnerName)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 8);
    return {
      ...symbol,
      name: ledgerEntry.winnerName,
      quality: Math.max(symbol.quality, winnerQuality),
      confidence: clamp(Math.max(symbol.confidence, ledgerEntry.winnerScore)),
      alternatives,
    };
  });
  return updated.sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
}

export function finalizeSemanticIrModel(
  core: SemanticIrCoreModel,
  evidenceStore: EvidenceStoreModel,
  obfuscationProfile: ObfuscationProfileDescriptor,
): SemanticIrModel {
  const evidenceLedger = buildEvidenceLedger(core, evidenceStore);
  const ledgerSymbols = applyEvidenceLedgerWinners(core.symbols, evidenceLedger);
  const symbolNameByKey = new Map(ledgerSymbols.map((symbol) => [symbol.symbolKey, symbol.name]));
  const ledgerDeclarations = core.domainDeclarations.map((declaration) => ({
    ...declaration,
    symbolName: symbolNameByKey.get(declaration.symbolKey) ?? declaration.symbolName,
  }));
  const ledgerCore: SemanticIrCoreModel = {
    ...core,
    symbols: ledgerSymbols,
    domainDeclarations: ledgerDeclarations,
  };

  const resolvedCallEdges = resolveCallEdgesToSymbolKeys(ledgerCore.symbols, ledgerCore.callEdges);
  const domainEntities = buildDomainEntities(ledgerCore, resolvedCallEdges);
  const symbolProvenanceGraph = buildSymbolProvenanceGraph(ledgerCore, evidenceStore);
  const exportContractGraph = buildExportContractGraph(ledgerCore, resolvedCallEdges);
  const declarationFingerprints = buildDeclarationFingerprints(ledgerCore, evidenceStore, resolvedCallEdges);
  const symbolRoleGraph = buildSymbolRoleGraph(declarationFingerprints);
  return {
    version: 4,
    generatedAtIso: new Date().toISOString(),
    obfuscationProfile,
    fileHints: ledgerCore.fileHints,
    symbols: ledgerCore.symbols,
    callEdges: ledgerCore.callEdges,
    stateKeys: ledgerCore.stateKeys,
    sourceMaps: ledgerCore.sourceMaps,
    domainDeclarations: ledgerCore.domainDeclarations,
    declarationClusters: ledgerCore.declarationClusters,
    domainEntities,
    symbolProvenanceGraph,
    exportContractGraph,
    declarationFingerprints,
    symbolRoleGraph,
    evidenceLedger,
  };
}

export function buildSemanticIr(
  evidenceStore: EvidenceStoreModel,
  weights: ToolWeights,
  obfuscationProfile: ObfuscationProfileDescriptor,
): SemanticIrModel {
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

  const core: SemanticIrCoreModel = {
    fileHints,
    symbols,
    callEdges,
    stateKeys,
    sourceMaps,
    domainDeclarations,
    declarationClusters: clusters,
  };
  return finalizeSemanticIrModel(core, evidenceStore, obfuscationProfile);
}
