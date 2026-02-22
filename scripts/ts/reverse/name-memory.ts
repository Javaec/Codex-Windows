import * as fs from "node:fs";
import * as path from "node:path";

import type { DeobfuscationTableEntry, DeobfuscationTableReport } from "./match-v2";

const NAME_MEMORY_SCHEMA_VERSION = 1;
const NAME_MEMORY_RELATIVE_PATH = "work/reverse-name-memory.json";

interface NameMemoryEntry {
  key: string;
  kind: "class" | "function" | "variable";
  sourceFile: string;
  obfuscated: string;
  deobfuscated: string;
  targetProjectPath: string;
  confidence: number;
  referenceSource: DeobfuscationTableEntry["reference"]["source"];
  referenceFile: string;
  referenceScore: number;
  seenCount: number;
  updatedAtUtc: string;
}

interface NameMemoryStore {
  schemaVersion: number;
  updatedAtUtc: string;
  byApp: Record<string, Record<string, NameMemoryEntry>>;
}

export interface ApplyNameMemoryInput {
  repoRoot: string;
  appKey: string;
  deobfuscationTable: DeobfuscationTableReport;
}

export interface ApplyNameMemoryResult {
  memoryPath: string;
  appKey: string;
  tracked: number;
  applied: number;
  renamed: number;
  deduplicated: number;
  deobfuscationTable: DeobfuscationTableReport;
}

export interface PersistNameMemoryInput {
  repoRoot: string;
  appKey: string;
  deobfuscationTable: DeobfuscationTableReport;
}

export interface PersistNameMemoryResult {
  memoryPath: string;
  appKey: string;
  totalTracked: number;
  added: number;
  updated: number;
  renamed: number;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function getMemoryPath(repoRoot: string): string {
  return path.resolve(repoRoot, NAME_MEMORY_RELATIVE_PATH);
}

function createDefaultStore(): NameMemoryStore {
  return {
    schemaVersion: NAME_MEMORY_SCHEMA_VERSION,
    updatedAtUtc: new Date().toISOString(),
    byApp: {},
  };
}

function readStore(filePath: string): NameMemoryStore {
  if (!fs.existsSync(filePath)) return createDefaultStore();
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<NameMemoryStore>;
  if (parsed.schemaVersion !== NAME_MEMORY_SCHEMA_VERSION || typeof parsed.byApp !== "object" || !parsed.byApp) {
    return createDefaultStore();
  }
  return {
    schemaVersion: NAME_MEMORY_SCHEMA_VERSION,
    updatedAtUtc: typeof parsed.updatedAtUtc === "string" ? parsed.updatedAtUtc : new Date().toISOString(),
    byApp: parsed.byApp as Record<string, Record<string, NameMemoryEntry>>,
  };
}

function writeStore(filePath: string, store: NameMemoryStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function normalizeSourceFile(value: string): string {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) return value;
  return value.slice(0, separatorIndex);
}

function extractSourceLine(value: string): number {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0) return 0;
  const parsed = Number(value.slice(separatorIndex + 1));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function makeSymbolKey(entry: DeobfuscationTableEntry): string {
  return `${entry.kind}|${normalizeSourceFile(entry.sourceFile)}|${entry.obfuscated}`;
}

function toPascalCase(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
  if (parts.length === 0) return "";
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  if (pascal.length === 0) return "";
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function splitTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

function isNoisyNameToken(token: string): boolean {
  if (token.length <= 1) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^v\d+$/i.test(token)) return true;
  if (/^ref\d*$/i.test(token)) return true;
  if (/^bs\d+$/i.test(token)) return true;
  if (/^(src|chunk|chunks|asset|assets|auto\d*|renderer\d*|main\d*|services\d*|tauri\d*|domain|symbol|module)$/i.test(token)) return true;
  return false;
}

function inferLayerFromReference(file: string): "main" | "renderer" | "services" | "tauri" | "domain" {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("src/main/")) return "main";
  if (normalized.startsWith("src/renderer/") || normalized.startsWith("src/features/") || normalized.startsWith("src/components/")) {
    return "renderer";
  }
  if (normalized.startsWith("src/services/") || normalized.startsWith("src/lib/") || normalized.startsWith("src/state/")) return "services";
  if (normalized.startsWith("src-tauri/src/")) return "tauri";
  return "domain";
}

function sanitizeSymbolName(input: {
  name: string;
  kind: "class" | "function" | "variable";
  referenceFile: string;
}): string {
  const referenceTokens = splitTokens(input.referenceFile.replace(/\.[^.]+$/, ""));
  const rawTokens = [...splitTokens(input.name), ...referenceTokens];
  const filtered = rawTokens.filter((token) => !isNoisyNameToken(token));
  const unique: string[] = [];
  for (const token of filtered) {
    if (unique.includes(token)) continue;
    unique.push(token);
    if (unique.length >= 4) break;
  }

  const layer = inferLayerFromReference(input.referenceFile);
  const layerToken = layer === "domain" ? "domain" : layer;
  if (unique.length === 0) unique.push(layerToken);
  if (!unique.includes(layerToken)) unique.push(layerToken);

  const joined = unique.join(" ");
  if (input.kind === "class") {
    const next = toPascalCase(joined);
    return next.length > 0 ? next : "DomainSymbol";
  }
  const next = toCamelCase(joined);
  return next.length > 0 ? next : "domainValue";
}

function buildDedupeName(input: {
  entry: DeobfuscationTableEntry;
  usedNames: Set<string>;
}): string {
  if (input.entry.kind === "file") return input.entry.deobfuscated;
  const sourceLine = extractSourceLine(input.entry.sourceFile);
  const sourceFile = normalizeSourceFile(input.entry.sourceFile).replace(/\.[^.]+$/, "");
  const referenceFile = input.entry.reference.file.replace(/\.[^.]+$/, "");
  const targetFile = input.entry.targetProjectPath.replace(/\.[^.]+$/, "");
  const obfuscatedTokens = splitTokens(input.entry.obfuscated).filter((token) => !isNoisyNameToken(token));

  const toIdentifier = input.entry.kind === "class" ? toPascalCase : toCamelCase;
  const fallback = input.entry.kind === "class" ? "DomainSymbol" : "domainValue";

  const toName = (tokens: string[]): string => {
    const joined = tokens.join(" ");
    return toIdentifier(joined) || toIdentifier(input.entry.deobfuscated) || fallback;
  };

  const seedTokens = [
    ...splitTokens(input.entry.deobfuscated),
    ...splitTokens(sourceFile),
    ...splitTokens(referenceFile),
    ...splitTokens(targetFile),
  ];
  const uniqueTokens: string[] = [];
  for (const token of seedTokens) {
    if (isNoisyNameToken(token)) continue;
    if (uniqueTokens.includes(token)) continue;
    uniqueTokens.push(token);
    if (uniqueTokens.length >= 8) break;
  }

  const layerToken = inferLayerFromReference(input.entry.reference.file);
  if (layerToken !== "domain" && !uniqueTokens.includes(layerToken)) {
    uniqueTokens.push(layerToken);
  }
  if (uniqueTokens.length === 0) uniqueTokens.push("domain");

  const baseName = toName(uniqueTokens);
  if (!input.usedNames.has(baseName)) return baseName;

  if (obfuscatedTokens.length > 0) {
    const withObfuscated = toName([...uniqueTokens, obfuscatedTokens[0]!]);
    if (!input.usedNames.has(withObfuscated)) return withObfuscated;
  }
  if (sourceLine > 0) {
    const withLine = toName([...uniqueTokens, `line${sourceLine}`]);
    if (!input.usedNames.has(withLine)) return withLine;
  }
  if (obfuscatedTokens.length > 0 && sourceLine > 0) {
    const withBoth = toName([...uniqueTokens, obfuscatedTokens[0]!, `line${sourceLine}`]);
    if (!input.usedNames.has(withBoth)) return withBoth;
  }

  let nextName = baseName;
  let suffix = 2;
  while (input.usedNames.has(nextName) && suffix < 5000) {
    nextName = `${baseName}N${suffix}`;
    suffix += 1;
  }
  return nextName;
}

function dedupeNames(report: DeobfuscationTableReport): number {
  const symbolEntries = report.entries.filter((entry) => entry.kind !== "file");
  const grouped = new Map<string, DeobfuscationTableEntry[]>();
  const usedNamesByScope = new Map<string, Set<string>>();
  for (const entry of symbolEntries) {
    const scopeKey = `${entry.kind}|${entry.targetProjectPath}`;
    const namesInScope = usedNamesByScope.get(scopeKey) ?? new Set<string>();
    namesInScope.add(entry.deobfuscated);
    usedNamesByScope.set(scopeKey, namesInScope);

    const groupedKey = `${scopeKey}|${entry.deobfuscated}`;
    const rows = grouped.get(groupedKey) ?? [];
    rows.push(entry);
    grouped.set(groupedKey, rows);
  }

  let renamed = 0;
  for (const rows of grouped.values()) {
    if (rows.length <= 1) continue;
    const first = rows[0];
    if (!first) continue;
    const scopeKey = `${first.kind}|${first.targetProjectPath}`;
    const usedNames = usedNamesByScope.get(scopeKey) ?? new Set<string>();

    rows.sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return b.reference.score - a.reference.score;
    });
    for (let index = 1; index < rows.length; index += 1) {
      const entry = rows[index];
      if (!entry) continue;
      if (entry.kind === "file") continue;
      usedNames.delete(entry.deobfuscated);
      const nextName = buildDedupeName({
        entry,
        usedNames,
      });
      if (entry.deobfuscated === nextName) {
        usedNames.add(nextName);
        continue;
      }
      entry.deobfuscated = nextName;
      usedNames.add(nextName);
      entry.rationale = [...entry.rationale, "name-memory: deduplicated-after-apply"];
      renamed += 1;
    }
  }
  return renamed;
}

function cloneReport(report: DeobfuscationTableReport): DeobfuscationTableReport {
  return {
    ...report,
    filePlans: report.filePlans.map((row) => ({
      ...row,
      rationale: [...row.rationale],
    })),
    entries: report.entries.map((entry) => ({
      ...entry,
      reference: {
        ...entry.reference,
      },
      rationale: [...entry.rationale],
    })),
  };
}

function toMemoryEntry(entry: DeobfuscationTableEntry, key: string): NameMemoryEntry {
  if (entry.kind !== "class" && entry.kind !== "function" && entry.kind !== "variable") {
    throw new Error(`Unsupported memory entry kind: ${entry.kind}`);
  }
  return {
    key,
    kind: entry.kind,
    sourceFile: normalizeSourceFile(entry.sourceFile),
    obfuscated: entry.obfuscated,
    deobfuscated: entry.deobfuscated,
    targetProjectPath: entry.targetProjectPath,
    confidence: entry.confidence,
    referenceSource: entry.reference.source,
    referenceFile: entry.reference.file,
    referenceScore: entry.reference.score,
    seenCount: 1,
    updatedAtUtc: new Date().toISOString(),
  };
}

function isCandidateBetter(candidate: NameMemoryEntry, current: NameMemoryEntry): boolean {
  if (candidate.confidence > current.confidence + 0.015) return true;
  if (candidate.referenceScore > current.referenceScore + 0.25) return true;
  if (candidate.referenceScore > current.referenceScore && candidate.confidence >= current.confidence - 0.02) return true;
  return false;
}

function selectBestCurrentEntries(report: DeobfuscationTableReport): Map<string, DeobfuscationTableEntry> {
  const selected = new Map<string, DeobfuscationTableEntry>();
  for (const entry of report.entries) {
    if (entry.kind === "file") continue;
    const key = makeSymbolKey(entry);
    const current = selected.get(key);
    if (!current) {
      selected.set(key, entry);
      continue;
    }
    if (entry.confidence > current.confidence) {
      selected.set(key, entry);
      continue;
    }
    if (entry.confidence === current.confidence && entry.reference.score > current.reference.score) {
      selected.set(key, entry);
    }
  }
  return selected;
}

export function persistNameMemory(input: PersistNameMemoryInput): PersistNameMemoryResult {
  const memoryPath = getMemoryPath(input.repoRoot);
  const store = readStore(memoryPath);
  const appMemory = store.byApp[input.appKey] ?? {};
  const bestEntries = selectBestCurrentEntries(input.deobfuscationTable);

  let added = 0;
  let updated = 0;
  let renamed = 0;

  for (const [key, entry] of bestEntries.entries()) {
    const candidate = toMemoryEntry(entry, key);
    const current = appMemory[key];
    if (!current) {
      appMemory[key] = candidate;
      added += 1;
      continue;
    }
    if (!isCandidateBetter(candidate, current)) {
      current.seenCount += 1;
      current.updatedAtUtc = new Date().toISOString();
      continue;
    }
    if (current.deobfuscated !== candidate.deobfuscated) renamed += 1;
    appMemory[key] = {
      ...candidate,
      seenCount: current.seenCount + 1,
    };
    updated += 1;
  }

  store.byApp[input.appKey] = appMemory;
  store.updatedAtUtc = new Date().toISOString();
  writeStore(memoryPath, store);

  return {
    memoryPath: toPosixPath(memoryPath),
    appKey: input.appKey,
    totalTracked: Object.keys(appMemory).length,
    added,
    updated,
    renamed,
  };
}

export function applyNameMemory(input: ApplyNameMemoryInput): ApplyNameMemoryResult {
  const memoryPath = getMemoryPath(input.repoRoot);
  const store = readStore(memoryPath);
  const appMemory = store.byApp[input.appKey] ?? {};
  const nextReport = cloneReport(input.deobfuscationTable);

  let applied = 0;
  let renamed = 0;
  for (const entry of nextReport.entries) {
    if (entry.kind === "file") continue;
    const key = makeSymbolKey(entry);
    const remembered = appMemory[key];
    if (!remembered) continue;

    const memoryWinsByConfidence = remembered.confidence >= entry.confidence + 0.02;
    const memoryWinsByReference =
      remembered.referenceScore >= entry.reference.score + 0.35 &&
      remembered.confidence >= entry.confidence - 0.03;
    if (!memoryWinsByConfidence && !memoryWinsByReference) continue;

    const previousName = entry.deobfuscated;
    entry.deobfuscated = remembered.deobfuscated;
    entry.targetProjectPath = remembered.targetProjectPath;
    entry.reference = {
      source: remembered.referenceSource,
      symbol: remembered.deobfuscated,
      file: remembered.referenceFile,
      kind: entry.reference.kind,
      score: Math.max(entry.reference.score, remembered.referenceScore),
    };
    entry.confidence = Math.max(entry.confidence, remembered.confidence);
    entry.rationale = [...entry.rationale, "name-memory: upgraded-from-higher-confidence-history"];
    applied += 1;
    if (previousName !== entry.deobfuscated) renamed += 1;
  }

  for (const entry of nextReport.entries) {
    if (entry.kind === "file") continue;
    const nextName = sanitizeSymbolName({
      name: entry.deobfuscated,
      kind: entry.kind,
      referenceFile: entry.reference.file,
    });
    if (nextName !== entry.deobfuscated) {
      entry.deobfuscated = nextName;
      entry.rationale = [...entry.rationale, "name-memory: sanitized-name"];
    }
  }
  const deduplicated = dedupeNames(nextReport);

  return {
    memoryPath: toPosixPath(memoryPath),
    appKey: input.appKey,
    tracked: Object.keys(appMemory).length,
    applied,
    renamed,
    deduplicated,
    deobfuscationTable: nextReport,
  };
}
