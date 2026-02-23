import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { ensureDir, removePath } from "../lib/exec";
import { normalizeDeobfSourceFile, toProjectRelativeTargetPath } from "./deobfuscation-report";
import type { DeobfuscationTableReport } from "./match-v2";
import {
  inspectLiftDeclarationGraph,
  inspectLiftSourceDeclarations,
  type LiftDeclarationGraphNode,
  type LiftDeclarationStat,
  type LiftedExportKind,
} from "./symbol-lifter";
import { buildSemanticIrFromDeobfuscationTable, type SemanticIrModule } from "./semantic-ir";
import { resolveSemanticOwnership } from "./ownership-resolver";
import { buildModuleSynthesisContract, type ModuleArchetype } from "./module-templates";
import { applyArchetypeAndCluster } from "./declaration-clustering";
import { emitArchetypeModule } from "./archetype-emitter";

export interface WebStormTestProjectReport {
  rootPath: string;
  chunkFiles: number;
  reconstructedFiles: number;
  mappedTargets: number;
  mappingArtifacts: string[];
  checks: {
    install: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      durationMs: number;
      outputPreview: string[];
    };
    tsc: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      errors: number;
      warnings: number;
      outputPreview: string[];
    };
    eslint: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      errors: number;
      warnings: number;
      outputPreview: string[];
      skippedReason: string;
    };
  };
}

export interface BuildWebStormTestProjectInput {
  outDir: string;
  appDir: string;
  decompiledDir: string;
  sourcePackage: { name?: string; version?: string; main?: string };
  deobfuscationTable: DeobfuscationTableReport;
  deobfuscationMarkdown: string;
  deobfuscationCsv: string;
  renamePlanMarkdown: string;
  componentBoundaries: unknown;
  sessionFlow: unknown;
  sessionFlowMarkdown: string;
  routeBoundaryGraph: unknown;
  referenceParityGaps: unknown;
  runtimeProbe: unknown;
  referenceModel: unknown;
  referenceSignals: unknown;
  referenceSymbols: unknown;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSourceForPrint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}

function parseSourceLineHint(value: string): number {
  const match = value.match(/:(\d+)$/);
  if (!match) return 0;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function toChunkArtifactPath(sourceFile: string): string {
  const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
  return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}

function normalizeTargetModulePath(targetPath: string): string {
  const normalized = toPosixPath(targetPath).replace(/^\.?\//, "");
  return normalized.replace(/\.(?:tsx?|jsx|mjs|cjs|js)$/i, ".ts");
}

function toModuleSpecifier(fromDirectory: string, targetFilePath: string): string {
  const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
  const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
  const relative = path.posix.relative(from, target);
  const normalized = relative.startsWith(".") ? relative : `./${relative}`;
  return normalized;
}

function toRelativePathSpecifier(fromDirectory: string, targetFilePath: string): string {
  const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
  const target = toPosixPath(targetFilePath).replace(/^\.?\//, "");
  const relative = path.posix.relative(from, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function resolveChunkArtifactImportSpecifier(input: {
  specifier: string;
  sourceFile: string;
  emittedPath: string;
}): string | undefined {
  if (!/^(?:\.{1,2})\//.test(input.specifier)) return undefined;
  if (!/\.(?:mjs|cjs|js)$/i.test(input.specifier)) return undefined;
  const sourceDir = path.posix.dirname(toPosixPath(input.sourceFile).replace(/^\.?\//, ""));
  const resolvedSource = path.posix.normalize(path.posix.join(sourceDir, input.specifier));
  if (resolvedSource.startsWith("../")) return undefined;
  const chunkArtifact = toPosixPath(path.posix.join("src", "chunks", toChunkArtifactPath(resolvedSource)));
  const emittedDirectory = path.posix.dirname(toPosixPath(input.emittedPath).replace(/^\.?\//, ""));
  return toRelativePathSpecifier(emittedDirectory, chunkArtifact);
}

function rewriteChunkLocalImportSpecifiers(input: {
  moduleBody: string;
  sourceFile: string;
  emittedPath: string;
}): { moduleBody: string; rewrites: number } {
  let rewrites = 0;
  const rewriteSpecifier = (raw: string): string => {
    const next = resolveChunkArtifactImportSpecifier({
      specifier: raw,
      sourceFile: input.sourceFile,
      emittedPath: input.emittedPath,
    });
    if (!next || next === raw) return raw;
    rewrites += 1;
    return next;
  };

  const rewriteLine = (line: string): string => {
    let nextLine = line;
    nextLine = nextLine.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `from ${quote}${rewritten}${quote}`;
    });
    nextLine = nextLine.replace(/\bimport\s+(['"])([^'"]+)\1/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `import ${quote}${rewritten}${quote}`;
    });
    nextLine = nextLine.replace(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `require(${quote}${rewritten}${quote})`;
    });
    return nextLine;
  };

  const lines = input.moduleBody.split("\n");
  const rewrittenLines = lines.map((line) => rewriteLine(line));
  return {
    moduleBody: rewrittenLines.join("\n"),
    rewrites,
  };
}

function collectBarrelRootsForDirectory(inputDir: string): string[] {
  const directory = toPosixPath(inputDir).replace(/^\.?\//, "");
  const roots = ["src/main", "src/renderer", "src/services", "src-tauri-adapter"];
  if (roots.includes(directory)) return [directory];
  return roots.filter((root) => directory.startsWith(`${root}/`));
}

function toBarrelNamespaceName(input: string): string {
  const tokens = splitIdentifierTokens(input)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0 && !isNoisyIdentifierToken(token));
  const raw = buildIdentifierFromTokens(tokens.length > 0 ? tokens : [input], false);
  const sanitized = toSafeExportIdentifier(raw.length > 0 ? raw : input);
  if (sanitized === "symbol_export") return "moduleNs";
  return sanitized;
}

function buildLayerBarrelIndexes(projectRoot: string, emittedModulePaths: string[]): string[] {
  const modulePaths = emittedModulePaths
    .map((item) => toPosixPath(item).replace(/^\.?\//, ""))
    .filter((item) => item.endsWith(".ts") && !item.endsWith("/index.ts"));

  if (modulePaths.length === 0) return [];

  const directoryModules = new Map<string, Set<string>>();
  const allDirectories = new Set<string>();

  for (const modulePath of modulePaths) {
    const moduleDirectory = path.posix.dirname(modulePath);
    const moduleName = path.posix.basename(modulePath, ".ts");
    const moduleBucket = directoryModules.get(moduleDirectory) ?? new Set<string>();
    moduleBucket.add(moduleName);
    directoryModules.set(moduleDirectory, moduleBucket);

    const applicableRoots = collectBarrelRootsForDirectory(moduleDirectory);
    for (const root of applicableRoots) {
      let cursor = moduleDirectory;
      while (true) {
        allDirectories.add(cursor);
        if (cursor === root) break;
        const parent = path.posix.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
  }

  const createdIndexes: string[] = [];
  const sortedDirectories = Array.from(allDirectories).sort(
    (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
  );

  for (const directory of sortedDirectories) {
    const files = Array.from(directoryModules.get(directory) ?? []).sort((a, b) => a.localeCompare(b));
    const childDirectories = Array.from(allDirectories)
      .filter((item) => path.posix.dirname(item) === directory)
      .sort((a, b) => a.localeCompare(b));

    const lines: string[] = [];
    const usedAliases = new Set<string>();
    const nextAlias = (seed: string): string => {
      const baseAlias = toBarrelNamespaceName(seed);
      let alias = baseAlias;
      let suffix = 2;
      while (usedAliases.has(alias)) {
        alias = `${baseAlias}${suffix}`;
        suffix += 1;
      }
      usedAliases.add(alias);
      return alias;
    };
    for (const fileName of files) {
      const alias = nextAlias(fileName);
      lines.push(`export * as ${alias} from "${toModuleSpecifier(directory, path.posix.join(directory, `${fileName}.ts`))}";`);
    }
    for (const childDirectory of childDirectories) {
      const alias = nextAlias(path.posix.basename(childDirectory));
      lines.push(`export * as ${alias} from "${toModuleSpecifier(directory, path.posix.join(childDirectory, "index.ts"))}";`);
    }
    if (lines.length === 0) continue;

    const indexPath = path.join(projectRoot, ...directory.split("/"), "index.ts");
    ensureDir(path.dirname(indexPath));
    fs.writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
    createdIndexes.push(toPosixPath(path.posix.join(directory, "index.ts")));
  }
  return createdIndexes.sort((a, b) => a.localeCompare(b));
}

function toSafeExportIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) return normalized;
  return "symbol_export";
}

const NOISY_IDENTIFIER_SUFFIXES = new Set<string>([
  "abap",
  "ada",
  "apl",
  "applescript",
  "arc",
  "asm",
  "asciidoc",
  "astro",
  "awk",
  "bash",
  "bicep",
  "bsl",
  "c",
  "clojure",
  "cobol",
  "coffee",
  "cpp",
  "csharp",
  "css",
  "csv",
  "dart",
  "diff",
  "docker",
  "elixir",
  "elm",
  "erb",
  "erlang",
  "fortran",
  "fsharp",
  "gdresource",
  "gdscript",
  "gdshader",
  "glsl",
  "go",
  "graphql",
  "groovy",
  "haml",
  "handlebars",
  "haskell",
  "haxe",
  "hlsl",
  "html",
  "http",
  "hurl",
  "java",
  "javascript",
  "jinja",
  "jison",
  "json",
  "jsx",
  "julia",
  "kotlin",
  "latex",
  "less",
  "liquid",
  "lua",
  "markdown",
  "md",
  "nginx",
  "nim",
  "objc",
  "perl",
  "php",
  "postcss",
  "pug",
  "python",
  "qml",
  "r",
  "razor",
  "regexp",
  "rst",
  "ruby",
  "rust",
  "sass",
  "scala",
  "scss",
  "shaderlab",
  "shell",
  "shellscript",
  "sql",
  "stata",
  "stylus",
  "svelte",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "twig",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

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

function isNoisyIdentifierToken(token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (NOISY_IDENTIFIER_SUFFIXES.has(normalized)) return true;
  if (/^v\d{1,4}$/i.test(normalized)) return true;
  if (/^(?:renderer|worker|assets|chunk|main|services|tauri|src)\d{1,4}$/i.test(normalized)) return true;
  if (/^[a-z]{1,4}\d{1,6}[a-z0-9]*$/i.test(normalized)) return true;
  if (/^\d+[a-z0-9]+$/i.test(normalized)) return true;
  if (normalized.length >= 6 && /\d/.test(normalized) && !/[aeiou]/i.test(normalized)) return true;
  return false;
}

function buildIdentifierFromTokens(tokens: string[], preferPascalCase: boolean): string {
  const cleaned = tokens
    .map((token) => token.replace(/[^A-Za-z0-9_$]/g, ""))
    .filter((token) => token.length > 0);
  if (cleaned.length === 0) return "";
  const pascal = cleaned
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join("");
  if (preferPascalCase) return pascal;
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function stripNoisyExportSuffix(input: string): string {
  const tokens = splitIdentifierTokens(input);
  if (tokens.length <= 1) return input;

  let end = tokens.length;
  while (end > 1 && isNoisyIdentifierToken(tokens[end - 1] ?? "")) {
    end -= 1;
  }
  if (end === tokens.length) return input;

  const preferPascalCase = /^[A-Z]/.test(input);
  const rebuilt = buildIdentifierFromTokens(tokens.slice(0, end), preferPascalCase);
  if (rebuilt.length < 3) return input;
  return rebuilt;
}

function sanitizeExportIdentifierName(input: string): string {
  const stripped = stripNoisyExportSuffix(input);
  const preferred = toSafeExportIdentifier(stripped);
  if (preferred !== "symbol_export") return preferred;
  return toSafeExportIdentifier(input);
}

function toRecoveryModuleBaseName(input: string): string {
  const tokens = splitIdentifierTokens(input)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !isNoisyIdentifierToken(token));
  if (tokens.length === 0) return "moduleRuntime";
  if (tokens[0] === "use" && tokens.length > 1) {
    return sanitizeExportIdentifierName(`use${buildIdentifierFromTokens(tokens.slice(1), true)}`);
  }
  return sanitizeExportIdentifierName(buildIdentifierFromTokens(tokens, false));
}

type RankedExportRow = {
  name: string;
  sourceSymbol: string;
  kind: LiftedExportKind;
  sourceLine: number;
  confidence: number;
  declarationLength: number;
  hasDeclaration: boolean;
  nameQuality: number;
  generatedSignal: number;
};

interface TargetSymbolEntry {
  targetPath: string;
  sourceFile: string;
  exportName: string;
  sourceSymbol: string;
  kind: LiftedExportKind;
  sourceLine: number;
  confidence: number;
}

function getExportKindPriority(kind: LiftedExportKind): number {
  if (kind === "class") return 400;
  if (kind === "function") return 300;
  return 100;
}

const GLOBAL_BUILTIN_SYMBOLS = new Set<string>([
  "array",
  "asyncfunction",
  "bigint",
  "boolean",
  "date",
  "error",
  "event",
  "function",
  "map",
  "math",
  "mutationobserver",
  "number",
  "object",
  "promise",
  "regexp",
  "set",
  "string",
  "symbol",
  "typeerror",
  "worker",
  "weakmap",
  "weakset",
]);

function isGlobalBuiltinSymbol(value: string): boolean {
  return GLOBAL_BUILTIN_SYMBOLS.has(value.trim().toLowerCase());
}

function isParserRegistryChunkSource(sourceChunk: string): boolean {
  if (sourceChunk.length < 1200) return false;
  const normalized = sourceChunk.toLowerCase();
  return (
    normalized.includes("symbols_:") ||
    normalized.includes("terminals_:") ||
    normalized.includes("productions_:") ||
    normalized.includes("performaction") ||
    normalized.includes("rules: [") ||
    normalized.includes("conditions: {")
  );
}

function isParserRegistryDeclaration(stat: LiftDeclarationStat, sourceChunk: string): boolean {
  if (stat.generatedSignal < 0.75) return false;
  if (stat.statementLength < 4200) return false;
  return isParserRegistryChunkSource(sourceChunk);
}

function filterOwnedExportRows(rows: RankedExportRow[]): RankedExportRow[] {
  const deduped = new Map<string, RankedExportRow>();
  for (const row of rows) {
    if (!row.hasDeclaration) continue;
    if (isGlobalBuiltinSymbol(row.sourceSymbol)) continue;
    const key = `${row.sourceSymbol}|${row.kind}`;
    const current = deduped.get(key);
    if (!current || computeSelectionScore(row) > computeSelectionScore(current)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => {
    const scoreDelta = computeSelectionScore(b) - computeSelectionScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.nameQuality !== b.nameQuality) return b.nameQuality - a.nameQuality;
    if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
    if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
    return a.name.localeCompare(b.name);
  });
}

function groupTargetEntriesBySourceFile(entries: TargetSymbolEntry[]): Map<string, TargetSymbolEntry[]> {
  const grouped = new Map<string, TargetSymbolEntry[]>();
  for (const entry of entries) {
    const sourceFile = normalizeDeobfSourceFile(entry.sourceFile);
    if (sourceFile.length === 0) continue;
    const bucket = grouped.get(sourceFile) ?? [];
    bucket.push(entry);
    grouped.set(sourceFile, bucket);
  }
  return grouped;
}

function rankSourceFileCandidates(
  entriesBySourceFile: Map<string, TargetSymbolEntry[]>,
  preferredSourceFile: string,
): string[] {
  const preferred = normalizeDeobfSourceFile(preferredSourceFile);
  return Array.from(entriesBySourceFile.entries())
    .map(([sourceFile, entries]) => {
      let maxConfidence = 0;
      let callableCount = 0;
      const uniqueSymbols = new Set<string>();
      for (const entry of entries) {
        if (entry.confidence > maxConfidence) maxConfidence = entry.confidence;
        if (entry.kind === "class" || entry.kind === "function") callableCount += 1;
        uniqueSymbols.add(entry.sourceSymbol);
      }
      const preferredBoost = sourceFile === preferred ? 18 : 0;
      const score = preferredBoost + maxConfidence * 100 + callableCount * 3 + Math.min(16, uniqueSymbols.size);
      return { sourceFile, score };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.sourceFile.localeCompare(b.sourceFile);
    })
    .map((row) => row.sourceFile);
}

function isNoisyGeneratedExportName(input: string): boolean {
  if (/(renderer\d+$|main\d+$|services\d+$|tauri\d+$|var[a-z0-9_]+$|assets\d+$|src\d+$)/i.test(input)) {
    return true;
  }
  const stripped = stripNoisyExportSuffix(input);
  if (stripped !== input) return true;
  const tokens = splitIdentifierTokens(input);
  const tail = tokens[tokens.length - 1] ?? "";
  if (isNoisyIdentifierToken(tail)) return true;
  return /[A-Za-z]{2,}\d{2,}$/i.test(input);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function scoreExportNameQuality(input: string): number {
  let score = 1;
  if (isNoisyGeneratedExportName(input)) score -= 0.45;
  if (stripNoisyExportSuffix(input) !== input) score -= 0.2;
  if (/V\d{2,}$/i.test(input)) score -= 0.4;
  if (/\d{3,}$/i.test(input)) score -= 0.35;
  if (/(?:^|_)(tmp|temp|var|misc|unknown|value|data)$/i.test(input)) score -= 0.2;
  if (/^[a-z]{1,2}$/i.test(input)) score -= 0.3;
  if (/(?:[A-Z][a-z]+){1,}V\d{2,}/.test(input)) score -= 0.1;
  return clamp01(score);
}

const MODULE_CONTEXT_STOPWORDS = new Set<string>([
  "src",
  "main",
  "renderer",
  "services",
  "feature",
  "features",
  "lib",
  "utils",
  "hooks",
  "components",
  "component",
  "adapter",
  "providers",
  "provider",
  "pages",
  "page",
  "module",
  "index",
  "common",
  "shared",
  "core",
]);

const LOW_SIGNAL_BUILTIN_NAME_TOKENS = new Set<string>(["math", "regexp", "array", "string", "number", "error"]);
const UTILITY_WRAPPER_NAME_PATTERN = /(hasownproperty|getprototypeof|defineproperty|prototype|getownpropertynames)/;
const HOOK_SIGNAL_NAME_PATTERN = /(inline|stream|signal|subject|getownpropertynames)/;

function collectModuleContextTokens(emittedPath: string): string[] {
  const normalized = toPosixPath(emittedPath).replace(/^\.?\//, "").replace(/\.[^.]+$/i, "");
  const parts = normalized.split("/");
  const windowedParts = parts.slice(Math.max(0, parts.length - 4));
  const tokens: string[] = [];
  for (const part of windowedParts) {
    for (const token of splitIdentifierTokens(part)) {
      const normalizedToken = token.toLowerCase();
      if (normalizedToken.length < 3) continue;
      if (MODULE_CONTEXT_STOPWORDS.has(normalizedToken)) continue;
      if (isNoisyIdentifierToken(normalizedToken)) continue;
      tokens.push(normalizedToken);
    }
  }
  return Array.from(new Set(tokens));
}

function scoreModulePathAlignment(name: string, emittedPath: string): number {
  const moduleTokens = collectModuleContextTokens(emittedPath);
  if (moduleTokens.length === 0) return 0;
  const moduleSet = new Set(moduleTokens);
  const nameTokens = splitIdentifierTokens(name)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !isNoisyIdentifierToken(token));
  if (nameTokens.length === 0) return 0;

  let directHits = 0;
  let partialHits = 0;
  for (const token of nameTokens) {
    if (moduleSet.has(token)) {
      directHits += 1;
      continue;
    }
    const hasPartial = moduleTokens.some((moduleToken) => moduleToken.startsWith(token) || token.startsWith(moduleToken));
    if (hasPartial) partialHits += 1;
  }

  const moduleStem = path.posix.basename(toPosixPath(emittedPath), path.posix.extname(toPosixPath(emittedPath))).toLowerCase();
  const exactStemBonus = moduleStem === name.toLowerCase() ? 1.8 : 0;
  return directHits + partialHits * 0.35 + exactStemBonus;
}

function scoreContextualExportNameQuality(name: string, emittedPath: string): number {
  const tokens = splitIdentifierTokens(name)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
  let score = scoreExportNameQuality(name);
  if (tokens.length === 0) return score;

  const startsWithHookPrefix = /^use[A-Z]/.test(name);
  if (/Use$/.test(name) && !startsWithHookPrefix) {
    score -= 0.22;
  }

  const builtinTokenCount = tokens.filter((token) => isGlobalBuiltinSymbol(token)).length;
  if (builtinTokenCount > 0) {
    const builtinRatio = builtinTokenCount / tokens.length;
    if (builtinRatio >= 0.5) score -= 0.32;
    else if (builtinRatio >= 0.35) score -= 0.22;
    else score -= 0.1;
  }

  const alignmentScore = scoreModulePathAlignment(name, emittedPath);
  const moduleTokens = collectModuleContextTokens(emittedPath);
  if (moduleTokens.length > 0 && alignmentScore < 0.4) {
    score -= 0.22;
  }
  if (moduleTokens.length > 0 && alignmentScore < 0.2) {
    score -= 0.12;
  }

  const hasLowSignalGenericTokens = tokens.some((token) => LOW_SIGNAL_BUILTIN_NAME_TOKENS.has(token));
  if (hasLowSignalGenericTokens && alignmentScore < 0.5) {
    score -= 0.14;
  }
  const hasUtilityPrototypeTokens = tokens.some((token) => UTILITY_WRAPPER_NAME_PATTERN.test(token));
  if (hasUtilityPrototypeTokens && moduleTokens.length > 0 && alignmentScore < 0.65) {
    score -= 0.28;
  }

  return clamp01(score);
}

function applyModuleAlignmentSignals(rows: RankedExportRow[], emittedPath: string): RankedExportRow[] {
  const hasModuleContext = collectModuleContextTokens(emittedPath).length > 0;
  return rows
    .map((row) => {
      const alignmentScore = scoreModulePathAlignment(row.name, emittedPath);
      const contextualQuality = scoreContextualExportNameQuality(row.name, emittedPath);
      const qualityBoost = Math.min(0.2, alignmentScore * 0.07);
      const confidenceBoost = Math.min(0.03, alignmentScore * 0.01);
      const confidencePenalty = hasModuleContext && alignmentScore < 0.35 ? 0.02 : 0;
      return {
        ...row,
        nameQuality: clamp01(contextualQuality + qualityBoost),
        confidence: Math.min(0.99, Math.max(0, row.confidence + confidenceBoost - confidencePenalty)),
      };
    })
    .sort((a, b) => {
      const scoreDelta = computeSelectionScore(b) - computeSelectionScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      if (a.nameQuality !== b.nameQuality) return b.nameQuality - a.nameQuality;
      if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
      return a.name.localeCompare(b.name);
    });
}

type ModuleRenameProfileKind = "generic" | "hook" | "transport";

type ModuleRenameProfile = {
  kind: ModuleRenameProfileKind;
  moduleBaseName: string;
  moduleTokens: string[];
  subjectTokens: string[];
  subjectCamel: string;
  subjectPascal: string;
};

const TRANSPORT_PROFILE_DROPPED_TOKENS = new Set<string>(["agent", "agents"]);

function buildModuleRenameProfile(input: {
  emittedPath: string;
  moduleBaseName: string;
  moduleTokens: string[];
}): ModuleRenameProfile {
  const normalizedPath = toPosixPath(input.emittedPath).toLowerCase();
  const baseTokens = splitIdentifierTokens(input.moduleBaseName)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0 && !isNoisyIdentifierToken(token));
  const contextTokens = (input.moduleTokens.length > 0 ? input.moduleTokens : baseTokens).filter((token) => token.length > 0);
  const looksLikeHook = normalizedPath.includes("/hooks/") || /^use[A-Z]/.test(input.moduleBaseName);
  const looksLikeTransport =
    normalizedPath.includes("transport") || contextTokens.includes("transport") || baseTokens.includes("transport");
  const kind: ModuleRenameProfileKind = looksLikeHook ? "hook" : looksLikeTransport ? "transport" : "generic";
  let subjectTokens = contextTokens.length > 0 ? [...contextTokens] : [...baseTokens];
  if (kind === "hook" && subjectTokens.length > 1) {
    subjectTokens = subjectTokens.filter((token) => token !== "use");
  }
  if (kind === "transport") {
    subjectTokens = subjectTokens.filter((token) => !TRANSPORT_PROFILE_DROPPED_TOKENS.has(token));
  }
  if (kind === "transport" && !subjectTokens.includes("transport")) {
    subjectTokens.push("transport");
  }
  if (subjectTokens.length === 0) {
    subjectTokens = ["module", "runtime"];
  }
  const subjectCamel = sanitizeExportIdentifierName(buildIdentifierFromTokens(subjectTokens, false) || "moduleRuntime");
  const subjectPascal = sanitizeExportIdentifierName(buildIdentifierFromTokens(subjectTokens, true) || "ModuleRuntime");
  return {
    kind,
    moduleBaseName: input.moduleBaseName,
    moduleTokens: contextTokens,
    subjectTokens,
    subjectCamel,
    subjectPascal,
  };
}

function hasProfileSubjectToken(name: string, profile: ModuleRenameProfile): boolean {
  if (profile.kind === "generic") return false;
  const nameTokens = splitIdentifierTokens(name).map((token) => token.toLowerCase());
  const subjectTokenSet = new Set(profile.subjectTokens.filter((token) => token.length >= 3));
  if (subjectTokenSet.size === 0) return false;
  return nameTokens.some((token) => subjectTokenSet.has(token));
}

function getProfileCanonicalName(profile: ModuleRenameProfile, kind: LiftedExportKind): string {
  if (profile.kind === "hook") {
    if (kind === "function") {
      if (/^use[A-Z]/.test(profile.moduleBaseName)) return profile.moduleBaseName;
      return sanitizeExportIdentifierName(`use${profile.subjectPascal}`);
    }
    if (kind === "class") {
      return sanitizeExportIdentifierName(`${profile.subjectPascal}Runtime`);
    }
    return sanitizeExportIdentifierName(`${profile.subjectCamel}State`);
  }
  if (profile.kind === "transport") {
    const transportCamel = profile.subjectCamel.endsWith("Transport") ? profile.subjectCamel : `${profile.subjectCamel}Transport`;
    const transportPascal = profile.subjectPascal.endsWith("Transport") ? profile.subjectPascal : `${profile.subjectPascal}Transport`;
    if (kind === "function") return sanitizeExportIdentifierName(transportCamel);
    if (kind === "class") return sanitizeExportIdentifierName(`${transportPascal}Runtime`);
    return sanitizeExportIdentifierName(`${transportCamel}Runtime`);
  }
  if (kind === "class") {
    return sanitizeExportIdentifierName(buildIdentifierFromTokens(splitIdentifierTokens(profile.moduleBaseName), true));
  }
  return profile.moduleBaseName;
}

function buildProfiledSecondaryName(input: {
  row: RankedExportRow;
  profile: ModuleRenameProfile;
  index: number;
}): string | undefined {
  const { row, profile } = input;
  const normalized = row.name.toLowerCase();
  if (profile.kind === "hook") {
    if (row.kind === "function") {
      if (/(value|state|current|ref)/.test(normalized)) {
        return sanitizeExportIdentifierName(`${profile.subjectCamel}State`);
      }
      if (/(inline|signal|observable|subject|stream|event|events|registry|cache|map)/.test(normalized)) {
        return sanitizeExportIdentifierName(`${profile.subjectCamel}Signal`);
      }
      if (/(connect|connection|live)/.test(normalized)) {
        return sanitizeExportIdentifierName(`${profile.subjectCamel}Connection`);
      }
      if (/^use[A-Z]/.test(row.name)) {
        return getProfileCanonicalName(profile, "function");
      }
      if (input.index === 0) return getProfileCanonicalName(profile, "function");
      const suffixes = ["State", "Signal", "Registry", "Connection", "Runtime"];
      const suffix = suffixes[(input.index - 1) % suffixes.length] ?? "Runtime";
      return sanitizeExportIdentifierName(`${profile.subjectCamel}${suffix}`);
    }
  if (UTILITY_WRAPPER_NAME_PATTERN.test(normalized)) {
    return sanitizeExportIdentifierName(`${profile.subjectCamel}OwnProperty`);
  }
    if (/(inline|signal|observable|subject|stream|event|events)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${profile.subjectCamel}Signal`);
    }
    if (/(connect|connection|live)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${profile.subjectCamel}Connection`);
    }
    if (/(map|registry|cache)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${profile.subjectCamel}Registry`);
    }
    if (/(value|state|current|ref)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${profile.subjectCamel}State`);
    }
    if (row.kind === "class") {
      return sanitizeExportIdentifierName(`${profile.subjectPascal}Runtime`);
    }
    return sanitizeExportIdentifierName(`${profile.subjectCamel}Runtime`);
  }
  if (profile.kind === "transport") {
    const transportCamel = profile.subjectCamel.endsWith("Transport") ? profile.subjectCamel : `${profile.subjectCamel}Transport`;
    const transportPascal = profile.subjectPascal.endsWith("Transport") ? profile.subjectPascal : `${profile.subjectPascal}Transport`;
    const transportStemCamel = transportCamel.replace(/Transport$/, "");
    if (row.kind === "function") {
      if (input.index === 0) return sanitizeExportIdentifierName(transportCamel);
      const suffixes = ["ConnectionState", "Registry", "Scheduler", "Runtime"];
      const suffix = suffixes[(input.index - 1) % suffixes.length] ?? "Runtime";
      return sanitizeExportIdentifierName(`${transportStemCamel}${suffix}`);
    }
    if (row.kind === "class") return sanitizeExportIdentifierName(transportPascal);
    if (/(buffer|delta|queue)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${transportStemCamel}Buffers`);
    }
    if (/(flush|timeout|interval|scheduler|batch)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${transportStemCamel}Scheduler`);
    }
    if (/(online|offline|listener|connection|network)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${transportStemCamel}ConnectionState`);
    }
    if (/(map|registry|cache)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${transportStemCamel}Registry`);
    }
    return sanitizeExportIdentifierName(`${transportStemCamel}Runtime`);
  }
  return undefined;
}

function isContextualRenameCandidate(input: {
  row: RankedExportRow;
  emittedPath: string;
  moduleTokens: string[];
  profile: ModuleRenameProfile;
}): boolean {
  const { row, emittedPath, moduleTokens, profile } = input;
  const normalized = row.name.toLowerCase();
  if (normalized.includes("getobjectready")) return true;
  if (/^[A-Za-z_$]{1,2}$/.test(row.name)) return true;
  if (/^[a-z]{2,3}$/.test(row.name)) return true;
  if (/var[a-z0-9]{2,}/.test(normalized)) return true;
  if (/(?:renderer|assets|services|main|tauri)\d+$/.test(normalized)) return true;
  if (UTILITY_WRAPPER_NAME_PATTERN.test(normalized)) return true;
  if (profile.kind === "hook" && row.kind === "function" && !/^use[A-Z]/.test(row.name)) return true;
  if (profile.kind === "transport" && row.kind === "function" && !normalized.includes("transport")) return true;
  if (profile.kind === "transport" && row.kind === "class" && !/Transport(?:Runtime)?$/.test(row.name)) return true;
  if (profile.kind === "hook" && row.kind === "variable" && HOOK_SIGNAL_NAME_PATTERN.test(normalized)) {
    return true;
  }
  if ((profile.kind === "hook" || profile.kind === "transport") && row.kind !== "function" && !hasProfileSubjectToken(row.name, profile)) {
    return true;
  }
  if (row.kind === "variable" && /Use$/.test(row.name) && !/^use[A-Z]/.test(row.name)) return true;
  const alignmentScore = scoreModulePathAlignment(row.name, emittedPath);
  if (moduleTokens.length > 0 && alignmentScore < 0.28) return true;
  if (scoreContextualExportNameQuality(row.name, emittedPath) <= 0.72) return true;
  return false;
}

function buildContextualSecondaryName(input: {
  moduleBaseName: string;
  moduleTokens: string[];
  kind: LiftedExportKind;
  index: number;
}): string {
  const baseTokens = input.moduleTokens.length > 0 ? input.moduleTokens : splitIdentifierTokens(input.moduleBaseName).map((token) => token.toLowerCase());
  const normalizedBaseTokens =
    input.kind === "function"
      ? baseTokens
      : baseTokens[0] === "use" && baseTokens.length > 1
        ? baseTokens.slice(1)
        : baseTokens;
  const baseIdentifier = buildIdentifierFromTokens(normalizedBaseTokens, input.kind === "class");
  const stableBase = sanitizeExportIdentifierName(baseIdentifier.length > 0 ? baseIdentifier : input.moduleBaseName);
  const functionSuffixes = ["Runtime", "Factory", "Loader", "Bridge", "Handler", "Internal"];
  const classSuffixes = ["Model", "Runtime", "Controller", "Manager", "Adapter", "Node"];
  const variableSuffixes = ["Value", "Map", "Registry", "Config", "State", "Cache"];
  const suffixList = input.kind === "function" ? functionSuffixes : input.kind === "class" ? classSuffixes : variableSuffixes;
  const suffix = suffixList[input.index % suffixList.length] ?? "Value";
  if (input.kind === "class") {
    const classBase = buildIdentifierFromTokens(splitIdentifierTokens(stableBase), true);
    const className = sanitizeExportIdentifierName(`${classBase}${suffix}`);
    if (className !== "symbol_export") return className;
    return `DomainRuntime${input.index + 1}`;
  }
  const camelBase = buildIdentifierFromTokens(splitIdentifierTokens(stableBase), false);
  const exportName = sanitizeExportIdentifierName(`${camelBase}${suffix}`);
  if (exportName !== "symbol_export") return exportName;
  return `domainRuntime${input.index + 1}`;
}

function applyTargetedExportRenames(rows: RankedExportRow[], emittedPath: string): RankedExportRow[] {
  if (rows.length === 0) return rows;
  const moduleStemRaw = path.posix.basename(toPosixPath(emittedPath), path.posix.extname(toPosixPath(emittedPath)));
  const moduleBaseName = toRecoveryModuleBaseName(moduleStemRaw);
  const moduleTokens = collectModuleContextTokens(emittedPath);
  const profile = buildModuleRenameProfile({
    emittedPath,
    moduleBaseName: moduleBaseName === "symbol_export" ? "moduleRuntime" : moduleBaseName,
    moduleTokens,
  });
  const usedNames = new Set(rows.map((row) => row.name));
  const nextRows = rows.map((row) => ({ ...row }));

  const rankedRows = nextRows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const scoreDelta = computeSelectionScore(b.row) - computeSelectionScore(a.row);
      if (scoreDelta !== 0) return scoreDelta;
      return a.index - b.index;
    });

  const assignCanonicalName = (kind: LiftedExportKind, allowVariableFallback = false): void => {
    const canonicalName = getProfileCanonicalName(profile, kind);
    if (canonicalName === "symbol_export" || canonicalName.length < 3) return;
    if (usedNames.has(canonicalName)) return;
    let candidate = rankedRows.find((item) => item.row.kind === kind);
    if (!candidate && allowVariableFallback) {
      candidate =
        rankedRows.find((item) => item.row.kind === "variable" && /^use[A-Z]/.test(item.row.name)) ??
        rankedRows.find(
          (item) =>
              item.row.kind === "variable" &&
              hasProfileSubjectToken(item.row.name, profile) &&
              !UTILITY_WRAPPER_NAME_PATTERN.test(item.row.name.toLowerCase()),
          ) ??
        rankedRows.find((item) => item.row.kind === "variable");
    }
    if (kind === "variable") {
      candidate =
        rankedRows.find((item) => item.row.kind === "variable" && !/^use[A-Z]/.test(item.row.name)) ??
        rankedRows.find((item) => item.row.kind === "variable");
    }
    if (!candidate || candidate.row.name === canonicalName) return;
    usedNames.delete(candidate.row.name);
    candidate.row.name = canonicalName;
    candidate.row.nameQuality = scoreContextualExportNameQuality(canonicalName, emittedPath);
    usedNames.add(candidate.row.name);
  };

  assignCanonicalName("function", profile.kind === "hook");
  assignCanonicalName("class");
  if (profile.kind === "hook") {
    assignCanonicalName("variable");
  }

  let renameOrdinal = 0;
  for (const row of nextRows) {
    if (
      !isContextualRenameCandidate({
        row,
        emittedPath,
        moduleTokens,
        profile,
      })
    ) {
      continue;
    }
    const profiledName = buildProfiledSecondaryName({
      row,
      profile,
      index: renameOrdinal,
    });
    const nextCandidateName =
      profiledName ??
      buildContextualSecondaryName({
        moduleBaseName: moduleBaseName === "symbol_export" ? "moduleRuntime" : moduleBaseName,
        moduleTokens,
        kind: row.kind,
        index: renameOrdinal,
      });
    renameOrdinal += 1;
    let nextName = nextCandidateName;
    let dedupeIndex = 2;
    while (usedNames.has(nextName) && dedupeIndex < 200) {
      nextName = `${nextCandidateName}${dedupeIndex}`;
      dedupeIndex += 1;
    }
    if (nextName === row.name || usedNames.has(nextName)) continue;
    usedNames.delete(row.name);
    row.name = nextName;
    row.nameQuality = scoreContextualExportNameQuality(nextName, emittedPath);
    usedNames.add(row.name);
  }

  return nextRows;
}

function buildArchetypeSubject(emittedPath: string): { camel: string; pascal: string } {
  const moduleStem = path.posix.basename(toPosixPath(emittedPath), path.posix.extname(toPosixPath(emittedPath)));
  const moduleTokens = collectModuleContextTokens(emittedPath);
  const stemTokens = splitIdentifierTokens(moduleStem).map((token) => token.toLowerCase());
  const dropped = new Set<string>([
    "use",
    "hook",
    "hooks",
    "transport",
    "ipc",
    "event",
    "events",
    "service",
    "services",
    "main",
    "renderer",
    "tauri",
    "adapter",
  ]);
  const preferredTokens = [...moduleTokens, ...stemTokens].filter(
    (token, index, list) =>
      token.length >= 3 &&
      !dropped.has(token) &&
      !isNoisyIdentifierToken(token) &&
      list.indexOf(token) === index,
  );
  const subjectTokens = preferredTokens.length > 0 ? preferredTokens : ["domain", "runtime"];
  const camel = sanitizeExportIdentifierName(buildIdentifierFromTokens(subjectTokens, false) || "domainRuntime");
  const pascal = sanitizeExportIdentifierName(buildIdentifierFromTokens(subjectTokens, true) || "DomainRuntime");
  return {
    camel: camel === "symbol_export" ? "domainRuntime" : camel,
    pascal: pascal === "symbol_export" ? "DomainRuntime" : pascal,
  };
}

function isWeakHookTransportName(input: {
  row: RankedExportRow;
  emittedPath: string;
  archetype: ModuleArchetype;
}): boolean {
  const normalized = input.row.name.toLowerCase();
  if (/(eventsinline|getobjectready|inline(server|client)?|runtimeuse|useevent|getownpropertynames)/.test(normalized)) return true;
  if (/var[a-z0-9]{2,}/.test(normalized)) return true;
  if (/[a-z]{2,}\d{2,}$/i.test(input.row.name)) return true;
  const quality = scoreContextualExportNameQuality(input.row.name, input.emittedPath);
  if (quality < 0.84) return true;

  if (input.archetype === "hook") {
    if (input.row.kind === "function" && !/^use[A-Z]/.test(input.row.name)) return true;
    if (input.row.kind === "variable" && /(inline|event|events|server|client)/.test(normalized)) return true;
  }
  if (input.archetype === "transport") {
    if (input.row.kind === "function" && !/(transport|ipc|dispatch|connection|stream|subscribe|publish)/.test(normalized)) return true;
    if (input.row.kind === "class" && !/(Transport|Runtime|Bridge|Client)$/.test(input.row.name)) return true;
  }
  return false;
}

function proposeHookTransportName(input: {
  row: RankedExportRow;
  archetype: ModuleArchetype;
  subject: { camel: string; pascal: string };
  indexByKind: Map<LiftedExportKind, number>;
}): string {
  const normalized = input.row.name.toLowerCase();
  const kindIndex = input.indexByKind.get(input.row.kind) ?? 0;
  input.indexByKind.set(input.row.kind, kindIndex + 1);

  if (input.archetype === "hook") {
    if (input.row.kind === "function") {
      if (kindIndex === 0) return sanitizeExportIdentifierName(`use${input.subject.pascal}`);
      if (/(connect|connection|listener|live)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Connection`);
      if (/(cache|registry|map|store)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Registry`);
      if (/(state|value|current|ref)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}State`);
      return sanitizeExportIdentifierName(`${input.subject.camel}Signal`);
    }
    if (input.row.kind === "class") {
      return sanitizeExportIdentifierName(`${input.subject.pascal}HookRuntime`);
    }
    if (/(connect|connection|listener|online|offline)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${input.subject.camel}ConnectionState`);
    }
    if (/(cache|registry|map|store)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${input.subject.camel}Registry`);
    }
    if (/(state|value|current|ref)/.test(normalized)) {
      return sanitizeExportIdentifierName(`${input.subject.camel}State`);
    }
    return sanitizeExportIdentifierName(`${input.subject.camel}Signal`);
  }

  if (input.row.kind === "function") {
    if (kindIndex === 0) return sanitizeExportIdentifierName(`${input.subject.camel}Transport`);
    if (/(send|emit|publish|dispatch)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Dispatch`);
    if (/(listen|subscribe|receive|stream)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Subscription`);
    if (/(connect|connection|online|offline)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Connection`);
    return sanitizeExportIdentifierName(`${input.subject.camel}TransportRuntime`);
  }
  if (input.row.kind === "class") {
    return sanitizeExportIdentifierName(`${input.subject.pascal}TransportRuntime`);
  }
  if (/(queue|flush|batch|timeout|interval|scheduler)/.test(normalized)) {
    return sanitizeExportIdentifierName(`${input.subject.camel}Scheduler`);
  }
  if (/(buffer|delta|packet)/.test(normalized)) {
    return sanitizeExportIdentifierName(`${input.subject.camel}Buffers`);
  }
  if (/(connect|connection|online|offline|listener)/.test(normalized)) {
    return sanitizeExportIdentifierName(`${input.subject.camel}ConnectionState`);
  }
  if (/(cache|registry|map|store)/.test(normalized)) {
    return sanitizeExportIdentifierName(`${input.subject.camel}Registry`);
  }
  return sanitizeExportIdentifierName(`${input.subject.camel}TransportState`);
}

function applyHookTransportQualityPass(input: {
  rows: RankedExportRow[];
  emittedPath: string;
  archetype: ModuleArchetype;
}): { rows: RankedExportRow[]; renamed: number } {
  if (input.rows.length === 0) return { rows: [], renamed: 0 };
  if (input.archetype !== "hook" && input.archetype !== "transport") {
    return { rows: [...input.rows], renamed: 0 };
  }
  const subject = buildArchetypeSubject(input.emittedPath);
  const usedNames = new Set(input.rows.map((row) => row.name));
  const indexByKind = new Map<LiftedExportKind, number>();
  let renamed = 0;

  const nextRows = input.rows.map((row) => ({ ...row }));
  for (const row of nextRows) {
    if (!isWeakHookTransportName({ row, emittedPath: input.emittedPath, archetype: input.archetype })) continue;
    const proposed = proposeHookTransportName({
      row,
      archetype: input.archetype,
      subject,
      indexByKind,
    });
    if (proposed === "symbol_export" || proposed.length < 3) continue;
    let nextName = proposed;
    let dedupe = 2;
    while (usedNames.has(nextName) && nextName !== row.name && dedupe < 80) {
      nextName = `${proposed}${dedupe}`;
      dedupe += 1;
    }
    if (nextName === row.name || usedNames.has(nextName)) continue;
    usedNames.delete(row.name);
    row.name = nextName;
    row.nameQuality = scoreContextualExportNameQuality(nextName, input.emittedPath);
    usedNames.add(row.name);
    renamed += 1;
  }
  return { rows: nextRows, renamed };
}

function isWeakServiceName(input: {
  row: RankedExportRow;
  emittedPath: string;
}): boolean {
  const normalized = input.row.name.toLowerCase();
  if (/^(?:[A-Za-z_$]{1,2}|[a-z]{2,4})$/.test(input.row.name)) return true;
  if (/(getobjectready|eventsinline|runtimeuse|inline(server|client)?|unknown|misc|tmp|temp)/.test(normalized)) return true;
  if (/var[a-z0-9]{2,}/.test(normalized)) return true;
  if (/[a-z]{2,}\d{2,}$/i.test(input.row.name)) return true;
  if (input.row.kind === "function" && /(handler|runtime)$/.test(normalized) && normalized.length < 14) return true;
  if (input.row.kind === "class" && /(manager|runtime)$/.test(input.row.name) && input.row.name.length < 12) return true;
  const alignment = scoreModulePathAlignment(input.row.name, input.emittedPath);
  const quality = scoreContextualExportNameQuality(input.row.name, input.emittedPath);
  if (alignment < 0.28) return true;
  if (quality < 0.85) return true;
  return false;
}

function proposeServiceName(input: {
  row: RankedExportRow;
  subject: { camel: string; pascal: string };
  indexByKind: Map<LiftedExportKind, number>;
}): string {
  const normalized = input.row.name.toLowerCase();
  const kindIndex = input.indexByKind.get(input.row.kind) ?? 0;
  input.indexByKind.set(input.row.kind, kindIndex + 1);

  if (input.row.kind === "class") {
    if (/(provider|client|adapter)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.pascal}Provider`);
    if (/(registry|cache|store|map)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.pascal}Registry`);
    return sanitizeExportIdentifierName(`${input.subject.pascal}Service`);
  }
  if (input.row.kind === "function") {
    if (kindIndex === 0) return sanitizeExportIdentifierName(`${input.subject.camel}Service`);
    if (/(create|build|factory|init|bootstrap)/.test(normalized)) return sanitizeExportIdentifierName(`create${input.subject.pascal}Service`);
    if (/(load|fetch|read|query|list|get)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Loader`);
    if (/(update|write|save|persist|sync)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Updater`);
    if (/(start|stop|run|execute|dispatch|emit)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Runner`);
    return sanitizeExportIdentifierName(`${input.subject.camel}Handler`);
  }
  if (/(registry|cache|map|store)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Registry`);
  if (/(config|options|flags|settings)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Config`);
  if (/(state|status|snapshot|session)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}State`);
  if (/(queue|batch|scheduler|timer|timeout)/.test(normalized)) return sanitizeExportIdentifierName(`${input.subject.camel}Scheduler`);
  return sanitizeExportIdentifierName(`${input.subject.camel}Runtime`);
}

function applyServiceQualityPass(input: {
  rows: RankedExportRow[];
  emittedPath: string;
  archetype: ModuleArchetype;
}): { rows: RankedExportRow[]; renamed: number } {
  if (input.rows.length === 0) return { rows: [], renamed: 0 };
  if (input.archetype !== "service") {
    return { rows: [...input.rows], renamed: 0 };
  }

  const subject = buildArchetypeSubject(input.emittedPath);
  const usedNames = new Set(input.rows.map((row) => row.name));
  const indexByKind = new Map<LiftedExportKind, number>();
  let renamed = 0;
  const nextRows = input.rows.map((row) => ({ ...row }));

  for (const row of nextRows) {
    if (!isWeakServiceName({ row, emittedPath: input.emittedPath })) continue;
    const proposed = proposeServiceName({
      row,
      subject,
      indexByKind,
    });
    if (proposed === "symbol_export" || proposed.length < 3) continue;

    let nextName = proposed;
    let dedupe = 2;
    while (usedNames.has(nextName) && nextName !== row.name && dedupe < 80) {
      nextName = `${proposed}${dedupe}`;
      dedupe += 1;
    }
    if (nextName === row.name || usedNames.has(nextName)) continue;
    usedNames.delete(row.name);
    row.name = nextName;
    row.nameQuality = scoreContextualExportNameQuality(nextName, input.emittedPath);
    usedNames.add(row.name);
    renamed += 1;
  }
  return { rows: nextRows, renamed };
}

function normalizeExportNameRoot(input: string): string {
  const sanitized = stripNoisyExportSuffix(input);
  return sanitized.replace(/V\d+$/i, "").replace(/\d+$/i, "").replace(/[_-]+$/, "").toLowerCase();
}

function getDeclarationLengthLimit(kind: LiftedExportKind, moduleSizeHint: number): number {
  if (kind === "variable") {
    if (moduleSizeHint >= 1800) return 3600;
    if (moduleSizeHint >= 900) return 5200;
    return 9000;
  }
  if (moduleSizeHint >= 1800) return 8000;
  if (moduleSizeHint >= 900) return 10000;
  return 15000;
}

function computeSelectionScore(row: RankedExportRow): number {
  const priorityScore = getExportKindPriority(row.kind);
  const confidenceScore = row.confidence * 100;
  const qualityScore = row.nameQuality * 60;
  const lengthPenalty = row.declarationLength > 0 ? Math.min(45, row.declarationLength / 350) : 0;
  const generatedPenalty = row.generatedSignal * 70;
  return priorityScore + confidenceScore + qualityScore - lengthPenalty - generatedPenalty;
}

function selectWithCaps(input: {
  rows: RankedExportRow[];
  limit: number;
  maxVariables: number;
  perRootCap: number;
  seed?: RankedExportRow[];
}): RankedExportRow[] {
  const selected: RankedExportRow[] = [];
  const selectedBySymbol = new Set<string>();
  const rootCounts = new Map<string, number>();
  let variableCount = 0;

  const pushRow = (row: RankedExportRow): boolean => {
    if (selectedBySymbol.has(row.sourceSymbol)) return false;
    if (selected.length >= input.limit) return false;
    if (row.kind === "variable" && variableCount >= input.maxVariables) return false;
    const root = normalizeExportNameRoot(row.name);
    const rootCount = rootCounts.get(root) ?? 0;
    if (rootCount >= input.perRootCap) return false;
    selected.push(row);
    selectedBySymbol.add(row.sourceSymbol);
    rootCounts.set(root, rootCount + 1);
    if (row.kind === "variable") variableCount += 1;
    return true;
  };

  for (const seedRow of input.seed ?? []) {
    pushRow(seedRow);
  }
  for (const row of input.rows) {
    if (selected.length >= input.limit) break;
    pushRow(row);
  }
  return selected;
}

function pickDeclarationStatForExport(
  rows: LiftDeclarationStat[],
  expectedKind: LiftedExportKind,
  sourceLine: number,
): LiftDeclarationStat | undefined {
  if (rows.length === 0) return undefined;
  const lineHint = sourceLine > 0 ? sourceLine : rows[0]?.line ?? 0;
  let best: LiftDeclarationStat | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    let kindPenalty = 0;
    if (row.kind !== expectedKind) {
      if (row.kind === "variable" && (expectedKind === "function" || expectedKind === "class")) kindPenalty = 1;
      else kindPenalty = 3;
    }
    const lineDistance = Math.abs(row.line - lineHint) * 0.01;
    const score = kindPenalty * 100 + lineDistance;
    if (score < bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function buildTargetSymbolEntriesIndexFromSemanticModules(modules: SemanticIrModule[]): Map<string, TargetSymbolEntry[]> {
  const index = new Map<string, TargetSymbolEntry[]>();
  for (const module of modules) {
    const targetPath = toProjectRelativeTargetPath(module.modulePath);
    for (const symbol of module.symbols) {
      if (!isSafeImportIdentifier(symbol.sourceSymbol)) continue;
      const exportName = sanitizeExportIdentifierName(symbol.exportedName);
      if (exportName === "symbol_export") continue;
      const row: TargetSymbolEntry = {
        targetPath,
        sourceFile: symbol.sourceFile || module.sourceFile,
        exportName,
        sourceSymbol: symbol.sourceSymbol,
        kind: symbol.kind,
        sourceLine: symbol.sourceLine,
        confidence: symbol.confidence,
      };
      const bucket = index.get(targetPath) ?? [];
      bucket.push(row);
      index.set(targetPath, bucket);
    }
  }
  return index;
}

function buildRankedExportRowsFromTargetEntries(input: {
  entries: TargetSymbolEntry[];
  sourceFile: string;
  declarationStatsByName: Map<string, LiftDeclarationStat[]>;
}): RankedExportRow[] {
  const byExportName = new Map<string, TargetSymbolEntry>();
  for (const entry of input.entries) {
    if (entry.sourceFile !== input.sourceFile) continue;
    const current = byExportName.get(entry.exportName);
    if (!current || entry.confidence > current.confidence) {
      byExportName.set(entry.exportName, entry);
    }
  }

  return Array.from(byExportName.values())
    .map((entry) => {
      const stat = pickDeclarationStatForExport(
        input.declarationStatsByName.get(entry.sourceSymbol) ?? [],
        entry.kind,
        entry.sourceLine,
      );
      const importLikeMismatch =
        !!stat &&
        stat.kind === "variable" &&
        (entry.kind === "function" || entry.kind === "class");
      const effectiveStat = importLikeMismatch ? undefined : stat;
      return {
        name: entry.exportName,
        sourceSymbol: entry.sourceSymbol,
        kind: entry.kind,
        sourceLine: entry.sourceLine,
        confidence: entry.confidence,
        declarationLength: effectiveStat?.statementLength ?? 0,
        hasDeclaration: !!effectiveStat,
        nameQuality: scoreExportNameQuality(entry.exportName),
        generatedSignal: effectiveStat?.generatedSignal ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
      if (a.nameQuality !== b.nameQuality) return b.nameQuality - a.nameQuality;
      if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });
}

function parseSourceExportAliases(sourceChunk: string): Array<{ sourceSymbol: string; exportedName: string }> {
  const rows: Array<{ sourceSymbol: string; exportedName: string }> = [];
  const seen = new Set<string>();
  const exportBlockPattern = /export\s*\{([\s\S]*?)\}\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = exportBlockPattern.exec(sourceChunk)) !== null) {
    const rawBody = (match[1] ?? "").trim();
    if (rawBody.length === 0) continue;
    const parts = rawBody
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    for (const part of parts) {
      const aliasMatch = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (aliasMatch) {
        const sourceSymbol = aliasMatch[1];
        const exportedName = aliasMatch[2];
        const key = `${sourceSymbol}->${exportedName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ sourceSymbol, exportedName });
        continue;
      }
      const directMatch = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (!directMatch) continue;
      const sourceSymbol = directMatch[1];
      const key = `${sourceSymbol}->${sourceSymbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ sourceSymbol, exportedName: sourceSymbol });
    }
  }
  return rows;
}

function pickBestDeclarationStat(rows: LiftDeclarationStat[]): LiftDeclarationStat | undefined {
  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort((a, b) => {
    if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
    if (a.statementLength !== b.statementLength) return a.statementLength - b.statementLength;
    return a.line - b.line;
  });
  return sorted[0];
}

function buildRankedExportRowsFromSourceAliases(input: {
  sourceChunk: string;
  declarationStatsByName: Map<string, LiftDeclarationStat[]>;
  confidence: number;
}): RankedExportRow[] {
  const aliases = parseSourceExportAliases(input.sourceChunk);
  if (aliases.length === 0) return [];

  const rows: RankedExportRow[] = [];
  const bySourceSymbol = new Set<string>();
  for (const alias of aliases) {
    if (bySourceSymbol.has(alias.sourceSymbol)) continue;
    const declarationRows = input.declarationStatsByName.get(alias.sourceSymbol) ?? [];
    const stat = pickBestDeclarationStat(declarationRows);
    if (!stat) continue;
    if (stat.kind === "variable") continue;
    if (stat.generatedSignal >= 0.72 && stat.statementLength > 2400) continue;
    const exportName = sanitizeExportIdentifierName(alias.exportedName);
    if (exportName === "symbol_export") continue;
    rows.push({
      name: exportName,
      sourceSymbol: alias.sourceSymbol,
      kind: stat.kind,
      sourceLine: stat.line,
      confidence: Math.max(0.66, input.confidence - 0.04),
      declarationLength: stat.statementLength,
      hasDeclaration: true,
      nameQuality: scoreExportNameQuality(exportName),
      generatedSignal: stat.generatedSignal,
    });
    bySourceSymbol.add(alias.sourceSymbol);
  }

  return rows.sort((a, b) => {
    if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
    if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
    if (a.nameQuality !== b.nameQuality) return b.nameQuality - a.nameQuality;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
    });
}

function buildRankedExportRowsFromTopDeclarations(input: {
  declarationStatsRows: LiftDeclarationStat[];
  confidence: number;
}): RankedExportRow[] {
  const bySymbol = new Map<string, LiftDeclarationStat>();
  for (const row of input.declarationStatsRows) {
    if (row.kind === "variable") continue;
    if (!isSafeImportIdentifier(row.name)) continue;
    if (row.generatedSignal >= 0.72) continue;
    if (row.statementLength <= 0 || row.statementLength > 6200) continue;
    const current = bySymbol.get(row.name);
    if (!current) {
      bySymbol.set(row.name, row);
      continue;
    }
    if (row.generatedSignal < current.generatedSignal) {
      bySymbol.set(row.name, row);
      continue;
    }
    if (row.generatedSignal === current.generatedSignal && row.statementLength < current.statementLength) {
      bySymbol.set(row.name, row);
    }
  }

  return Array.from(bySymbol.entries())
    .map(([sourceSymbol, stat]) => {
      const exportName = sanitizeExportIdentifierName(sourceSymbol);
      if (exportName === "symbol_export") return undefined;
      return {
        name: exportName,
        sourceSymbol,
        kind: stat.kind,
        sourceLine: stat.line,
        confidence: Math.max(0.62, input.confidence - 0.1),
        declarationLength: stat.statementLength,
        hasDeclaration: true,
        nameQuality: scoreExportNameQuality(exportName),
        generatedSignal: stat.generatedSignal,
      } as RankedExportRow;
    })
    .filter((row): row is RankedExportRow => !!row)
    .sort((a, b) => {
      if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
      if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.name.localeCompare(b.name);
    });
}

function selectPrimaryExports(input: {
  rows: RankedExportRow[];
  moduleConfidence: number;
}): { selected: RankedExportRow[]; dropped: RankedExportRow[] } {
  const bySourceSymbol = new Map<string, RankedExportRow>();
  for (const row of input.rows) {
    const current = bySourceSymbol.get(row.sourceSymbol);
    if (!current || computeSelectionScore(row) > computeSelectionScore(current)) {
      bySourceSymbol.set(row.sourceSymbol, row);
    }
  }

  const ranked = Array.from(bySourceSymbol.values()).sort((a, b) => {
    const priorityDelta = getExportKindPriority(b.kind) - getExportKindPriority(a.kind);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.generatedSignal !== b.generatedSignal) return a.generatedSignal - b.generatedSignal;
    if (a.nameQuality !== b.nameQuality) return b.nameQuality - a.nameQuality;
    if (a.declarationLength !== b.declarationLength) return a.declarationLength - b.declarationLength;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.name.localeCompare(b.name);
  });

  const moduleSizeHint = ranked.length;
  const ultraDense = moduleSizeHint >= 1800;
  const dense = moduleSizeHint >= 900;
  const hasAnyDeclaration = ranked.some((row) => row.hasDeclaration);
  const maxVariables = ultraDense ? 0 : dense ? 1 : 3;
  const perRootCap = ultraDense ? 1 : dense ? 1 : 2;

  const strictRows: RankedExportRow[] = [];
  const fallbackRows: RankedExportRow[] = [];
  for (const row of ranked) {
    const missingDeclaration = !row.hasDeclaration;
    const allowMissingDeclarationCallable =
      (row.kind === "class" || row.kind === "function") &&
      row.confidence >= 0.94 &&
      row.nameQuality >= 0.82 &&
      !dense &&
      !ultraDense &&
      !hasAnyDeclaration;
    if (missingDeclaration && !allowMissingDeclarationCallable) {
      fallbackRows.push(row);
      continue;
    }

    if (
      row.kind === "variable" &&
      row.generatedSignal >= (ultraDense ? 0.42 : dense ? 0.58 : 0.75) &&
      row.declarationLength >= 900
    ) {
      fallbackRows.push(row);
      continue;
    }

    const confidenceFloor = row.kind === "variable" ? Math.max(0.7, input.moduleConfidence - 0.12) : Math.max(0.68, input.moduleConfidence - 0.2);
    const qualityFloor = ultraDense ? 0.7 : dense ? 0.62 : 0.48;
    const lengthLimit = getDeclarationLengthLimit(row.kind, moduleSizeHint);
    const generatedFloor = ultraDense ? 0.28 : dense ? 0.44 : 0.92;
    const declarationAllowed = row.declarationLength <= 0 || row.declarationLength <= lengthLimit;
    const generatedAllowed = row.generatedSignal <= generatedFloor;
    const accepted = row.confidence >= confidenceFloor && row.nameQuality >= qualityFloor && declarationAllowed && generatedAllowed;
    if (accepted) strictRows.push(row);
    else fallbackRows.push(row);
  }

  const hasCallable = strictRows.some((row) => row.kind === "class" || row.kind === "function");
  const hardLimit = ultraDense ? 12 : dense ? 14 : hasCallable ? 18 : 14;
  let selected = selectWithCaps({
    rows: strictRows,
    limit: hardLimit,
    maxVariables,
    perRootCap,
  });
  if (!hasCallable) {
    const callableFallback = fallbackRows.find((row) => row.kind === "class" || row.kind === "function");
    if (callableFallback) {
      selected = selectWithCaps({
        rows: strictRows,
        limit: hardLimit,
        maxVariables,
        perRootCap,
        seed: [callableFallback],
      });
    }
  }
  const softFallbackRows = fallbackRows.filter((row) => {
    const generatedAllowed = row.generatedSignal <= (ultraDense ? 0.28 : dense ? 0.44 : 0.92);
    if (!generatedAllowed) return false;
    if (ultraDense || dense) return row.hasDeclaration;
    if (row.hasDeclaration) return true;
    return (row.kind === "class" || row.kind === "function") && row.confidence >= 0.93 && row.nameQuality >= 0.82;
  });
  if (selected.length < Math.min(8, hardLimit)) {
    selected = selectWithCaps({
      rows: [...selected, ...softFallbackRows],
      limit: hardLimit,
      maxVariables: Math.max(maxVariables, 1),
      perRootCap,
    });
  }
  if (selected.length === 0 && ranked.length > 0) {
    const rankedWithDeclaration = ranked.filter((row) => row.hasDeclaration);
    selected = selectWithCaps({
      rows: ultraDense || dense ? [...strictRows, ...softFallbackRows] : rankedWithDeclaration,
      limit: Math.min(8, hardLimit),
      maxVariables: Math.max(maxVariables, 1),
      perRootCap,
    });
    if (selected.length === 0) {
      selected = selectWithCaps({
        rows: ultraDense || dense ? rankedWithDeclaration : ranked,
        limit: Math.min(6, hardLimit),
        maxVariables: Math.max(maxVariables, 1),
        perRootCap,
      });
    }
  }

  const selectedKey = new Set(selected.map((row) => `${row.sourceSymbol}|${row.name}|${row.kind}`));
  const dropped = ranked.filter((row) => !selectedKey.has(`${row.sourceSymbol}|${row.name}|${row.kind}`));
  return { selected, dropped };
}

function isSafeImportIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function collectOutputPreview(stdout: string, stderr: string, maxLines: number): string[] {
  const joined = `${stdout}\n${stderr}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 420 ? `${line.slice(0, 420)}...` : line));
  return joined.slice(0, maxLines);
}

function countMatches(lines: string[], pattern: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (pattern.test(line)) count += 1;
  }
  return count;
}

function countMatchesInText(text: string, pattern: RegExp): number {
  const lines = text.split(/\r?\n/g);
  return countMatches(lines, pattern);
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function runShellCommandSync(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): ReturnType<typeof spawnSync> {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", input.command], {
      cwd: input.cwd,
      encoding: "utf8",
      timeout: input.timeoutMs,
      windowsHide: true,
    });
  }
  return spawnSync("sh", ["-lc", input.command], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: input.timeoutMs,
    windowsHide: true,
  });
}

function runNodeScriptSync(input: {
  scriptPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [input.scriptPath, ...input.args], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: input.timeoutMs,
    windowsHide: true,
  });
}

function asText(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  return value.toString("utf8");
}

function runGeneratedProjectChecks(projectRoot: string): WebStormTestProjectReport["checks"] {
  const installStart = Date.now();
  const installResult = runShellCommandSync({
    command: "npm install --no-audit --no-fund",
    cwd: projectRoot,
    timeoutMs: 300000,
  });
  const installDurationMs = Date.now() - installStart;
  const installErrorLine =
    installResult.error instanceof Error ? `spawn-error: ${installResult.error.message}` : "";
  const installPreview = collectOutputPreview(
    `${asText(installResult.stdout)}\n${installErrorLine}`,
    asText(installResult.stderr),
    30,
  );
  const installSuccess = installResult.status === 0;

  const checks: WebStormTestProjectReport["checks"] = {
    install: {
      attempted: true,
      success: installSuccess,
      exitCode: installResult.status ?? -1,
      durationMs: installDurationMs,
      outputPreview: installPreview,
    },
    tsc: {
      attempted: false,
      success: false,
      exitCode: -1,
      errors: 0,
      warnings: 0,
      outputPreview: [],
    },
    eslint: {
      attempted: false,
      success: false,
      exitCode: -1,
      errors: 0,
      warnings: 0,
      outputPreview: [],
      skippedReason: "",
    },
  };

  if (!installSuccess) {
    checks.eslint.skippedReason = "npm install failed";
    return checks;
  }

  const projectTscBin = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const repoTscBin = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  const tscBin = fs.existsSync(projectTscBin) ? projectTscBin : fs.existsSync(repoTscBin) ? repoTscBin : "";
  const tscResult =
    tscBin.length > 0
      ? runNodeScriptSync({
          scriptPath: tscBin,
          args: ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"],
          cwd: projectRoot,
          timeoutMs: 240000,
        })
      : runShellCommandSync({
          command: "npm exec --yes --package typescript tsc -p tsconfig.json --noEmit --pretty false",
          cwd: projectRoot,
          timeoutMs: 240000,
        });
  const tscStdout = asText(tscResult.stdout);
  const tscStderr = asText(tscResult.stderr);
  const tscPreview = collectOutputPreview(tscStdout, tscStderr, 30);
  const tscErrors = countMatchesInText(`${tscStdout}\n${tscStderr}`, /error\s+TS\d+/i);
  checks.tsc = {
    attempted: true,
    success: tscResult.status === 0 && tscErrors === 0,
    exitCode: tscResult.status ?? -1,
    errors: tscErrors,
    warnings: 0,
    outputPreview: tscPreview,
  };

  const projectEslintBin = path.join(projectRoot, "node_modules", "eslint", "bin", "eslint.js");
  const repoEslintBin = path.join(REPO_ROOT, "node_modules", "eslint", "bin", "eslint.js");
  const eslintBin = fs.existsSync(projectEslintBin)
    ? projectEslintBin
    : fs.existsSync(repoEslintBin)
      ? repoEslintBin
      : "";
  const eslintArgs = ["src/**/*.{js,mjs,cjs,ts,tsx}", "src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx}", "--format", "json"];
  const eslintResult =
    eslintBin.length > 0
      ? runNodeScriptSync({
          scriptPath: eslintBin,
          args: eslintArgs,
          cwd: projectRoot,
          timeoutMs: 240000,
        })
      : runShellCommandSync({
          command:
            "npm exec --yes --package eslint@9.20.0 -- eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json",
          cwd: projectRoot,
          timeoutMs: 240000,
        });
  const eslintStdout = asText(eslintResult.stdout);
  const eslintStderr = asText(eslintResult.stderr);
  const eslintPreview = collectOutputPreview(eslintStdout, eslintStderr, 40);

  let eslintErrors = 0;
  let eslintWarnings = 0;
  try {
    const parsed = JSON.parse(eslintStdout || "[]") as Array<{
      errorCount?: number;
      warningCount?: number;
      fatalErrorCount?: number;
    }>;
    for (const row of parsed) {
      eslintErrors += (row.errorCount ?? 0) + (row.fatalErrorCount ?? 0);
      eslintWarnings += row.warningCount ?? 0;
    }
  } catch {
    const eslintAll = `${eslintStdout}\n${eslintStderr}`;
    eslintErrors = countMatchesInText(eslintAll, /\berror\b/i);
    eslintWarnings = countMatchesInText(eslintAll, /\bwarning\b/i);
  }
  checks.eslint = {
    attempted: true,
    success: eslintResult.status === 0 && eslintErrors === 0 && eslintWarnings === 0,
    exitCode: eslintResult.status ?? -1,
    errors: eslintErrors,
    warnings: eslintWarnings,
    outputPreview: eslintPreview,
    skippedReason: "",
  };

  return checks;
}

export function buildWebStormTestProject(input: BuildWebStormTestProjectInput): WebStormTestProjectReport {
  const projectRoot = path.join(input.outDir, "project");
  removePath(projectRoot);
  ensureDir(projectRoot);

  const srcRoot = ensureDir(path.join(projectRoot, "src"));
  ensureDir(path.join(srcRoot, "main"));
  ensureDir(path.join(srcRoot, "renderer"));
  ensureDir(path.join(srcRoot, "services"));
  const chunkArtifactsRoot = ensureDir(path.join(srcRoot, "chunks"));
  ensureDir(path.join(projectRoot, "src-tauri-adapter"));
  const mappingRoot = ensureDir(path.join(projectRoot, "mapping"));
  const metaRoot = ensureDir(path.join(projectRoot, "meta"));
  const toolsRoot = ensureDir(path.join(projectRoot, "tools"));

  const chunkArtifactBySourceFile = new Map<string, string>();
  const chunkSourceBySourceFile = new Map<string, string>();
  let chunkFiles = 0;
  const readSourceChunkForSourceFile = (sourceFileInput: string): string => {
    const sourceFile = normalizeDeobfSourceFile(sourceFileInput);
    if (sourceFile.length === 0) {
      throw new Error("Missing source file for source chunk read.");
    }
    const cachedSource = chunkSourceBySourceFile.get(sourceFile);
    if (cachedSource) return cachedSource;
    const sourcePath = path.join(input.decompiledDir, sourceFile);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Mapped source chunk file does not exist: ${sourcePath}`);
    }
    const source = normalizeSourceForPrint(readUtf8(sourcePath));
    const normalizedSource = source.endsWith("\n") ? source : `${source}\n`;
    chunkSourceBySourceFile.set(sourceFile, normalizedSource);
    return normalizedSource;
  };

  const ensureChunkArtifactForSourceFile = (sourceFileInput: string): { chunkArtifactPath: string; sourceChunk: string } => {
    const sourceFile = normalizeDeobfSourceFile(sourceFileInput);
    if (sourceFile.length === 0) {
      throw new Error("Missing source file for reconstructed module chunk artifact.");
    }
    const cachedArtifact = chunkArtifactBySourceFile.get(sourceFile);
    const sourceChunk = readSourceChunkForSourceFile(sourceFile);
    if (cachedArtifact) {
      return {
        chunkArtifactPath: cachedArtifact,
        sourceChunk,
      };
    }
    const chunkArtifactPath = toChunkArtifactPath(sourceFile);
    const destinationPath = path.join(chunkArtifactsRoot, chunkArtifactPath);
    ensureDir(path.dirname(destinationPath));
    fs.writeFileSync(destinationPath, sourceChunk, "utf8");
    const artifactPath = toPosixPath(path.posix.join("src", "chunks", chunkArtifactPath));
    chunkArtifactBySourceFile.set(sourceFile, artifactPath);
    chunkFiles += 1;
    return {
      chunkArtifactPath: artifactPath,
      sourceChunk,
    };
  };

  type SourceLiftContext = {
    sourceFile: string;
    sourceChunk: string;
    declarationStatsRows: LiftDeclarationStat[];
    declarationStatsByName: Map<string, LiftDeclarationStat[]>;
    declarationGraphByName: Map<string, LiftDeclarationGraphNode[]>;
  };

  const sourceLiftContextCache = new Map<string, SourceLiftContext>();
  const getSourceLiftContext = (sourceFileInput: string): SourceLiftContext => {
    const sourceFile = normalizeDeobfSourceFile(sourceFileInput);
    if (sourceFile.length === 0) {
      throw new Error("Missing source file for lift context.");
    }
    const cached = sourceLiftContextCache.get(sourceFile);
    if (cached) return cached;
    const sourceChunk = readSourceChunkForSourceFile(sourceFile);
    const declarationStatsRows = inspectLiftSourceDeclarations({
      sourceFilePath: sourceFile,
      sourceText: sourceChunk,
    });
    const declarationStatsByName = new Map<string, LiftDeclarationStat[]>();
    for (const stat of declarationStatsRows) {
      const bucket = declarationStatsByName.get(stat.name) ?? [];
      bucket.push(stat);
      declarationStatsByName.set(stat.name, bucket);
    }
    const declarationGraphRows = inspectLiftDeclarationGraph({
      sourceFilePath: sourceFile,
      sourceText: sourceChunk,
    });
    const declarationGraphByName = new Map<string, LiftDeclarationGraphNode[]>();
    for (const node of declarationGraphRows) {
      const bucket = declarationGraphByName.get(node.name) ?? [];
      bucket.push(node);
      declarationGraphByName.set(node.name, bucket);
    }
    const context: SourceLiftContext = {
      sourceFile,
      sourceChunk,
      declarationStatsRows,
      declarationStatsByName,
      declarationGraphByName,
    };
    sourceLiftContextCache.set(sourceFile, context);
    return context;
  };

  type ReconstructedTargetRow = {
    targetPath: string;
    sourceFile: string;
    confidence: number;
    symbols: Set<string>;
    references: Set<string>;
    rationale: Set<string>;
    exportsByName: Map<
      string,
      {
        sourceSymbol: string;
        kind: LiftedExportKind;
        sourceLine: number;
        confidence: number;
        }
    >;
  };
  const semanticIrModel = buildSemanticIrFromDeobfuscationTable(input.deobfuscationTable);
  const ownershipResolution = resolveSemanticOwnership(semanticIrModel);
  const semanticModules = ownershipResolution.model.modules;
  const targetSymbolEntriesByPath = buildTargetSymbolEntriesIndexFromSemanticModules(semanticModules);
  const byTargetPath = new Map<string, ReconstructedTargetRow>();

  for (const module of semanticModules) {
    const sourceFile = normalizeDeobfSourceFile(module.sourceFile);
    if (sourceFile.length === 0) continue;
    const targetPath = toProjectRelativeTargetPath(module.modulePath);
    const row: ReconstructedTargetRow = {
      targetPath,
      sourceFile,
      confidence: module.confidence,
      symbols: new Set<string>(),
      references: new Set<string>(),
      rationale: new Set<string>(),
      exportsByName: new Map(),
    };
    row.rationale.add(`semantic-ir: layer=${module.ownerLayer}`);
    for (const reason of module.rationale) {
      const normalized = reason.trim();
      if (normalized.length === 0) continue;
      row.rationale.add(normalized);
    }
    for (const reference of module.references) {
      const normalized = reference.trim();
      if (normalized.length === 0) continue;
      row.references.add(normalized);
    }
    for (const symbol of module.symbols) {
      const exportName = sanitizeExportIdentifierName(symbol.exportedName);
      if (exportName === "symbol_export") continue;
      row.symbols.add(exportName);
      if (symbol.reference.trim().length > 0) row.references.add(symbol.reference.trim());
      for (const reason of symbol.rationale) {
        const normalized = reason.trim();
        if (normalized.length === 0) continue;
        row.rationale.add(normalized);
      }
      const currentExport = row.exportsByName.get(exportName);
      if (!currentExport || symbol.confidence > currentExport.confidence) {
        row.exportsByName.set(exportName, {
          sourceSymbol: symbol.sourceSymbol,
          kind: symbol.kind,
          sourceLine: symbol.sourceLine,
          confidence: symbol.confidence,
        });
      }
    }
    byTargetPath.set(targetPath, row);
  }

  let reconstructedFiles = 0;
  const reconstructedMapRows: Array<{
    targetPath: string;
    emittedPath: string;
    sourceFile: string;
    chunkArtifactPath: string;
    confidence: number;
    symbols: string[];
    exports: Array<{ name: string; sourceSymbol: string; kind: LiftedExportKind; sourceLine: number; confidence: number }>;
    references: string[];
    rationale: string[];
  }> = [];
  const lifterDiagnosticsRows: Array<{
    emittedPath: string;
    sourceFile: string;
    sourceChunkArtifactPath: string;
    moduleArchetype: string;
    candidateExportsRaw: number;
    candidateExports: number;
    selectedExports: number;
    droppedExports: number;
    droppedExportsByBudget: number;
    droppedExportsByTemplateCap: number;
    hookTransportRenamed: number;
    serviceRenamed: number;
    templateAddedRequiredKinds: number;
    templateImportCount: number;
    importContractViolated: boolean;
    importSpecifierRewrites: number;
    statementBudget: number;
    maxPrimaryStatementLength: number;
    maxDependencyStatementLength: number;
    dependencyTrimmed: boolean;
    skippedDependencies: number;
    skippedOversizedDependencies: number;
    liftedExports: number;
    unresolvedExports: number;
    unresolvedRequiredExports: number;
    includedStatements: number;
    renameCandidates: number;
    renamedDeclarations: number;
    skippedRenames: number;
    rewrittenReferenceSymbols: number;
    rewrittenReferenceIdentifiers: number;
    usedTsNoCheck: boolean;
    placeholderMode: boolean;
    chunkBridgeMode: boolean;
    targetedRecoveredExports: number;
    recoveryModeUsed: boolean;
    parserRegistryUnpackUsed: boolean;
    sourceSwitchUsed: boolean;
  }> = [];

  const sortedTargets = Array.from(byTargetPath.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  const semanticModuleByTargetPath = new Map<string, SemanticIrModule>(
    semanticModules.map((module) => [toProjectRelativeTargetPath(module.modulePath), module]),
  );
  const emittedModulePaths: string[] = [];
  for (const row of sortedTargets) {
    let activeSourceFile = normalizeDeobfSourceFile(row.sourceFile);
    const emittedPath = normalizeTargetModulePath(row.targetPath);
    const semanticModule = semanticModuleByTargetPath.get(row.targetPath);
    const semanticModuleForContract =
      semanticModule ?? {
        modulePath: row.targetPath,
        ownerLayer: "unknown",
        sourceFile: activeSourceFile,
        confidence: row.confidence,
        symbols: [],
        references: [],
        rationale: [],
      };
    const buildSynthesisContract = (candidateExports: number) =>
      buildModuleSynthesisContract({
        module: semanticModuleForContract,
        candidateExports,
      });
    const targetEntries = targetSymbolEntriesByPath.get(row.targetPath) ?? [];
    const targetEntriesBySourceFile = groupTargetEntriesBySourceFile(targetEntries);
    const sourceCandidateOrder = rankSourceFileCandidates(targetEntriesBySourceFile, activeSourceFile).slice(0, 10);
    const buildCandidateRowsForSource = (sourceFile: string): RankedExportRow[] => {
      const sourceContext = getSourceLiftContext(sourceFile);
      const indexedCandidateRows = buildRankedExportRowsFromTargetEntries({
        entries: targetEntriesBySourceFile.get(sourceFile) ?? [],
        sourceFile,
        declarationStatsByName: sourceContext.declarationStatsByName,
      });
      const ownedIndexedRows = filterOwnedExportRows(indexedCandidateRows);
      if (ownedIndexedRows.length > 0) {
        return ownedIndexedRows;
      }
      const aliasRows = buildRankedExportRowsFromSourceAliases({
        sourceChunk: sourceContext.sourceChunk,
        declarationStatsByName: sourceContext.declarationStatsByName,
        confidence: row.confidence,
      });
      if (aliasRows.length > 0) {
        return aliasRows;
      }
      const topDeclarationRows = buildRankedExportRowsFromTopDeclarations({
        declarationStatsRows: sourceContext.declarationStatsRows,
        confidence: row.confidence,
      });
      if (topDeclarationRows.length > 0) {
        return topDeclarationRows;
      }
      return indexedCandidateRows;
    };

    const evaluateSourceCandidate = (sourceFile: string, rows: RankedExportRow[]): { score: number; parserRegistryRows: number } => {
      const sourceContext = getSourceLiftContext(sourceFile);
      const alignedRowsRaw = applyModuleAlignmentSignals(rows, emittedPath);
      const synthesisContract = buildSynthesisContract(alignedRowsRaw.length);
      const clusteredRows = applyArchetypeAndCluster({
        rows: alignedRowsRaw,
        declarationGraphByName: sourceContext.declarationGraphByName,
        contract: synthesisContract,
        emittedPath,
      });
      const alignedRows = clusteredRows.length > 0 ? clusteredRows : alignedRowsRaw;
      const callableCount = alignedRows.filter((item) => item.kind === "class" || item.kind === "function").length;
      const alignmentAggregate =
        alignedRows.reduce((sum, item) => sum + scoreModulePathAlignment(item.name, emittedPath), 0) /
        Math.max(1, alignedRows.length);
      const generatedAggregate =
        alignedRows.reduce((sum, item) => sum + item.generatedSignal, 0) / Math.max(1, alignedRows.length);
      const oversizedDeclarationRatio =
        alignedRows.filter((item) => item.declarationLength > 9000).length / Math.max(1, alignedRows.length);
      let parserRegistryRows = 0;
      for (const item of alignedRows) {
        const stat = pickDeclarationStatForExport(
          sourceContext.declarationStatsByName.get(item.sourceSymbol) ?? [],
          item.kind,
          item.sourceLine,
        );
        if (!stat) continue;
        if (isParserRegistryDeclaration(stat, sourceContext.sourceChunk)) {
          parserRegistryRows += 1;
        }
      }
      const parserPenalty = parserRegistryRows > 0 ? (parserRegistryRows / rows.length) * 28 : 0;
      const generatedPenalty = generatedAggregate * 46 + oversizedDeclarationRatio * 28;
      const score =
        alignedRows.length * 12 +
        callableCount * 20 +
        (alignedRows[0]?.confidence ?? 0) * 100 +
        (alignedRows[0]?.nameQuality ?? 0) * 40 +
        alignmentAggregate * 22 -
        parserPenalty -
        generatedPenalty;
      return { score, parserRegistryRows };
    };

    let sourceSwitchUsed = false;
    let activeSourceContext = getSourceLiftContext(activeSourceFile);
    let candidateExportRows = buildCandidateRowsForSource(activeSourceFile);
    const activeOwnedRows = filterOwnedExportRows(candidateExportRows);
    const activeEvaluation =
      activeOwnedRows.length > 0
        ? evaluateSourceCandidate(activeSourceFile, activeOwnedRows)
        : { score: Number.NEGATIVE_INFINITY, parserRegistryRows: 0 };
    let bestAlternative:
      | {
          sourceFile: string;
          rows: RankedExportRow[];
          score: number;
          parserRegistryRows: number;
        }
      | undefined;
    for (const candidateSourceFile of sourceCandidateOrder) {
      if (candidateSourceFile === activeSourceFile) continue;
      const candidateRows = buildCandidateRowsForSource(candidateSourceFile);
      const ownedCandidateRows = filterOwnedExportRows(candidateRows);
      if (ownedCandidateRows.length === 0) continue;
      const candidateEvaluation = evaluateSourceCandidate(candidateSourceFile, ownedCandidateRows);
      if (!bestAlternative || candidateEvaluation.score > bestAlternative.score) {
        bestAlternative = {
          sourceFile: candidateSourceFile,
          rows: ownedCandidateRows,
          score: candidateEvaluation.score,
          parserRegistryRows: candidateEvaluation.parserRegistryRows,
        };
      }
    }
    if (bestAlternative) {
      const activeParserHeavy = activeEvaluation.parserRegistryRows > 0;
      const shouldSwitch =
        activeOwnedRows.length === 0 ||
        bestAlternative.score > activeEvaluation.score + 18 ||
        (activeParserHeavy && bestAlternative.score >= activeEvaluation.score);
      if (shouldSwitch) {
        sourceSwitchUsed = true;
        const previousSourceFile = activeSourceFile;
        activeSourceFile = bestAlternative.sourceFile;
        activeSourceContext = getSourceLiftContext(activeSourceFile);
        candidateExportRows = bestAlternative.rows;
        row.rationale.add(`source-switch: ${previousSourceFile} -> ${activeSourceFile}`);
      }
    }

    const ensuredArtifact = ensureChunkArtifactForSourceFile(activeSourceFile);
    const chunkArtifactPath = ensuredArtifact.chunkArtifactPath;
    const sourceChunk = ensuredArtifact.sourceChunk;

    const alignedCandidateRowsRaw = applyModuleAlignmentSignals(candidateExportRows, emittedPath);
    const synthesisContract = buildSynthesisContract(alignedCandidateRowsRaw.length);
    const clusteredCandidateRows = applyArchetypeAndCluster({
      rows: alignedCandidateRowsRaw,
      declarationGraphByName: activeSourceContext.declarationGraphByName,
      contract: synthesisContract,
      emittedPath,
    });
    const alignedCandidateRows = clusteredCandidateRows.length > 0 ? clusteredCandidateRows : alignedCandidateRowsRaw;
    const selectedExports = selectPrimaryExports({
      rows: alignedCandidateRows,
      moduleConfidence: row.confidence,
    });
    const renamedRows = applyTargetedExportRenames(selectedExports.selected, emittedPath).slice(
      0,
      synthesisContract.maxSelectedExports,
    );
    const hookTransportPass = applyHookTransportQualityPass({
      rows: renamedRows,
      emittedPath,
      archetype: synthesisContract.kind,
    });
    const servicePass = applyServiceQualityPass({
      rows: hookTransportPass.rows,
      emittedPath,
      archetype: synthesisContract.kind,
    });
    const templateEmission = emitArchetypeModule({
      sourceFilePath: activeSourceFile,
      sourceText: sourceChunk,
      emittedPath,
      contract: synthesisContract,
      selectedRows: servicePass.rows,
      candidateRows: alignedCandidateRows,
    });
    const exportRows = templateEmission.exportRows;
    const lifted = templateEmission.lifted;
    const parserRegistryUnpackUsed = false;
    const targetedRecoveredExports = 0;
    const unresolvedRequired = templateEmission.unresolvedRequired;
    for (const unresolved of unresolvedRequired) {
      row.rationale.add(
        `lifter-unresolved: ${unresolved.kind}:${unresolved.sourceSymbol}->${unresolved.exportName}@${unresolved.sourceLine}`,
      );
    }
    if (templateEmission.diagnostics.importContractViolated) {
      row.rationale.add(
        `template-import-contract: violated archetype=${templateEmission.diagnostics.archetype} importCount=${templateEmission.diagnostics.importCount}`,
      );
    }
    const droppedExportsByBudget = templateEmission.diagnostics.droppedByTemplateBudget;
    const droppedExportsByTemplateCap = templateEmission.diagnostics.droppedByTemplateCap;
    const totalDroppedExports = selectedExports.dropped.length + droppedExportsByBudget + droppedExportsByTemplateCap;
    const statementBudget = synthesisContract.statementBudget;
    const maxPrimaryStatementLength = synthesisContract.maxPrimaryStatementLength;
    const maxDependencyStatementLength = synthesisContract.maxDependencyStatementLength;
    const shouldUseTsNoCheck = true;
    const rewrittenImports = rewriteChunkLocalImportSpecifiers({
      moduleBody: templateEmission.moduleBody,
      sourceFile: activeSourceFile,
      emittedPath,
    });
    const moduleBody = rewrittenImports.moduleBody;
    if (rewrittenImports.rewrites > 0) {
      row.rationale.add(`chunk-import-rewrite: ${rewrittenImports.rewrites}`);
    }
    const headerLines = [
      "/**",
      " * Generated by reverse/deobfuscation pipeline.",
      " * Lift mode: ast-symbol-lifter.",
      ` * Template archetype: ${templateEmission.diagnostics.archetype}`,
      ` * Source chunk: ${activeSourceFile}`,
      ` * Chunk artifact: ${chunkArtifactPath}`,
      ` * Confidence: ${row.confidence}`,
      ` * Exports: selected=${exportRows.length}, lifted=${lifted.liftedExports.length}, unresolved=${lifted.unresolvedExports.length}, dropped=${totalDroppedExports}`,
      ` * Template contract: requiredKinds=${synthesisContract.requiredSymbolKinds.join("|")}, importCount=${templateEmission.diagnostics.importCount}, importContractViolated=${templateEmission.diagnostics.importContractViolated}, importSpecifierRewrites=${rewrittenImports.rewrites}, exportWeightBudget=${templateEmission.diagnostics.exportWeightBudget}`,
      ` * Parser/registry unpack: ${parserRegistryUnpackUsed ? "enabled" : "disabled"}`,
      " * Chunk bridge mode: disabled",
      " * Controlled recovery mode: disabled",
      " */",
      "",
      ...(shouldUseTsNoCheck ? ["// @ts-nocheck", ""] : []),
    ];
    const moduleSource = `${headerLines.join("\n")}${moduleBody}`;

    const destinationPath = path.join(projectRoot, emittedPath);
    ensureDir(path.dirname(destinationPath));
    fs.writeFileSync(destinationPath, moduleSource, "utf8");
    emittedModulePaths.push(emittedPath);
    reconstructedFiles += 1;

    reconstructedMapRows.push({
      targetPath: row.targetPath,
      emittedPath,
      sourceFile: activeSourceFile,
      chunkArtifactPath,
      confidence: row.confidence,
      symbols: Array.from(row.symbols).sort((a, b) => a.localeCompare(b)),
      exports: exportRows.filter((item) =>
        lifted.liftedExports.some(
          (liftedExport) =>
            liftedExport.exportName === item.name &&
            liftedExport.kind === item.kind,
        ),
      ),
      references: Array.from(row.references).sort((a, b) => a.localeCompare(b)),
      rationale: Array.from(row.rationale).sort((a, b) => a.localeCompare(b)),
    });
    lifterDiagnosticsRows.push({
      emittedPath,
      sourceFile: activeSourceFile,
      sourceChunkArtifactPath: chunkArtifactPath,
      moduleArchetype: synthesisContract.kind,
      candidateExportsRaw: alignedCandidateRowsRaw.length,
      candidateExports: alignedCandidateRows.length,
      selectedExports: exportRows.length,
      droppedExports: selectedExports.dropped.length,
      droppedExportsByBudget,
      droppedExportsByTemplateCap,
      hookTransportRenamed: hookTransportPass.renamed,
      serviceRenamed: servicePass.renamed,
      templateAddedRequiredKinds: templateEmission.diagnostics.addedRequiredKinds.length,
      templateImportCount: templateEmission.diagnostics.importCount,
      importContractViolated: templateEmission.diagnostics.importContractViolated,
      importSpecifierRewrites: rewrittenImports.rewrites,
      statementBudget: lifted.dependencyBudget,
      maxPrimaryStatementLength,
      maxDependencyStatementLength,
      dependencyTrimmed: lifted.dependencyTrimmed,
      skippedDependencies: lifted.skippedDependencies,
      skippedOversizedDependencies: lifted.skippedOversizedDependencies,
      liftedExports: lifted.liftedExports.length,
      unresolvedExports: lifted.unresolvedExports.length,
      unresolvedRequiredExports: unresolvedRequired.length,
      includedStatements: lifted.includedStatements,
      renameCandidates: lifted.renameCandidates,
      renamedDeclarations: lifted.renamedDeclarations,
      skippedRenames: lifted.skippedRenames,
      rewrittenReferenceSymbols: lifted.rewrittenReferenceSymbols,
      rewrittenReferenceIdentifiers: lifted.rewrittenReferenceIdentifiers,
      usedTsNoCheck: shouldUseTsNoCheck,
      placeholderMode: false,
      chunkBridgeMode: false,
      targetedRecoveredExports,
      recoveryModeUsed: false,
      parserRegistryUnpackUsed,
      sourceSwitchUsed,
    });
  }

  const generatedBarrelIndexes = buildLayerBarrelIndexes(projectRoot, emittedModulePaths);
  const chunkArtifactRows = Array.from(chunkArtifactBySourceFile.entries())
    .map(([sourceFile, artifactPath]) => ({ sourceFile, artifactPath }))
    .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));

  const mappingArtifacts = [
    "mapping/chunk-artifacts.json",
    "src/chunks/",
    "mapping/deobfuscation-table.json",
    "mapping/deobfuscation-table.md",
    "mapping/deobfuscation-table.csv",
    "mapping/rename-plan.md",
    "mapping/reconstructed-map.json",
    "mapping/lifter-diagnostics.json",
    "mapping/component-boundaries.json",
    "mapping/session-flow.json",
    "mapping/session-flow.md",
    "mapping/route-boundary-graph.json",
    "mapping/reference-parity-gaps.json",
    "mapping/runtime-probe.json",
    "mapping/reference-model.json",
    "mapping/reference-signals.json",
    "mapping/reference-symbols.json",
    "mapping/semantic-ir.json",
    "mapping/ownership-resolution.json",
    ...generatedBarrelIndexes,
  ];

  writeJson(path.join(mappingRoot, "chunk-artifacts.json"), chunkArtifactRows);
  writeJson(path.join(mappingRoot, "deobfuscation-table.json"), input.deobfuscationTable);
  fs.writeFileSync(path.join(mappingRoot, "deobfuscation-table.md"), input.deobfuscationMarkdown, "utf8");
  fs.writeFileSync(path.join(mappingRoot, "deobfuscation-table.csv"), input.deobfuscationCsv, "utf8");
  fs.writeFileSync(path.join(mappingRoot, "rename-plan.md"), input.renamePlanMarkdown, "utf8");
  writeJson(path.join(mappingRoot, "reconstructed-map.json"), reconstructedMapRows);
  writeJson(path.join(mappingRoot, "lifter-diagnostics.json"), lifterDiagnosticsRows);
  writeJson(path.join(mappingRoot, "component-boundaries.json"), input.componentBoundaries);
  writeJson(path.join(mappingRoot, "session-flow.json"), input.sessionFlow);
  fs.writeFileSync(path.join(mappingRoot, "session-flow.md"), input.sessionFlowMarkdown, "utf8");
  writeJson(path.join(mappingRoot, "route-boundary-graph.json"), input.routeBoundaryGraph);
  writeJson(path.join(mappingRoot, "reference-parity-gaps.json"), input.referenceParityGaps);
  writeJson(path.join(mappingRoot, "runtime-probe.json"), input.runtimeProbe);
  writeJson(path.join(mappingRoot, "reference-model.json"), input.referenceModel);
  writeJson(path.join(mappingRoot, "reference-signals.json"), input.referenceSignals);
  writeJson(path.join(mappingRoot, "reference-symbols.json"), input.referenceSymbols);
  writeJson(path.join(mappingRoot, "semantic-ir.json"), ownershipResolution.model);
  writeJson(path.join(mappingRoot, "ownership-resolution.json"), ownershipResolution.diagnostics);

  const generatedPackageJson = {
    name: "codex-app-reverse-test-project",
    private: true,
    version: "0.0.0",
    description: "Generated reverse/deobfuscation workspace for WebStorm inspection.",
    type: "module",
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      lint: "eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json",
      stats: "node ./tools/print-stats.mjs",
    },
    dependencies: {
      eslint: "^9.20.0",
      typescript: "^5.9.2",
    },
  };
  writeJson(path.join(projectRoot, "package.json"), generatedPackageJson);

  const tsconfigJson = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      allowJs: true,
      checkJs: false,
      noEmit: true,
      strict: false,
      skipLibCheck: true,
      baseUrl: ".",
      paths: {
        "@main/*": ["src/main/*"],
        "@renderer/*": ["src/renderer/*"],
        "@services/*": ["src/services/*"],
        "@tauri/*": ["src-tauri-adapter/*"],
      },
    },
    include: ["src/**/*", "src-tauri-adapter/**/*", "mapping/**/*.json"],
  };
  writeJson(path.join(projectRoot, "tsconfig.json"), tsconfigJson);
  writeJson(path.join(projectRoot, "jsconfig.json"), tsconfigJson);

  const eslintConfig = [
    "module.exports = [",
    "  {",
    "    files: ['src/**/*.{js,mjs,cjs,ts,tsx}', 'src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx}'],",
    "    languageOptions: {",
      "      ecmaVersion: 'latest',",
    "      sourceType: 'module',",
    "    },",
    "    rules: {},",
    "  },",
    "  {",
    "    ignores: ['mapping/**', 'meta/**', 'tools/**', 'node_modules/**'],",
    "  },",
    "];",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectRoot, "eslint.config.cjs"), eslintConfig, "utf8");

  fs.writeFileSync(
    path.join(projectRoot, ".gitignore"),
    "node_modules/\n.idea/\n.DS_Store\n",
    "utf8",
  );

  const statsScript = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "",
    "const tablePath = path.resolve(process.cwd(), 'mapping', 'deobfuscation-table.json');",
    "if (!fs.existsSync(tablePath)) {",
    "  console.error('mapping/deobfuscation-table.json not found');",
    "  process.exit(1);",
    "}",
    "const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));",
    "console.log(JSON.stringify({",
    "  mappedFiles: table.coverage?.mappedFiles ?? 0,",
    "  mappedSymbols: table.coverage?.mappedSymbols ?? 0,",
    "  filePlans: Array.isArray(table.filePlans) ? table.filePlans.length : 0,",
    "  entries: Array.isArray(table.entries) ? table.entries.length : 0,",
    "}, null, 2));",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(toolsRoot, "print-stats.mjs"), statsScript, "utf8");

  const readme = [
    "# Project",
    "",
    "Generated by `scripts/ts/reverse.ts` from decompiled chunks + deobfuscation mappings.",
    "",
    "## Open In WebStorm",
    "1. Open this folder in WebStorm.",
    "2. Let indexing finish.",
    "3. Start from `mapping/rename-plan.md` and `mapping/deobfuscation-table.csv`.",
    "",
    "## Structure",
    "- `src/main/`, `src/renderer/`, `src/services/` TS-first reconstructed modules with lifted symbol declarations.",
    "- `src/**/index.ts` layer barrel files for fast navigation and clean entry points.",
    "- `src-tauri-adapter/` bridge modules for tauri/daemon-related targets.",
    "- `src/chunks/` one raw source artifact per mapped chunk (`.js`) for traceability.",
    "- `mapping/` generated maps and flow reports.",
    "- `meta/` source package metadata and generation info.",
    "",
    "## Quick Commands",
    "- `npm install`",
    "- `npm run lint`",
    "- `npm run stats`",
    "- `npm run typecheck`",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(projectRoot, "README.md"), `${readme}\n`, "utf8");

  const checks = runGeneratedProjectChecks(projectRoot);

  writeJson(path.join(metaRoot, "source-package.json"), input.sourcePackage);
  writeJson(path.join(metaRoot, "checks.json"), checks);
  writeJson(path.join(metaRoot, "generation.json"), {
    generatedAtUtc: new Date().toISOString(),
    appDir: toPosixPath(input.appDir),
    decompiledDir: toPosixPath(input.decompiledDir),
    chunkFiles,
    mappedTargets: reconstructedMapRows.length,
    reconstructedFiles,
    checks,
  });

  return {
    rootPath: toPosixPath(projectRoot),
    chunkFiles,
    reconstructedFiles,
    mappedTargets: reconstructedMapRows.length,
    mappingArtifacts,
    checks,
  };
}
