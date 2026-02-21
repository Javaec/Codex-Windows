import * as path from "node:path";
import * as ts from "typescript";

import type { ReferenceModel, ReferenceSymbolRow, ReferenceSymbolSource } from "./reference-model";

export interface FileRecord {
  relPath: string;
}

export interface IndexRow {
  value: string;
  files: string[];
}

export interface ComponentBoundaryEntry {
  ownerFile: string;
  referenceHints: string[];
  componentNames: string[];
  hookNames: string[];
  uiIndicators: string[];
  routes: string[];
  events: string[];
  rpcMethods: string[];
  stateKeys: string[];
  statuses: string[];
  ipcChannels: string[];
}

export interface ComponentBoundariesReport {
  boundaries: ComponentBoundaryEntry[];
}

type DeobfuscatedSymbolKind = "class" | "function" | "file";

export interface DeobfuscationTableEntry {
  id: string;
  kind: DeobfuscatedSymbolKind;
  obfuscated: string;
  deobfuscated: string;
  sourceFile: string;
  targetProjectPath: string;
  confidence: number;
  reference: {
    source: ReferenceSymbolSource;
    symbol: string;
    file: string;
    kind: string;
    score: number;
  };
  rationale: string[];
}

export interface DeobfuscationFilePlan {
  sourceFile: string;
  proposedModulePath: string;
  confidence: number;
  rationale: string[];
  referenceSource: ReferenceSymbolSource;
}

export interface DeobfuscationTableReport {
  generatedAtUtc: string;
  strategy: string;
  referenceInputs: {
    architectureMapPath: string;
    oneCodeSymbolMapPath: string;
    codexMonitorSymbolMapPath: string;
    loaded: boolean;
    warningCount: number;
    symbolCount: number;
  };
  coverage: {
    filesScanned: number;
    obfuscatedFileCandidates: number;
    obfuscatedSymbolCandidates: number;
    mappedFiles: number;
    mappedSymbols: number;
  };
  filePlans: DeobfuscationFilePlan[];
  entries: DeobfuscationTableEntry[];
}

interface ObfuscatedSymbolCandidate {
  kind: "class" | "function";
  name: string;
  sourceFile: string;
  line: number;
  tokens: string[];
}

interface FileSignalProfile {
  contextKeywords: Set<string>;
  ast: number;
  ipcRpc: number;
  state: number;
  boundary: number;
  flow: number;
  domainScores: Record<string, number>;
  dominantDomain: string;
}

interface ReferenceFileProfile {
  source: ReferenceSymbolSource;
  file: string;
  maxScore: number;
  symbolCount: number;
  tokens: Set<string>;
}

interface SourceReferenceAnchor {
  sourceFile: string;
  primaryFile: string;
  secondaryFiles: string[];
  hitTokens: string[];
  score: number;
}

export interface BuildDeobfuscationTableMatchV2Input {
  top: number;
  jsFiles: FileRecord[];
  sourceByFile: Map<string, string>;
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  ipcRows: IndexRow[];
  componentBoundaries: ComponentBoundariesReport;
  referenceModel: ReferenceModel;
}

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const VENDOR_FILE_HINTS =
  /(cytoscape|cose-bilkent|mermaid|monaco|vscode-languageserver|xterm|zod|antlr|codicon|pdf\.worker|minimap|highlight-code)/i;
const LOCALE_ASSET_FILE_PATTERN = /^webview\/assets\/[a-z]{2}(?:-[a-z]{2})?-[A-Za-z0-9_-]+\.(?:js|mjs|cjs)$/i;

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function dedupeKeywords(values: Iterable<string>, max: number): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 3 || normalized.length > 90) continue;
    if (/^\d+$/.test(normalized)) continue;
    out.add(normalized);
    if (out.size >= max) break;
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function splitSignalToken(value: string): string[] {
  const normalized = value.trim();
  if (normalized.length === 0) return [];
  const parts = normalized.split(/[^A-Za-z0-9_./:-]+/g).filter((part) => part.length >= 3);
  const nested: string[] = [];
  for (const part of parts) {
    nested.push(part);
    nested.push(...part.split(/[./:_-]+/g).filter((item) => item.length >= 3));
    const camel = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/g);
    for (const item of camel) {
      if (item.length >= 3) nested.push(item);
    }
  }
  return nested;
}

function addValueTokens(target: Set<string>, value: string, limit: number): void {
  for (const token of splitSignalToken(value)) {
    const normalized = token.toLowerCase();
    if (normalized.length < 3) continue;
    target.add(normalized);
    if (target.size >= limit) break;
  }
}

function extractNameTokens(value: string): string[] {
  const raw = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter((part) => part.length >= 2)
    .map((part) => part.toLowerCase());
  return dedupeKeywords(raw, 64);
}

function isLocaleAssetFile(file: string): boolean {
  return LOCALE_ASSET_FILE_PATTERN.test(toPosixPath(file));
}

function isLikelyCoreAppFile(file: string): boolean {
  const lower = toPosixPath(file).toLowerCase();
  if (lower.startsWith(".vite/build/main-")) return true;
  if (lower.startsWith(".vite/build/preload-")) return true;
  if (lower.startsWith(".vite/build/worker")) return true;
  if (lower.startsWith("webview/assets/index-")) return true;
  if (lower.startsWith("webview/assets/main-")) return true;
  if (lower.startsWith("webview/assets/worker-")) return true;
  return false;
}

function isDeobfuscationCandidateFile(file: string): boolean {
  const normalized = toPosixPath(file).toLowerCase();
  if (!JS_EXTENSIONS.has(path.extname(normalized))) return false;
  if (isLocaleAssetFile(normalized)) return false;
  if (VENDOR_FILE_HINTS.test(normalized)) return false;
  if (normalized.startsWith(".vite/build/main-")) return true;
  if (normalized.startsWith(".vite/build/preload-")) return true;
  if (normalized.startsWith(".vite/build/worker")) return true;
  if (!normalized.startsWith("webview/assets/")) return false;
  return /^(?:index|chunk|worker|main|desktop|channel|clone|data-controls|diff|agent-settings|automation|git-settings|init)-/.test(
    path.basename(normalized),
  );
}

function classifyRuntimeLayer(file: string): "main" | "main-worker" | "preload" | "renderer" | "renderer-worker" | "unknown" {
  const normalized = toPosixPath(file).toLowerCase();
  if (normalized.startsWith(".vite/build/main")) return "main";
  if (normalized.startsWith(".vite/build/preload")) return "preload";
  if (normalized.startsWith(".vite/build/worker")) return "main-worker";
  if (normalized.startsWith("webview/assets/worker")) return "renderer-worker";
  if (normalized.startsWith("webview/assets/")) return "renderer";
  return "unknown";
}

function buildReferenceTargetPath(referenceFile: string): string {
  const normalized = toPosixPath(referenceFile).replace(/^\.?\//, "");
  if (normalized.startsWith("src-tauri/src/")) {
    return `reconstructed/src-tauri-adapter/${normalized.replace(/^src-tauri\/src\//, "").replace(/\.rs$/i, ".ts")}`;
  }
  if (/\.rs$/i.test(normalized)) {
    return `reconstructed/src-tauri-adapter/${normalized.replace(/\.rs$/i, ".ts")}`;
  }
  return `reconstructed/${normalized}`;
}

function isGenericReferenceFilePath(file: string): boolean {
  const normalized = toPosixPath(file).toLowerCase();
  if (/(^|\/)(types?|utils?|index|mod|common|shared|state|constants?)\.(ts|tsx|rs|js|mjs|cjs)$/i.test(normalized)) return true;
  if (/(^|\/)(types?|utils?|common|shared)(\/|$)/i.test(normalized)) return true;
  if (/\/icons\/index\./i.test(normalized)) return true;
  return false;
}

function classifyReferenceDomain(file: string): string {
  const normalized = toPosixPath(file).toLowerCase();
  if (/(chat|thread|conversation|agent|mention|diff)/.test(normalized)) return "chat_sessions";
  if (/(settings|skill|auth|config|model|preferences|profile)/.test(normalized)) return "settings_skills";
  if (/(route|router|navigation|sidebar|panel|layout|viewer|view|ui)/.test(normalized)) return "navigation";
  if (/(event|stream|delta|status|state|runtime|ipc|tauri|backend|transport|sync|ready)/.test(normalized)) return "async_readiness";
  return "unknown";
}

function getLayerMismatchPenalty(layer: ReturnType<typeof classifyRuntimeLayer>, referenceFile: string): number {
  const normalized = toPosixPath(referenceFile).toLowerCase();
  const isRendererReference = /(^|\/)src\/renderer\//.test(normalized) || /\/renderer\//.test(normalized);
  const isMainReference = /(^|\/)src\/main\//.test(normalized) || /\/main\//.test(normalized);
  const isPreloadReference = /(^|\/)src\/preload\//.test(normalized) || /\/preload\//.test(normalized);
  const isTauriReference = /src-tauri\/src\//.test(normalized) || /\/backend\//.test(normalized);

  if ((layer === "renderer" || layer === "renderer-worker") && (isMainReference || isTauriReference)) return 1.7;
  if ((layer === "main" || layer === "main-worker") && isRendererReference) return 1.6;
  if (layer === "preload" && !isPreloadReference && (isRendererReference || isMainReference || isTauriReference)) return 1.1;
  return 0;
}

function computeDomainScores(
  contextKeywords: Set<string>,
  domainKeywords: Record<string, string[]>,
): { domainScores: Record<string, number>; dominantDomain: string } {
  const scores: Record<string, number> = {};
  let dominantDomain = "unknown";
  let dominantScore = 0;

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    const keywordSet = new Set<string>(keywords.map((item) => item.trim().toLowerCase()).filter((item) => item.length >= 3));
    if (keywordSet.size === 0) {
      scores[domain] = 0;
      continue;
    }
    let hits = 0;
    for (const token of contextKeywords) {
      if (!keywordSet.has(token.toLowerCase())) continue;
      hits += 1;
    }
    const score = roundMetric((hits * 100) / Math.max(12, keywordSet.size));
    scores[domain] = score;
    if (score > dominantScore) {
      dominantScore = score;
      dominantDomain = domain;
    }
  }

  if (dominantScore < 1.2) dominantDomain = "unknown";
  return { domainScores: scores, dominantDomain };
}

function scoreDomainAlignment(profile: FileSignalProfile, referenceFile: string): { boost: number; penalty: number } {
  const referenceDomain = classifyReferenceDomain(referenceFile);
  if (referenceDomain === "unknown") return { boost: 0, penalty: 0.25 };

  const domainScore = profile.domainScores[referenceDomain] ?? 0;
  if (profile.dominantDomain === referenceDomain) {
    return { boost: Math.min(1.6, domainScore * 0.25 + 0.35), penalty: 0 };
  }
  if (profile.dominantDomain !== "unknown") {
    const dominantScore = profile.domainScores[profile.dominantDomain] ?? 0;
    if (dominantScore >= domainScore + 0.8) return { boost: 0, penalty: 0.95 };
  }
  return { boost: Math.min(0.45, domainScore * 0.1), penalty: 0.2 };
}

function computeSourceReferenceAnchors(input: {
  jsFiles: FileRecord[];
  fileSignals: Map<string, FileSignalProfile>;
  referenceFileProfiles: ReferenceFileProfile[];
}): Map<string, SourceReferenceAnchor> {
  const anchors = new Map<string, SourceReferenceAnchor>();
  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!isDeobfuscationCandidateFile(relPath)) continue;
    const signal = input.fileSignals.get(relPath);
    if (!signal) continue;

    let best: { profile: ReferenceFileProfile; score: number; hits: string[] } | undefined;
    const top: Array<{ profile: ReferenceFileProfile; score: number; hits: string[] }> = [];
    for (const profile of input.referenceFileProfiles) {
      const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
      if (!best || scored.score > best.score) best = { profile, score: scored.score, hits: scored.hits };
      top.push({ profile, score: scored.score, hits: scored.hits });
    }

    if (!best) continue;
    top.sort((a, b) => b.score - a.score);
    const selected = top.filter((row) => row.score >= best.score - 1.2).slice(0, 4);
    if (selected.length === 0) continue;
    if (best.score < 3.8 && getTotalSignalStrength(signal) < 9) continue;

    anchors.set(relPath, {
      sourceFile: relPath,
      primaryFile: selected[0].profile.file,
      secondaryFiles: selected.slice(1).map((row) => row.profile.file),
      hitTokens: selected[0].hits,
      score: roundMetric(selected[0].score),
    });
  }
  return anchors;
}

function getAnchorBoost(anchor: SourceReferenceAnchor | undefined, referenceFile: string): number {
  if (!anchor) return 0;
  if (referenceFile === anchor.primaryFile) return 1.9;
  if (anchor.secondaryFiles.includes(referenceFile)) return 1.1;
  return 0;
}

function isLikelyObfuscatedClassName(name: string): boolean {
  if (name.length < 2) return false;
  if (name.length === 2) return true;
  if (/^[A-Z][a-z]?$/.test(name)) return true;
  if (/^[A-Z][0-9]{1,2}$/.test(name)) return true;
  if (/^[A-Z][A-Za-z0-9]{0,3}$/.test(name) && !/[aeiou]/i.test(name)) return true;
  return false;
}

function isLikelyObfuscatedFunctionName(name: string): boolean {
  if (name.length < 2) return false;
  const lower = name.toLowerCase();
  if (name.length <= 2) return true;
  if (/^[$_]?[a-z][0-9]{1,2}$/.test(name)) return true;
  if (/^[$_]?[a-z]{1,3}$/.test(name) && !/(get|set|use|run|open|close|load|save|send|read|write)/.test(lower)) return true;
  if (/^[a-z][a-z0-9]{0,3}$/.test(name) && !/[aeiou]/i.test(name)) return true;
  return false;
}

function normalizeSourceForPrint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}

function collectObfuscatedSymbolsFromSource(input: { relPath: string; source: string }): ObfuscatedSymbolCandidate[] {
  const candidates: ObfuscatedSymbolCandidate[] = [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(input.relPath, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return candidates;
  }

  const pushCandidate = (kind: "class" | "function", name: string, node: ts.Node): void => {
    const isCandidate = kind === "class" ? isLikelyObfuscatedClassName(name) : isLikelyObfuscatedFunctionName(name);
    if (!isCandidate) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    candidates.push({ kind, name, sourceFile: input.relPath, line: position.line + 1, tokens: extractNameTokens(name) });
  };

  const getPropertyNameText = (name: ts.PropertyName): string => {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
    return "";
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      pushCandidate("class", node.name.text, node.name);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      pushCandidate("function", node.name.text, node.name);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) pushCandidate("function", node.name.text, node.name);
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const methodName = getPropertyNameText(node.name);
      if (methodName.length > 0) pushCandidate("function", methodName, node.name);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return candidates;
}

function buildReferenceFileProfiles(symbols: ReferenceSymbolRow[]): ReferenceFileProfile[] {
  const map = new Map<string, ReferenceFileProfile>();
  for (const symbol of symbols) {
    const key = `${symbol.source}|${symbol.file}`;
    const row = map.get(key) ?? { source: symbol.source, file: symbol.file, maxScore: 0, symbolCount: 0, tokens: new Set<string>() };
    row.maxScore = Math.max(row.maxScore, symbol.score);
    row.symbolCount += 1;
    for (const token of symbol.tokens) row.tokens.add(token.toLowerCase());
    map.set(key, row);
  }
  return Array.from(map.values());
}

function buildFileSignalProfiles(input: {
  jsFiles: FileRecord[];
  routeRows: IndexRow[];
  methodRows: IndexRow[];
  messageTypeRows: IndexRow[];
  statusRows: IndexRow[];
  stateKeyRows: IndexRow[];
  ipcRows: IndexRow[];
  componentBoundaries: ComponentBoundariesReport;
}): Map<string, FileSignalProfile> {
  const profiles = new Map<string, FileSignalProfile>();
  const ensureProfile = (file: string): FileSignalProfile => {
    const current = profiles.get(file);
    if (current) return current;
    const created: FileSignalProfile = {
      contextKeywords: new Set<string>(),
      ast: 0,
      ipcRpc: 0,
      state: 0,
      boundary: 0,
      flow: 0,
      domainScores: {},
      dominantDomain: "unknown",
    };
    profiles.set(file, created);
    return created;
  };

  for (const file of input.jsFiles) {
    if (!isDeobfuscationCandidateFile(file.relPath)) continue;
    ensureProfile(file.relPath);
  }

  const addRows = (rows: IndexRow[], kind: "ast" | "ipcRpc" | "state" | "flow", increment: number): void => {
    for (const row of rows) {
      for (const file of row.files) {
        if (!isDeobfuscationCandidateFile(file)) continue;
        const profile = ensureProfile(file);
        addValueTokens(profile.contextKeywords, row.value, 320);
        if (kind === "ast") profile.ast += increment;
        if (kind === "ipcRpc") profile.ipcRpc += increment;
        if (kind === "state") profile.state += increment;
        if (kind === "flow") profile.flow += increment;
      }
    }
  };

  addRows(input.routeRows, "flow", 2);
  addRows(input.methodRows, "ipcRpc", 2);
  addRows(input.methodRows, "flow", 1);
  addRows(input.messageTypeRows, "ast", 1);
  addRows(input.messageTypeRows, "flow", 1);
  addRows(input.statusRows, "state", 2);
  addRows(input.stateKeyRows, "state", 2);
  addRows(input.ipcRows, "ipcRpc", 3);

  for (const boundary of input.componentBoundaries.boundaries) {
    if (!isDeobfuscationCandidateFile(boundary.ownerFile)) continue;
    const profile = ensureProfile(boundary.ownerFile);
    profile.boundary += 3;
    profile.ast += 2;

    const groups = [
      boundary.referenceHints,
      boundary.componentNames,
      boundary.hookNames,
      boundary.uiIndicators,
      boundary.routes,
      boundary.events,
      boundary.rpcMethods,
      boundary.stateKeys,
      boundary.statuses,
      boundary.ipcChannels,
    ];

    for (const group of groups) {
      for (const value of group) addValueTokens(profile.contextKeywords, value, 360);
    }

    profile.flow += Math.min(5, boundary.routes.length + boundary.events.length);
    profile.ipcRpc += Math.min(5, boundary.rpcMethods.length + boundary.ipcChannels.length);
    profile.state += Math.min(4, boundary.stateKeys.length + boundary.statuses.length);
  }

  return profiles;
}

function getFileSignalScore(profile: FileSignalProfile): number {
  return roundMetric(
    Math.min(3.2, profile.ast * 0.08) +
      Math.min(4.4, profile.ipcRpc * 0.14) +
      Math.min(2.8, profile.state * 0.1) +
      Math.min(2.8, profile.boundary * 0.12) +
      Math.min(2.2, profile.flow * 0.09),
  );
}

function scoreReferenceFileProfile(input: { sourceFile: string; profile: ReferenceFileProfile; fileSignals: FileSignalProfile }): { score: number; hits: string[] } {
  const hits: string[] = [];
  for (const token of input.profile.tokens) {
    if (!input.fileSignals.contextKeywords.has(token)) continue;
    hits.push(token);
  }

  const layer = classifyRuntimeLayer(input.sourceFile);
  let layerBoost = 0;
  if ((layer === "renderer" || layer === "renderer-worker") && input.profile.file.includes("/renderer/")) layerBoost += 1.7;
  if ((layer === "main" || layer === "main-worker") && input.profile.file.includes("/main/")) layerBoost += 1.7;
  if (layer === "preload" && input.profile.file.includes("/preload/")) layerBoost += 1.5;

  const layerMismatchPenalty = getLayerMismatchPenalty(layer, input.profile.file);
  const domain = scoreDomainAlignment(input.fileSignals, input.profile.file);
  const qualityBoost = Math.min(2.4, input.profile.maxScore / 850);
  const sourceBoost = input.profile.source === "1code" ? 0.35 : 0.25;
  const genericPathPenalty = isGenericReferenceFilePath(input.profile.file) ? 2.8 : 0;
  const broadFilePenalty = input.profile.symbolCount > 6 ? Math.min(3.4, (input.profile.symbolCount - 6) * 0.34) : 0;
  const heavyTokenPenalty = input.profile.tokens.size > 85 ? Math.min(1.5, (input.profile.tokens.size - 85) * 0.025) : 0;
  const rustPenalty = /\.rs$/i.test(input.profile.file) ? 0.45 : 0;
  const score =
    hits.length * 1.95 +
    layerBoost +
    domain.boost +
    qualityBoost +
    sourceBoost +
    getFileSignalScore(input.fileSignals) -
    genericPathPenalty -
    broadFilePenalty -
    heavyTokenPenalty -
    layerMismatchPenalty -
    domain.penalty -
    rustPenalty;
  return { score, hits: dedupeKeywords(hits, 12) };
}

function scoreReferenceSymbolMatch(input: {
  sourceFile: string;
  candidate: ObfuscatedSymbolCandidate;
  reference: ReferenceSymbolRow;
  fileSignals: FileSignalProfile;
  anchor?: SourceReferenceAnchor;
}): { score: number; hits: string[] } {
  const scopedKeywords = new Set<string>(input.fileSignals.contextKeywords);
  for (const token of input.candidate.tokens) scopedKeywords.add(token);

  const hits: string[] = [];
  for (const token of input.reference.tokens) {
    if (!scopedKeywords.has(token.toLowerCase())) continue;
    hits.push(token);
  }

  const layer = classifyRuntimeLayer(input.sourceFile);
  let layerBoost = 0;
  if ((layer === "renderer" || layer === "renderer-worker") && input.reference.file.includes("/renderer/")) layerBoost += 1.5;
  if ((layer === "main" || layer === "main-worker") && input.reference.file.includes("/main/")) layerBoost += 1.5;
  if (layer === "preload" && input.reference.file.includes("/preload/")) layerBoost += 1.2;

  const layerMismatchPenalty = getLayerMismatchPenalty(layer, input.reference.file);
  const domain = scoreDomainAlignment(input.fileSignals, input.reference.file);
  const anchorBoost = getAnchorBoost(input.anchor, input.reference.file);
  const symbolKindBoost = input.candidate.kind === input.reference.symbolKind ? 1.7 : 0;
  const qualityBoost = Math.min(2.6, input.reference.score / 700);
  const genericPathPenalty = isGenericReferenceFilePath(input.reference.file) ? 2.1 : 0;
  const genericNamePenalty = /^(run|main|start|stop|kind|usage|header|app|state|data)$/i.test(input.reference.name) ? 2.3 : 0;
  const rustPenalty = /\.rs$/i.test(input.reference.file) ? 0.35 : 0;
  const broadFilePenalty = /(types?|utils?|common|shared|state)/i.test(input.reference.file) ? 0.55 : 0;

  const score =
    hits.length * 1.85 +
    layerBoost +
    domain.boost +
    anchorBoost +
    symbolKindBoost +
    qualityBoost +
    getFileSignalScore(input.fileSignals) +
    Math.min(1.2, input.candidate.tokens.length * 0.25) -
    genericPathPenalty -
    broadFilePenalty -
    genericNamePenalty -
    layerMismatchPenalty -
    domain.penalty -
    rustPenalty;

  return { score, hits: dedupeKeywords(hits, 12) };
}

function getTotalSignalStrength(profile: FileSignalProfile): number {
  return profile.ast + profile.ipcRpc + profile.state + profile.boundary + profile.flow;
}

export function buildDeobfuscationTableMatchV2(input: BuildDeobfuscationTableMatchV2Input): DeobfuscationTableReport {
  const referenceProfile = input.referenceModel.signals;
  const referenceSymbolProfile = input.referenceModel.symbols;

  const fileSignals = buildFileSignalProfiles({
    jsFiles: input.jsFiles,
    routeRows: input.routeRows,
    methodRows: input.methodRows,
    messageTypeRows: input.messageTypeRows,
    statusRows: input.statusRows,
    stateKeyRows: input.stateKeyRows,
    ipcRows: input.ipcRows,
    componentBoundaries: input.componentBoundaries,
  });
  for (const profile of fileSignals.values()) {
    const domain = computeDomainScores(profile.contextKeywords, input.referenceModel.unified.domainKeywords);
    profile.domainScores = domain.domainScores;
    profile.dominantDomain = domain.dominantDomain;
  }

  const symbolsByKind = {
    class: referenceSymbolProfile.symbols.filter((symbol) => symbol.symbolKind === "class"),
    function: referenceSymbolProfile.symbols.filter((symbol) => symbol.symbolKind === "function"),
  };
  const referenceFileProfiles = buildReferenceFileProfiles(referenceSymbolProfile.symbols);
  const sourceReferenceAnchors = computeSourceReferenceAnchors({
    jsFiles: input.jsFiles,
    fileSignals,
    referenceFileProfiles,
  });

  const entries: DeobfuscationTableEntry[] = [];
  const filePlans: DeobfuscationFilePlan[] = [];
  let obfuscatedFileCandidates = 0;
  let obfuscatedSymbolCandidates = 0;

  const seenEntry = new Set<string>();
  const filePlanCountByTargetPath = new Map<string, number>();
  const symbolMatchCountByReference = new Map<string, number>();
  const symbolMatchCountByFile = new Map<string, number>();
  const symbolMatchCountByTargetFile = new Map<string, number>();
  const symbolMatchCountBySourceTarget = new Map<string, number>();
  const symbolTargetByFile = new Set<string>();

  for (const file of input.jsFiles) {
    const relPath = file.relPath;
    if (!isDeobfuscationCandidateFile(relPath)) continue;

    const signal = fileSignals.get(relPath);
    if (!signal) continue;
    if (!isLikelyCoreAppFile(relPath) && signal.contextKeywords.size < 3) continue;
    const sourceAnchor = sourceReferenceAnchors.get(relPath);

    if (isLikelyObfuscatedClassName(path.basename(relPath).split(".")[0]) || /-(?:[A-Za-z0-9]{6,})\.(?:js|mjs|cjs)$/i.test(path.basename(relPath))) {
      obfuscatedFileCandidates += 1;

      let bestFileScore = 0;
      let bestFileHits: string[] = [];
      let bestProfile: ReferenceFileProfile | undefined;
      if (sourceAnchor) {
        for (const profile of referenceFileProfiles) {
          if (profile.file !== sourceAnchor.primaryFile) continue;
          const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
          if (scored.score <= bestFileScore) continue;
          bestFileScore = scored.score;
          bestFileHits = scored.hits;
          bestProfile = profile;
        }
      }
      if (!bestProfile) {
        for (const profile of referenceFileProfiles) {
          const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
          if (scored.score <= bestFileScore) continue;
          bestFileScore = scored.score;
          bestFileHits = scored.hits;
          bestProfile = profile;
        }
      }

      const signalStrength = getTotalSignalStrength(signal);
      let selectedProfile = bestProfile;
      let selectedFileScore = bestFileScore;
      let selectedFileHits = bestFileHits;
      let usedNonGenericFallback = false;
      if (bestProfile && isGenericReferenceFilePath(bestProfile.file)) {
        let fallbackScore = 0;
        let fallbackHits: string[] = [];
        let fallbackProfile: ReferenceFileProfile | undefined;
        for (const profile of referenceFileProfiles) {
          if (isGenericReferenceFilePath(profile.file)) continue;
          const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
          if (scored.score <= fallbackScore) continue;
          fallbackScore = scored.score;
          fallbackHits = scored.hits;
          fallbackProfile = profile;
        }
        const genericGap = bestFileScore - fallbackScore;
        const sourceAnchorsFallback = sourceAnchor ? fallbackProfile?.file === sourceAnchor.primaryFile : false;
        const shouldUseFallback =
          !!fallbackProfile &&
          fallbackScore >= 3.8 &&
          (genericGap <= 3.2 || sourceAnchorsFallback || signalStrength >= 11);
        if (fallbackProfile && shouldUseFallback) {
          selectedProfile = fallbackProfile;
          selectedFileScore = fallbackScore;
          selectedFileHits = fallbackHits;
          usedNonGenericFallback = true;
        }
      }

      const minFileScore = selectedProfile && isGenericReferenceFilePath(selectedProfile.file) ? 7.2 : 4.6;
      const minHits = sourceAnchor ? 1 : usedNonGenericFallback ? 1 : 2;
      const isGenericBestProfile = selectedProfile ? isGenericReferenceFilePath(selectedProfile.file) : false;
      const nonGenericFallbackMinScore = sourceAnchor ? 3.8 : 4.1;
      if (
        selectedProfile &&
        selectedFileScore >= (usedNonGenericFallback ? nonGenericFallbackMinScore : minFileScore) &&
        (selectedFileHits.length >= minHits || signalStrength >= 9) &&
        (!isGenericBestProfile || (selectedFileHits.length >= 4 && signalStrength >= 13))
      ) {
        if (!isGenericBestProfile) {
          const confidenceRaw = Math.min(0.96, roundMetric(0.24 + selectedFileScore / 12.5));
          const targetProjectPath = buildReferenceTargetPath(selectedProfile.file);
          const targetCount = filePlanCountByTargetPath.get(targetProjectPath) ?? 0;
          if (targetCount >= 1) {
            continue;
          }
          const confidence = confidenceRaw;
          const proposedName = path.basename(selectedProfile.file).replace(/\.[^.]+$/, "");
          const rationale = [
            `keyword-overlap: ${selectedFileHits.join(", ") || "none"}`,
            `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
            `dominant-domain: ${signal.dominantDomain}`,
            sourceAnchor ? `source-anchor: ${sourceAnchor.primaryFile} (score=${sourceAnchor.score})` : "source-anchor: none",
            usedNonGenericFallback ? "fallback: controlled-non-generic-second-best" : "fallback: primary-best",
            `reference-file: ${selectedProfile.file}`,
            `match-v2-score: ${roundMetric(selectedFileScore)}`,
          ];

          filePlans.push({ sourceFile: relPath, proposedModulePath: targetProjectPath, confidence, rationale, referenceSource: selectedProfile.source });
          filePlanCountByTargetPath.set(targetProjectPath, targetCount + 1);
          const id = `file|${relPath}|${targetProjectPath}`;
          if (!seenEntry.has(id)) {
            seenEntry.add(id);
            entries.push({
              id,
              kind: "file",
              obfuscated: relPath,
              deobfuscated: proposedName,
              sourceFile: relPath,
              targetProjectPath,
              confidence,
              reference: {
                source: selectedProfile.source,
                symbol: proposedName,
                file: selectedProfile.file,
                kind: "module-file",
                score: selectedProfile.maxScore,
              },
              rationale,
            });
          }
        }
      }
    }

    const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
    if (!source) continue;

    const symbolCandidates = collectObfuscatedSymbolsFromSource({ relPath, source });
    obfuscatedSymbolCandidates += symbolCandidates.length;
    for (const candidate of symbolCandidates) {
      const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
      if (perFileCount >= 16) break;

      const referencePool = symbolsByKind[candidate.kind];
      if (referencePool.length === 0) continue;

      let bestScore = 0;
      let bestHits: string[] = [];
      let bestReference: ReferenceSymbolRow | undefined;

      for (const reference of referencePool) {
        const scored = scoreReferenceSymbolMatch({ sourceFile: relPath, candidate, reference, fileSignals: signal, anchor: sourceAnchor });
        if (scored.score <= bestScore) continue;
        bestScore = scored.score;
        bestHits = scored.hits;
        bestReference = reference;
      }

      if (!bestReference) continue;
      const anchorBoost = getAnchorBoost(sourceAnchor, bestReference.file);
      const hasAnchor = anchorBoost >= 1;
      const anchorFileLabel = sourceAnchor ? sourceAnchor.primaryFile : "none";
      const isGenericReference = isGenericReferenceFilePath(bestReference.file);
      const minScore = isGenericReference ? (hasAnchor ? 6.4 : 6.9) : hasAnchor ? 4.9 : 5.1;
      const minHits = hasAnchor ? 1 : 2;
      const minSignalStrength = hasAnchor ? 8 : 10;
      if (bestScore < minScore || (bestHits.length < minHits && getTotalSignalStrength(signal) < minSignalStrength)) continue;

      const referenceKey = `${bestReference.source}|${bestReference.name}|${bestReference.file}`;
      const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
      const referenceMatchLimit = isGenericReference ? 1 : 2;
      if (matchedCount >= referenceMatchLimit) continue;

      const targetFileMatchCount = symbolMatchCountByTargetFile.get(bestReference.file) ?? 0;
      if (targetFileMatchCount >= 4 && !hasAnchor) continue;

      const sourceTargetKey = `${candidate.sourceFile}|${bestReference.file}`;
      const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
      const sourceTargetLimit = hasAnchor ? 2 : 2;
      if (sourceTargetCount >= sourceTargetLimit) continue;

      const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${bestReference.name}`;
      if (symbolTargetByFile.has(fileTargetKey)) continue;

      const confidence = Math.min(0.95, roundMetric(0.22 + bestScore / 13.2));
      const targetProjectPath = buildReferenceTargetPath(bestReference.file);
      const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${bestReference.name}|${bestReference.file}`;
      if (seenEntry.has(id)) continue;

      seenEntry.add(id);
      symbolTargetByFile.add(fileTargetKey);
      symbolMatchCountByReference.set(referenceKey, matchedCount + 1);
      symbolMatchCountByFile.set(candidate.sourceFile, perFileCount + 1);
      symbolMatchCountByTargetFile.set(bestReference.file, targetFileMatchCount + 1);
      symbolMatchCountBySourceTarget.set(sourceTargetKey, sourceTargetCount + 1);

      entries.push({
        id,
        kind: candidate.kind,
        obfuscated: candidate.name,
        deobfuscated: bestReference.name,
        sourceFile: `${candidate.sourceFile}:${candidate.line}`,
        targetProjectPath,
        confidence,
        reference: {
          source: bestReference.source,
          symbol: bestReference.name,
          file: bestReference.file,
          kind: bestReference.kind,
          score: bestReference.score,
        },
        rationale: [
          `keyword-overlap: ${bestHits.join(", ") || "none"}`,
          `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
          `dominant-domain: ${signal.dominantDomain}`,
          hasAnchor ? `source-anchor: ${anchorFileLabel}` : "source-anchor: none",
          `source-line: ${candidate.line}`,
          `match-v2-score: ${roundMetric(bestScore)}`,
        ],
      });
    }
  }

  entries.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
    return a.obfuscated.localeCompare(b.obfuscated);
  });
  filePlans.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  const maxEntries = Math.max(100, Math.min(520, input.top * 3));
  const maxFilePlans = Math.max(30, Math.min(220, input.top + 20));
  const trimmedEntries = entries.slice(0, maxEntries);
  const trimmedFilePlans = filePlans.slice(0, maxFilePlans);

  return {
    generatedAtUtc: new Date().toISOString(),
    strategy:
      "match-v2 multi-signal mapping: reference-guided file+symbol deobfuscation using AST candidates, IPC/RPC routes, state/status keys, component boundaries, and flow signals.",
    referenceInputs: {
      architectureMapPath: referenceProfile.sourcePath,
      oneCodeSymbolMapPath: referenceSymbolProfile.oneCodePath,
      codexMonitorSymbolMapPath: referenceSymbolProfile.codexMonitorPath,
      loaded: referenceSymbolProfile.loaded,
      warningCount: referenceSymbolProfile.warnings.length,
      symbolCount: referenceSymbolProfile.symbols.length,
    },
    coverage: {
      filesScanned: fileSignals.size,
      obfuscatedFileCandidates,
      obfuscatedSymbolCandidates,
      mappedFiles: trimmedEntries.filter((entry) => entry.kind === "file").length,
      mappedSymbols: trimmedEntries.filter((entry) => entry.kind !== "file").length,
    },
    filePlans: trimmedFilePlans,
    entries: trimmedEntries,
  };
}
