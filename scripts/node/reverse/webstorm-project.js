"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWebStormTestProject = buildWebStormTestProject;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const exec_1 = require("../lib/exec");
const deobfuscation_report_1 = require("./deobfuscation-report");
const symbol_lifter_1 = require("./symbol-lifter");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function writeJson(filePath, data) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
function readUtf8(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
function normalizeSourceForPrint(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
        .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}
function parseSourceLineHint(value) {
    const match = value.match(/:(\d+)$/);
    if (!match)
        return 0;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 0;
    return Math.floor(parsed);
}
function toChunkArtifactPath(sourceFile) {
    const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}
function normalizeTargetModulePath(targetPath) {
    const normalized = toPosixPath(targetPath).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:tsx?|jsx|mjs|cjs|js)$/i, ".ts");
}
function toModuleSpecifier(fromDirectory, targetFilePath) {
    const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
    const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
    const relative = path.posix.relative(from, target);
    const normalized = relative.startsWith(".") ? relative : `./${relative}`;
    return normalized;
}
function collectBarrelRootsForDirectory(inputDir) {
    const directory = toPosixPath(inputDir).replace(/^\.?\//, "");
    const roots = ["src/main", "src/renderer", "src/services", "src-tauri-adapter"];
    if (roots.includes(directory))
        return [directory];
    return roots.filter((root) => directory.startsWith(`${root}/`));
}
function buildLayerBarrelIndexes(projectRoot, emittedModulePaths) {
    const modulePaths = emittedModulePaths
        .map((item) => toPosixPath(item).replace(/^\.?\//, ""))
        .filter((item) => item.endsWith(".ts") && !item.endsWith("/index.ts"));
    if (modulePaths.length === 0)
        return [];
    const directoryModules = new Map();
    const allDirectories = new Set();
    for (const modulePath of modulePaths) {
        const moduleDirectory = path.posix.dirname(modulePath);
        const moduleName = path.posix.basename(modulePath, ".ts");
        const moduleBucket = directoryModules.get(moduleDirectory) ?? new Set();
        moduleBucket.add(moduleName);
        directoryModules.set(moduleDirectory, moduleBucket);
        const applicableRoots = collectBarrelRootsForDirectory(moduleDirectory);
        for (const root of applicableRoots) {
            let cursor = moduleDirectory;
            while (true) {
                allDirectories.add(cursor);
                if (cursor === root)
                    break;
                const parent = path.posix.dirname(cursor);
                if (parent === cursor)
                    break;
                cursor = parent;
            }
        }
    }
    const createdIndexes = [];
    const sortedDirectories = Array.from(allDirectories).sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
    for (const directory of sortedDirectories) {
        const files = Array.from(directoryModules.get(directory) ?? []).sort((a, b) => a.localeCompare(b));
        const childDirectories = Array.from(allDirectories)
            .filter((item) => path.posix.dirname(item) === directory)
            .sort((a, b) => a.localeCompare(b));
        const lines = [];
        for (const fileName of files) {
            lines.push(`export * from "${toModuleSpecifier(directory, path.posix.join(directory, `${fileName}.ts`))}";`);
        }
        for (const childDirectory of childDirectories) {
            lines.push(`export * from "${toModuleSpecifier(directory, path.posix.join(childDirectory, "index.ts"))}";`);
        }
        if (lines.length === 0)
            continue;
        const indexPath = path.join(projectRoot, ...directory.split("/"), "index.ts");
        (0, exec_1.ensureDir)(path.dirname(indexPath));
        fs.writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
        createdIndexes.push(toPosixPath(path.posix.join(directory, "index.ts")));
    }
    return createdIndexes.sort((a, b) => a.localeCompare(b));
}
function toSafeExportIdentifier(input) {
    const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized))
        return normalized;
    return "symbol_export";
}
const NOISY_IDENTIFIER_SUFFIXES = new Set([
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
function splitIdentifierTokens(input) {
    const normalized = input
        .replace(/[_\-./:]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    return normalized
        .split(/\s+/g)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}
function isNoisyIdentifierToken(token) {
    const normalized = token.trim().toLowerCase();
    if (normalized.length === 0)
        return false;
    if (NOISY_IDENTIFIER_SUFFIXES.has(normalized))
        return true;
    if (/^v\d{1,4}$/i.test(normalized))
        return true;
    if (/^(?:renderer|worker|assets|chunk|main|services|tauri|src)\d{1,4}$/i.test(normalized))
        return true;
    if (/^[a-z]{1,4}\d{1,6}[a-z0-9]*$/i.test(normalized))
        return true;
    if (/^\d+[a-z0-9]+$/i.test(normalized))
        return true;
    if (normalized.length >= 6 && /\d/.test(normalized) && !/[aeiou]/i.test(normalized))
        return true;
    return false;
}
function buildIdentifierFromTokens(tokens, preferPascalCase) {
    const cleaned = tokens
        .map((token) => token.replace(/[^A-Za-z0-9_$]/g, ""))
        .filter((token) => token.length > 0);
    if (cleaned.length === 0)
        return "";
    const pascal = cleaned
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
        .join("");
    if (preferPascalCase)
        return pascal;
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
function stripNoisyExportSuffix(input) {
    const tokens = splitIdentifierTokens(input);
    if (tokens.length <= 1)
        return input;
    let end = tokens.length;
    while (end > 1 && isNoisyIdentifierToken(tokens[end - 1] ?? "")) {
        end -= 1;
    }
    if (end === tokens.length)
        return input;
    const preferPascalCase = /^[A-Z]/.test(input);
    const rebuilt = buildIdentifierFromTokens(tokens.slice(0, end), preferPascalCase);
    if (rebuilt.length < 3)
        return input;
    return rebuilt;
}
function sanitizeExportIdentifierName(input) {
    const stripped = stripNoisyExportSuffix(input);
    const preferred = toSafeExportIdentifier(stripped);
    if (preferred !== "symbol_export")
        return preferred;
    return toSafeExportIdentifier(input);
}
function getExportKindPriority(kind) {
    if (kind === "class")
        return 400;
    if (kind === "function")
        return 300;
    return 100;
}
const GLOBAL_BUILTIN_SYMBOLS = new Set([
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
function isGlobalBuiltinSymbol(value) {
    return GLOBAL_BUILTIN_SYMBOLS.has(value.trim().toLowerCase());
}
function isParserRegistryChunkSource(sourceChunk) {
    if (sourceChunk.length < 1200)
        return false;
    const normalized = sourceChunk.toLowerCase();
    return (normalized.includes("symbols_:") ||
        normalized.includes("terminals_:") ||
        normalized.includes("productions_:") ||
        normalized.includes("performaction") ||
        normalized.includes("rules: [") ||
        normalized.includes("conditions: {"));
}
function isParserRegistryDeclaration(stat, sourceChunk) {
    if (stat.generatedSignal < 0.75)
        return false;
    if (stat.statementLength < 4200)
        return false;
    return isParserRegistryChunkSource(sourceChunk);
}
function filterOwnedExportRows(rows) {
    const deduped = new Map();
    for (const row of rows) {
        if (!row.hasDeclaration)
            continue;
        if (isGlobalBuiltinSymbol(row.sourceSymbol))
            continue;
        const key = `${row.sourceSymbol}|${row.kind}`;
        const current = deduped.get(key);
        if (!current || computeSelectionScore(row) > computeSelectionScore(current)) {
            deduped.set(key, row);
        }
    }
    return Array.from(deduped.values()).sort((a, b) => {
        const scoreDelta = computeSelectionScore(b) - computeSelectionScore(a);
        if (scoreDelta !== 0)
            return scoreDelta;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.nameQuality !== b.nameQuality)
            return b.nameQuality - a.nameQuality;
        if (a.generatedSignal !== b.generatedSignal)
            return a.generatedSignal - b.generatedSignal;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        return a.name.localeCompare(b.name);
    });
}
function groupTargetEntriesBySourceFile(entries) {
    const grouped = new Map();
    for (const entry of entries) {
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(entry.sourceFile);
        if (sourceFile.length === 0)
            continue;
        const bucket = grouped.get(sourceFile) ?? [];
        bucket.push(entry);
        grouped.set(sourceFile, bucket);
    }
    return grouped;
}
function rankSourceFileCandidates(entriesBySourceFile, preferredSourceFile) {
    const preferred = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(preferredSourceFile);
    return Array.from(entriesBySourceFile.entries())
        .map(([sourceFile, entries]) => {
        let maxConfidence = 0;
        let callableCount = 0;
        const uniqueSymbols = new Set();
        for (const entry of entries) {
            if (entry.confidence > maxConfidence)
                maxConfidence = entry.confidence;
            if (entry.kind === "class" || entry.kind === "function")
                callableCount += 1;
            uniqueSymbols.add(entry.sourceSymbol);
        }
        const preferredBoost = sourceFile === preferred ? 18 : 0;
        const score = preferredBoost + maxConfidence * 100 + callableCount * 3 + Math.min(16, uniqueSymbols.size);
        return { sourceFile, score };
    })
        .sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        return a.sourceFile.localeCompare(b.sourceFile);
    })
        .map((row) => row.sourceFile);
}
function isNoisyGeneratedExportName(input) {
    if (/(renderer\d+$|main\d+$|services\d+$|tauri\d+$|var[a-z0-9_]+$|assets\d+$|src\d+$)/i.test(input)) {
        return true;
    }
    const stripped = stripNoisyExportSuffix(input);
    if (stripped !== input)
        return true;
    const tokens = splitIdentifierTokens(input);
    const tail = tokens[tokens.length - 1] ?? "";
    if (isNoisyIdentifierToken(tail))
        return true;
    return /[A-Za-z]{2,}\d{2,}$/i.test(input);
}
function clamp01(value) {
    if (value <= 0)
        return 0;
    if (value >= 1)
        return 1;
    return value;
}
function scoreExportNameQuality(input) {
    let score = 1;
    if (isNoisyGeneratedExportName(input))
        score -= 0.45;
    if (stripNoisyExportSuffix(input) !== input)
        score -= 0.2;
    if (/V\d{2,}$/i.test(input))
        score -= 0.4;
    if (/\d{3,}$/i.test(input))
        score -= 0.35;
    if (/(?:^|_)(tmp|temp|var|misc|unknown|value|data)$/i.test(input))
        score -= 0.2;
    if (/^[a-z]{1,2}$/i.test(input))
        score -= 0.3;
    if (/(?:[A-Z][a-z]+){1,}V\d{2,}/.test(input))
        score -= 0.1;
    return clamp01(score);
}
const MODULE_CONTEXT_STOPWORDS = new Set([
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
function collectModuleContextTokens(emittedPath) {
    const normalized = toPosixPath(emittedPath).replace(/^\.?\//, "").replace(/\.[^.]+$/i, "");
    const parts = normalized.split("/");
    const windowedParts = parts.slice(Math.max(0, parts.length - 4));
    const tokens = [];
    for (const part of windowedParts) {
        for (const token of splitIdentifierTokens(part)) {
            const normalizedToken = token.toLowerCase();
            if (normalizedToken.length < 3)
                continue;
            if (MODULE_CONTEXT_STOPWORDS.has(normalizedToken))
                continue;
            if (isNoisyIdentifierToken(normalizedToken))
                continue;
            tokens.push(normalizedToken);
        }
    }
    return Array.from(new Set(tokens));
}
function scoreModulePathAlignment(name, emittedPath) {
    const moduleTokens = collectModuleContextTokens(emittedPath);
    if (moduleTokens.length === 0)
        return 0;
    const moduleSet = new Set(moduleTokens);
    const nameTokens = splitIdentifierTokens(name)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3 && !isNoisyIdentifierToken(token));
    if (nameTokens.length === 0)
        return 0;
    let directHits = 0;
    let partialHits = 0;
    for (const token of nameTokens) {
        if (moduleSet.has(token)) {
            directHits += 1;
            continue;
        }
        const hasPartial = moduleTokens.some((moduleToken) => moduleToken.startsWith(token) || token.startsWith(moduleToken));
        if (hasPartial)
            partialHits += 1;
    }
    const moduleStem = path.posix.basename(toPosixPath(emittedPath), path.posix.extname(toPosixPath(emittedPath))).toLowerCase();
    const exactStemBonus = moduleStem === name.toLowerCase() ? 1.8 : 0;
    return directHits + partialHits * 0.35 + exactStemBonus;
}
function scoreContextualExportNameQuality(name, emittedPath) {
    const tokens = splitIdentifierTokens(name)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 2);
    let score = scoreExportNameQuality(name);
    if (tokens.length === 0)
        return score;
    const startsWithHookPrefix = /^use[A-Z]/.test(name);
    if (/Use$/.test(name) && !startsWithHookPrefix) {
        score -= 0.22;
    }
    const builtinTokenCount = tokens.filter((token) => isGlobalBuiltinSymbol(token)).length;
    if (builtinTokenCount > 0) {
        const builtinRatio = builtinTokenCount / tokens.length;
        if (builtinRatio >= 0.5)
            score -= 0.32;
        else if (builtinRatio >= 0.35)
            score -= 0.22;
        else
            score -= 0.1;
    }
    const alignmentScore = scoreModulePathAlignment(name, emittedPath);
    const moduleTokens = collectModuleContextTokens(emittedPath);
    if (moduleTokens.length > 0 && alignmentScore < 0.4) {
        score -= 0.22;
    }
    if (moduleTokens.length > 0 && alignmentScore < 0.2) {
        score -= 0.12;
    }
    const hasLowSignalGenericTokens = tokens.some((token) => token === "math" || token === "regexp" || token === "array" || token === "string" || token === "number" || token === "error");
    if (hasLowSignalGenericTokens && alignmentScore < 0.5) {
        score -= 0.14;
    }
    const hasUtilityPrototypeTokens = tokens.some((token) => token === "hasownproperty" || token === "prototype" || token === "getprototypeof" || token === "defineproperty");
    if (hasUtilityPrototypeTokens && moduleTokens.length > 0 && alignmentScore < 0.65) {
        score -= 0.28;
    }
    return clamp01(score);
}
function applyModuleAlignmentSignals(rows, emittedPath) {
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
        if (scoreDelta !== 0)
            return scoreDelta;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.nameQuality !== b.nameQuality)
            return b.nameQuality - a.nameQuality;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        return a.name.localeCompare(b.name);
    });
}
function isContextualRenameCandidate(input) {
    const { row, emittedPath, moduleTokens } = input;
    const normalized = row.name.toLowerCase();
    if (normalized.includes("getobjectready"))
        return true;
    if (/var[a-z0-9]{2,}/.test(normalized))
        return true;
    if (/(?:renderer|assets|services|main|tauri)\d+$/.test(normalized))
        return true;
    if (/(hasownproperty|getprototypeof|defineproperty|prototype)/.test(normalized))
        return true;
    if (row.kind === "variable" && /Use$/.test(row.name) && !/^use[A-Z]/.test(row.name))
        return true;
    const alignmentScore = scoreModulePathAlignment(row.name, emittedPath);
    if (moduleTokens.length > 0 && alignmentScore < 0.28)
        return true;
    if (scoreContextualExportNameQuality(row.name, emittedPath) <= 0.72)
        return true;
    return false;
}
function buildContextualSecondaryName(input) {
    const baseTokens = input.moduleTokens.length > 0 ? input.moduleTokens : splitIdentifierTokens(input.moduleBaseName).map((token) => token.toLowerCase());
    const normalizedBaseTokens = input.kind === "function"
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
        if (className !== "symbol_export")
            return className;
        return `DomainRuntime${input.index + 1}`;
    }
    const camelBase = buildIdentifierFromTokens(splitIdentifierTokens(stableBase), false);
    const exportName = sanitizeExportIdentifierName(`${camelBase}${suffix}`);
    if (exportName !== "symbol_export")
        return exportName;
    return `domainRuntime${input.index + 1}`;
}
function applyTargetedExportRenames(rows, emittedPath) {
    if (rows.length === 0)
        return rows;
    const moduleStemRaw = path.posix.basename(toPosixPath(emittedPath), path.posix.extname(toPosixPath(emittedPath)));
    const moduleBaseName = sanitizeExportIdentifierName(moduleStemRaw);
    const moduleTokens = collectModuleContextTokens(emittedPath);
    const moduleLooksLikeHook = /^use[A-Z]/.test(moduleBaseName);
    const usedNames = new Set(rows.map((row) => row.name));
    const nextRows = rows.map((row) => ({ ...row }));
    const callableIndexes = nextRows
        .map((row, index) => ({ row, index }))
        .filter((item) => item.row.kind === "function" || item.row.kind === "class")
        .sort((a, b) => {
        const scoreDelta = computeSelectionScore(b.row) - computeSelectionScore(a.row);
        if (scoreDelta !== 0)
            return scoreDelta;
        return a.index - b.index;
    });
    const canonicalNameValid = moduleBaseName !== "symbol_export" && moduleBaseName.length >= 3;
    const canonicalCandidates = callableIndexes.length > 0
        ? callableIndexes
        : moduleLooksLikeHook
            ? nextRows
                .map((row, index) => ({ row, index }))
                .filter((item) => item.row.kind === "function" || item.row.kind === "variable")
                .sort((a, b) => {
                const scoreDelta = computeSelectionScore(b.row) - computeSelectionScore(a.row);
                if (scoreDelta !== 0)
                    return scoreDelta;
                return a.index - b.index;
            })
            : [];
    if (canonicalNameValid && canonicalCandidates.length > 0) {
        const primary = canonicalCandidates[0];
        if (primary && primary.row.name !== moduleBaseName && !usedNames.has(moduleBaseName)) {
            usedNames.delete(primary.row.name);
            primary.row.name = moduleBaseName;
            primary.row.nameQuality = scoreExportNameQuality(moduleBaseName);
            usedNames.add(primary.row.name);
        }
    }
    let renameOrdinal = 0;
    for (const row of nextRows) {
        if (!isContextualRenameCandidate({
            row,
            emittedPath,
            moduleTokens,
        })) {
            continue;
        }
        const nextCandidateName = buildContextualSecondaryName({
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
        if (nextName === row.name || usedNames.has(nextName))
            continue;
        usedNames.delete(row.name);
        row.name = nextName;
        row.nameQuality = scoreExportNameQuality(nextName);
        usedNames.add(row.name);
    }
    return nextRows;
}
function normalizeExportNameRoot(input) {
    const sanitized = stripNoisyExportSuffix(input);
    return sanitized.replace(/V\d+$/i, "").replace(/\d+$/i, "").replace(/[_-]+$/, "").toLowerCase();
}
function getDeclarationLengthLimit(kind, moduleSizeHint) {
    if (kind === "variable") {
        if (moduleSizeHint >= 1800)
            return 3600;
        if (moduleSizeHint >= 900)
            return 5200;
        return 9000;
    }
    if (moduleSizeHint >= 1800)
        return 8000;
    if (moduleSizeHint >= 900)
        return 10000;
    return 15000;
}
function computeSelectionScore(row) {
    const priorityScore = getExportKindPriority(row.kind);
    const confidenceScore = row.confidence * 100;
    const qualityScore = row.nameQuality * 60;
    const lengthPenalty = row.declarationLength > 0 ? Math.min(45, row.declarationLength / 350) : 0;
    const generatedPenalty = row.generatedSignal * 70;
    return priorityScore + confidenceScore + qualityScore - lengthPenalty - generatedPenalty;
}
function selectWithCaps(input) {
    const selected = [];
    const selectedBySymbol = new Set();
    const rootCounts = new Map();
    let variableCount = 0;
    const pushRow = (row) => {
        if (selectedBySymbol.has(row.sourceSymbol))
            return false;
        if (selected.length >= input.limit)
            return false;
        if (row.kind === "variable" && variableCount >= input.maxVariables)
            return false;
        const root = normalizeExportNameRoot(row.name);
        const rootCount = rootCounts.get(root) ?? 0;
        if (rootCount >= input.perRootCap)
            return false;
        selected.push(row);
        selectedBySymbol.add(row.sourceSymbol);
        rootCounts.set(root, rootCount + 1);
        if (row.kind === "variable")
            variableCount += 1;
        return true;
    };
    for (const seedRow of input.seed ?? []) {
        pushRow(seedRow);
    }
    for (const row of input.rows) {
        if (selected.length >= input.limit)
            break;
        pushRow(row);
    }
    return selected;
}
function pickDeclarationStatForExport(rows, expectedKind, sourceLine) {
    if (rows.length === 0)
        return undefined;
    const lineHint = sourceLine > 0 ? sourceLine : rows[0]?.line ?? 0;
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const row of rows) {
        let kindPenalty = 0;
        if (row.kind !== expectedKind) {
            if (row.kind === "variable" && (expectedKind === "function" || expectedKind === "class"))
                kindPenalty = 1;
            else
                kindPenalty = 3;
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
function buildTargetSymbolEntriesIndex(report) {
    const index = new Map();
    for (const entry of report.entries) {
        if (entry.kind === "file")
            continue;
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(entry.sourceFile);
        if (sourceFile.trim().length === 0)
            continue;
        const targetPath = (0, deobfuscation_report_1.toProjectRelativeTargetPath)(entry.targetProjectPath);
        const exportName = sanitizeExportIdentifierName(entry.deobfuscated);
        if (exportName === "symbol_export")
            continue;
        if (!isSafeImportIdentifier(entry.obfuscated))
            continue;
        const kind = entry.kind;
        const row = {
            targetPath,
            sourceFile,
            exportName,
            sourceSymbol: entry.obfuscated,
            kind,
            sourceLine: parseSourceLineHint(entry.sourceFile),
            confidence: entry.confidence,
        };
        const bucket = index.get(targetPath) ?? [];
        bucket.push(row);
        index.set(targetPath, bucket);
    }
    return index;
}
function buildRankedExportRowsFromTargetEntries(input) {
    const byExportName = new Map();
    for (const entry of input.entries) {
        if (entry.sourceFile !== input.sourceFile)
            continue;
        const current = byExportName.get(entry.exportName);
        if (!current || entry.confidence > current.confidence) {
            byExportName.set(entry.exportName, entry);
        }
    }
    return Array.from(byExportName.values())
        .map((entry) => {
        const stat = pickDeclarationStatForExport(input.declarationStatsByName.get(entry.sourceSymbol) ?? [], entry.kind, entry.sourceLine);
        return {
            name: entry.exportName,
            sourceSymbol: entry.sourceSymbol,
            kind: entry.kind,
            sourceLine: entry.sourceLine,
            confidence: entry.confidence,
            declarationLength: stat?.statementLength ?? 0,
            hasDeclaration: !!stat,
            nameQuality: scoreExportNameQuality(entry.exportName),
            generatedSignal: stat?.generatedSignal ?? 0,
        };
    })
        .sort((a, b) => {
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.generatedSignal !== b.generatedSignal)
            return a.generatedSignal - b.generatedSignal;
        if (a.nameQuality !== b.nameQuality)
            return b.nameQuality - a.nameQuality;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        return a.name.localeCompare(b.name);
    });
}
function selectPrimaryExports(input) {
    const bySourceSymbol = new Map();
    for (const row of input.rows) {
        const current = bySourceSymbol.get(row.sourceSymbol);
        if (!current || computeSelectionScore(row) > computeSelectionScore(current)) {
            bySourceSymbol.set(row.sourceSymbol, row);
        }
    }
    const ranked = Array.from(bySourceSymbol.values()).sort((a, b) => {
        const priorityDelta = getExportKindPriority(b.kind) - getExportKindPriority(a.kind);
        if (priorityDelta !== 0)
            return priorityDelta;
        if (a.generatedSignal !== b.generatedSignal)
            return a.generatedSignal - b.generatedSignal;
        if (a.nameQuality !== b.nameQuality)
            return b.nameQuality - a.nameQuality;
        if (a.declarationLength !== b.declarationLength)
            return a.declarationLength - b.declarationLength;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        return a.name.localeCompare(b.name);
    });
    const moduleSizeHint = ranked.length;
    const ultraDense = moduleSizeHint >= 1800;
    const dense = moduleSizeHint >= 900;
    const hasAnyDeclaration = ranked.some((row) => row.hasDeclaration);
    const maxVariables = ultraDense ? 0 : dense ? 1 : 3;
    const perRootCap = ultraDense ? 1 : dense ? 1 : 2;
    const strictRows = [];
    const fallbackRows = [];
    for (const row of ranked) {
        const missingDeclaration = !row.hasDeclaration;
        const allowMissingDeclarationCallable = (row.kind === "class" || row.kind === "function") &&
            row.confidence >= 0.94 &&
            row.nameQuality >= 0.82 &&
            !dense &&
            !ultraDense &&
            !hasAnyDeclaration;
        if (missingDeclaration && !allowMissingDeclarationCallable) {
            fallbackRows.push(row);
            continue;
        }
        if (row.kind === "variable" &&
            row.generatedSignal >= (ultraDense ? 0.42 : dense ? 0.58 : 0.75) &&
            row.declarationLength >= 900) {
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
        if (accepted)
            strictRows.push(row);
        else
            fallbackRows.push(row);
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
        if (!generatedAllowed)
            return false;
        if (ultraDense || dense)
            return row.hasDeclaration;
        if (row.hasDeclaration)
            return true;
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
function determineAdaptiveStatementBudget(input) {
    const source = input.sourceFile.toLowerCase();
    let budget = 1200;
    if (input.candidateExports >= 2500)
        budget = 280;
    else if (input.candidateExports >= 1500)
        budget = 360;
    else if (input.candidateExports >= 900)
        budget = 460;
    else if (input.candidateExports >= 400)
        budget = 620;
    else if (input.candidateExports >= 180)
        budget = 760;
    if (source.includes("/index-") || source.includes("/chunk-")) {
        budget = Math.min(budget, 520);
    }
    if (source.includes(".vite/build/worker")) {
        budget = Math.min(budget, 700);
    }
    if (input.selectedExports <= 6) {
        budget = Math.min(budget, 420);
    }
    return Math.max(220, budget);
}
function determineMaxPrimaryStatementLength(input) {
    if (input.candidateExports >= 2500)
        return 2800;
    if (input.candidateExports >= 1200)
        return 3600;
    if (input.candidateExports >= 700)
        return 5200;
    if (input.statementBudget <= 420)
        return 4200;
    return 9000;
}
function determineMaxDependencyStatementLength(input) {
    if (input.candidateExports >= 2500)
        return 4200;
    if (input.candidateExports >= 1200)
        return 5200;
    if (input.candidateExports >= 700)
        return 6500;
    if (input.statementBudget <= 420)
        return 5000;
    return 14000;
}
function buildPlaceholderModuleBody(input) {
    const seen = new Set();
    const rows = input.exports
        .filter((row) => {
        if (seen.has(row.name))
            return false;
        seen.add(row.name);
        return true;
    })
        .sort((a, b) => {
        const kindDelta = getExportKindPriority(b.kind) - getExportKindPriority(a.kind);
        if (kindDelta !== 0)
            return kindDelta;
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        return a.name.localeCompare(b.name);
    })
        .slice(0, 12);
    const lines = [
        "// Placeholder API generated because AST lift could not resolve safe declarations.",
        `// Source: ${input.sourceFile}`,
        "",
    ];
    for (const row of rows) {
        const message = `Unresolved placeholder: ${row.name} (${input.sourceFile})`;
        if (row.kind === "class") {
            lines.push(`export class ${row.name} {`);
            lines.push("  constructor(..._args) {");
            lines.push(`    throw new Error(${JSON.stringify(message)});`);
            lines.push("  }");
            lines.push("}");
            lines.push("");
            continue;
        }
        if (row.kind === "function") {
            lines.push(`export function ${row.name}(..._args) {`);
            lines.push(`  throw new Error(${JSON.stringify(message)});`);
            lines.push("}");
            lines.push("");
            continue;
        }
        lines.push(`export const ${row.name} = undefined;`);
    }
    if (rows.length === 0) {
        lines.push("export {};");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}
function isSafeImportIdentifier(value) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}
function toRelativeImportSpecifier(fromModulePath, targetPath) {
    const fromDir = toPosixPath(path.posix.dirname(fromModulePath)).replace(/^\.?\//, "");
    const target = toPosixPath(targetPath).replace(/^\.?\//, "");
    const relative = path.posix.relative(fromDir, target);
    return relative.startsWith(".") ? relative : `./${relative}`;
}
function buildChunkBridgeModuleBody(input) {
    const rows = input.exports.filter((row) => isSafeImportIdentifier(row.sourceSymbol));
    if (rows.length === 0) {
        return buildPlaceholderModuleBody({
            exports: input.exports,
            sourceFile: input.sourceFile,
        });
    }
    const uniqueBySource = new Map();
    let importIndex = 0;
    for (const row of rows) {
        if (uniqueBySource.has(row.sourceSymbol))
            continue;
        uniqueBySource.set(row.sourceSymbol, `__bridge${importIndex}`);
        importIndex += 1;
    }
    const moduleSpecifier = toRelativeImportSpecifier(input.emittedPath, input.chunkArtifactPath);
    const importBindings = Array.from(uniqueBySource.entries()).map(([sourceSymbol, alias]) => `${sourceSymbol} as ${alias}`);
    const lines = [
        "// Chunk bridge fallback generated because AST lift could not resolve declarations safely.",
        `// Source: ${input.sourceFile}`,
        `import { ${importBindings.join(", ")} } from "${moduleSpecifier}";`,
        "",
        "// Public API",
    ];
    const seenExport = new Set();
    for (const row of rows) {
        if (seenExport.has(row.name))
            continue;
        seenExport.add(row.name);
        const alias = uniqueBySource.get(row.sourceSymbol);
        if (!alias)
            continue;
        if (row.name === alias) {
            lines.push(`export { ${row.name} };`);
            continue;
        }
        lines.push(`export const ${row.name} = ${alias};`);
    }
    lines.push("");
    return `${lines.join("\n").trimEnd()}\n`;
}
const CALLSITE_STOPWORDS = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "function",
    "return",
    "throw",
    "class",
    "import",
    "export",
    "typeof",
    "void",
    "delete",
    "in",
    "of",
    "new",
    "await",
    "super",
    "const",
    "let",
    "var",
]);
function extractRecoveryTokens(input) {
    return splitIdentifierTokens(input)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3 && !isNoisyIdentifierToken(token));
}
function computeTokenOverlapScore(left, right) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const rightSet = new Set(right);
    let score = 0;
    for (const token of left) {
        if (rightSet.has(token)) {
            score += 1;
            continue;
        }
        const partial = right.find((item) => item.startsWith(token) || token.startsWith(item));
        if (partial)
            score += 0.35;
    }
    return score;
}
function buildCallsiteFrequencyMap(sourceText) {
    const frequency = new Map();
    const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
    let match;
    while ((match = callPattern.exec(sourceText)) !== null) {
        const raw = match[1] ?? "";
        const token = raw.trim().toLowerCase();
        if (token.length < 3)
            continue;
        if (CALLSITE_STOPWORDS.has(token))
            continue;
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
    return frequency;
}
function recoverUnresolvedExportsWithSignals(input) {
    if (input.unresolvedExports.length === 0)
        return [];
    if (input.declarationStatsRows.length === 0)
        return [];
    const callsiteFrequency = buildCallsiteFrequencyMap(input.sourceChunk);
    const existingConfidence = new Map();
    for (const row of input.existingRows) {
        existingConfidence.set(`${row.name}|${row.kind}`, row.confidence);
    }
    const usedSourceSymbols = new Set();
    const recoveredRows = [];
    for (const unresolved of input.unresolvedExports) {
        const exportName = sanitizeExportIdentifierName(unresolved.exportName);
        if (exportName === "symbol_export")
            continue;
        const exportTokens = extractRecoveryTokens(`${exportName} ${unresolved.sourceSymbol}`);
        let best;
        for (const stat of input.declarationStatsRows) {
            if (usedSourceSymbols.has(stat.name))
                continue;
            if (stat.statementLength <= 0)
                continue;
            if (stat.statementLength > 5200)
                continue;
            if (stat.generatedSignal > 0.72)
                continue;
            const kindPenalty = stat.kind === unresolved.kind
                ? 0
                : stat.kind === "variable" && (unresolved.kind === "function" || unresolved.kind === "class")
                    ? 1
                    : 2;
            if (kindPenalty >= 2)
                continue;
            const declarationTokens = extractRecoveryTokens(stat.name);
            const tokenOverlap = computeTokenOverlapScore(exportTokens, declarationTokens);
            const callsiteCount = callsiteFrequency.get(stat.name.toLowerCase()) ?? 0;
            const callsiteBoost = Math.min(2.2, callsiteCount * 0.4);
            const lineDistanceNormalized = unresolved.sourceLine > 0 ? Math.min(1, Math.abs(stat.line - unresolved.sourceLine) / 1400) : 0.45;
            const lengthPenalty = Math.min(1.2, stat.statementLength / 9000);
            const score = tokenOverlap * 2.2 +
                callsiteBoost +
                (1 - stat.generatedSignal) * 1.3 +
                (1 - lineDistanceNormalized) * 0.7 -
                kindPenalty * 1.1 -
                lengthPenalty;
            if (!best || score > best.score) {
                best = { stat, score };
            }
        }
        if (!best || best.score < 1.15)
            continue;
        usedSourceSymbols.add(best.stat.name);
        recoveredRows.push({
            name: exportName,
            sourceSymbol: best.stat.name,
            kind: unresolved.kind,
            sourceLine: unresolved.sourceLine > 0 ? unresolved.sourceLine : best.stat.line,
            confidence: Math.max(0.67, existingConfidence.get(`${exportName}|${unresolved.kind}`) ?? input.moduleConfidence),
            declarationLength: best.stat.statementLength,
            hasDeclaration: true,
            nameQuality: scoreExportNameQuality(exportName),
            generatedSignal: best.stat.generatedSignal,
        });
    }
    return recoveredRows;
}
function collectOutputPreview(stdout, stderr, maxLines) {
    const joined = `${stdout}\n${stderr}`
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => (line.length > 420 ? `${line.slice(0, 420)}...` : line));
    return joined.slice(0, maxLines);
}
function countMatches(lines, pattern) {
    let count = 0;
    for (const line of lines) {
        if (pattern.test(line))
            count += 1;
    }
    return count;
}
function countMatchesInText(text, pattern) {
    const lines = text.split(/\r?\n/g);
    return countMatches(lines, pattern);
}
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
function runShellCommandSync(input) {
    if (process.platform === "win32") {
        return (0, node_child_process_1.spawnSync)("cmd.exe", ["/d", "/s", "/c", input.command], {
            cwd: input.cwd,
            encoding: "utf8",
            timeout: input.timeoutMs,
            windowsHide: true,
        });
    }
    return (0, node_child_process_1.spawnSync)("sh", ["-lc", input.command], {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        windowsHide: true,
    });
}
function runNodeScriptSync(input) {
    return (0, node_child_process_1.spawnSync)(process.execPath, [input.scriptPath, ...input.args], {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        windowsHide: true,
    });
}
function asText(value) {
    if (typeof value === "string")
        return value;
    if (!value)
        return "";
    return value.toString("utf8");
}
function runGeneratedProjectChecks(projectRoot) {
    const installStart = Date.now();
    const installResult = runShellCommandSync({
        command: "npm install --no-audit --no-fund",
        cwd: projectRoot,
        timeoutMs: 300000,
    });
    const installDurationMs = Date.now() - installStart;
    const installErrorLine = installResult.error instanceof Error ? `spawn-error: ${installResult.error.message}` : "";
    const installPreview = collectOutputPreview(`${asText(installResult.stdout)}\n${installErrorLine}`, asText(installResult.stderr), 30);
    const installSuccess = installResult.status === 0;
    const checks = {
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
    const tscResult = tscBin.length > 0
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
    const eslintResult = eslintBin.length > 0
        ? runNodeScriptSync({
            scriptPath: eslintBin,
            args: eslintArgs,
            cwd: projectRoot,
            timeoutMs: 240000,
        })
        : runShellCommandSync({
            command: "npm exec --yes --package eslint@9.20.0 -- eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json",
            cwd: projectRoot,
            timeoutMs: 240000,
        });
    const eslintStdout = asText(eslintResult.stdout);
    const eslintStderr = asText(eslintResult.stderr);
    const eslintPreview = collectOutputPreview(eslintStdout, eslintStderr, 40);
    let eslintErrors = 0;
    let eslintWarnings = 0;
    try {
        const parsed = JSON.parse(eslintStdout || "[]");
        for (const row of parsed) {
            eslintErrors += (row.errorCount ?? 0) + (row.fatalErrorCount ?? 0);
            eslintWarnings += row.warningCount ?? 0;
        }
    }
    catch {
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
function buildWebStormTestProject(input) {
    const projectRoot = path.join(input.outDir, "project");
    (0, exec_1.removePath)(projectRoot);
    (0, exec_1.ensureDir)(projectRoot);
    const srcRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "src"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "main"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "renderer"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "services"));
    const chunkArtifactsRoot = (0, exec_1.ensureDir)(path.join(srcRoot, "chunks"));
    (0, exec_1.ensureDir)(path.join(projectRoot, "src-tauri-adapter"));
    const mappingRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "mapping"));
    const metaRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "meta"));
    const toolsRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "tools"));
    const chunkArtifactBySourceFile = new Map();
    const chunkSourceBySourceFile = new Map();
    let chunkFiles = 0;
    const readSourceChunkForSourceFile = (sourceFileInput) => {
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(sourceFileInput);
        if (sourceFile.length === 0) {
            throw new Error("Missing source file for source chunk read.");
        }
        const cachedSource = chunkSourceBySourceFile.get(sourceFile);
        if (cachedSource)
            return cachedSource;
        const sourcePath = path.join(input.decompiledDir, sourceFile);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            throw new Error(`Mapped source chunk file does not exist: ${sourcePath}`);
        }
        const source = normalizeSourceForPrint(readUtf8(sourcePath));
        const normalizedSource = source.endsWith("\n") ? source : `${source}\n`;
        chunkSourceBySourceFile.set(sourceFile, normalizedSource);
        return normalizedSource;
    };
    const ensureChunkArtifactForSourceFile = (sourceFileInput) => {
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(sourceFileInput);
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
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
        fs.writeFileSync(destinationPath, sourceChunk, "utf8");
        const artifactPath = toPosixPath(path.posix.join("src", "chunks", chunkArtifactPath));
        chunkArtifactBySourceFile.set(sourceFile, artifactPath);
        chunkFiles += 1;
        return {
            chunkArtifactPath: artifactPath,
            sourceChunk,
        };
    };
    const sourceLiftContextCache = new Map();
    const getSourceLiftContext = (sourceFileInput) => {
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(sourceFileInput);
        if (sourceFile.length === 0) {
            throw new Error("Missing source file for lift context.");
        }
        const cached = sourceLiftContextCache.get(sourceFile);
        if (cached)
            return cached;
        const sourceChunk = readSourceChunkForSourceFile(sourceFile);
        const declarationStatsRows = (0, symbol_lifter_1.inspectLiftSourceDeclarations)({
            sourceFilePath: sourceFile,
            sourceText: sourceChunk,
        });
        const declarationStatsByName = new Map();
        for (const stat of declarationStatsRows) {
            const bucket = declarationStatsByName.get(stat.name) ?? [];
            bucket.push(stat);
            declarationStatsByName.set(stat.name, bucket);
        }
        const context = {
            sourceFile,
            sourceChunk,
            declarationStatsRows,
            declarationStatsByName,
        };
        sourceLiftContextCache.set(sourceFile, context);
        return context;
    };
    const byTargetPath = new Map();
    const targetSymbolEntriesByPath = buildTargetSymbolEntriesIndex(input.deobfuscationTable);
    const upsertTarget = (inputRow) => {
        const targetPath = (0, deobfuscation_report_1.toProjectRelativeTargetPath)(inputRow.targetPath);
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(inputRow.sourceFile);
        if (sourceFile.length === 0)
            return;
        const current = byTargetPath.get(targetPath);
        const chosenSourceFile = !current || inputRow.confidence > current.confidence ? sourceFile : current.sourceFile;
        const chosenConfidence = !current ? inputRow.confidence : Math.max(current.confidence, inputRow.confidence);
        const row = current ?? {
            targetPath,
            sourceFile: chosenSourceFile,
            confidence: chosenConfidence,
            symbols: new Set(),
            references: new Set(),
            rationale: new Set(),
            exportsByName: new Map(),
        };
        row.sourceFile = chosenSourceFile;
        row.confidence = chosenConfidence;
        if (inputRow.symbol.trim().length > 0)
            row.symbols.add(inputRow.symbol.trim());
        if (inputRow.reference.trim().length > 0)
            row.references.add(inputRow.reference.trim());
        for (const reason of inputRow.rationale) {
            const normalized = reason.trim();
            if (normalized.length === 0)
                continue;
            row.rationale.add(normalized);
        }
        if (inputRow.kind !== "file") {
            const preferredSymbol = inputRow.symbol.trim().length > 0 ? inputRow.symbol : inputRow.sourceSymbol;
            let exportName = sanitizeExportIdentifierName(preferredSymbol);
            if (exportName === "symbol_export" && inputRow.sourceSymbol.trim().length > 0) {
                exportName = sanitizeExportIdentifierName(inputRow.sourceSymbol);
            }
            if (exportName === "symbol_export") {
                byTargetPath.set(targetPath, row);
                return;
            }
            const currentExport = row.exportsByName.get(exportName);
            if (!currentExport || inputRow.confidence > currentExport.confidence) {
                row.exportsByName.set(exportName, {
                    sourceSymbol: inputRow.sourceSymbol,
                    kind: inputRow.kind,
                    sourceLine: inputRow.sourceLine,
                    confidence: inputRow.confidence,
                });
            }
        }
        byTargetPath.set(targetPath, row);
    };
    for (const plan of input.deobfuscationTable.filePlans) {
        upsertTarget({
            targetPath: plan.proposedModulePath,
            sourceFile: plan.sourceFile,
            confidence: plan.confidence,
            symbol: path.basename(plan.proposedModulePath).replace(/\.[^.]+$/, ""),
            reference: plan.referenceSource,
            rationale: plan.rationale,
            sourceSymbol: "",
            kind: "file",
            sourceLine: 0,
        });
    }
    for (const entry of input.deobfuscationTable.entries) {
        upsertTarget({
            targetPath: entry.targetProjectPath,
            sourceFile: entry.sourceFile,
            confidence: entry.confidence,
            symbol: entry.deobfuscated,
            reference: `${entry.reference.source}:${entry.reference.symbol}`,
            rationale: entry.rationale,
            sourceSymbol: entry.obfuscated,
            kind: entry.kind,
            sourceLine: parseSourceLineHint(entry.sourceFile),
        });
    }
    let reconstructedFiles = 0;
    const reconstructedMapRows = [];
    const lifterDiagnosticsRows = [];
    const sortedTargets = Array.from(byTargetPath.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath));
    const emittedModulePaths = [];
    for (const row of sortedTargets) {
        let activeSourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(row.sourceFile);
        const emittedPath = normalizeTargetModulePath(row.targetPath);
        const targetEntries = targetSymbolEntriesByPath.get(row.targetPath) ?? [];
        const targetEntriesBySourceFile = groupTargetEntriesBySourceFile(targetEntries);
        const sourceCandidateOrder = rankSourceFileCandidates(targetEntriesBySourceFile, activeSourceFile).slice(0, 10);
        const buildFallbackCandidateRows = (declarationStatsByName) => Array.from(row.exportsByName.entries())
            .map(([name, value]) => {
            const sanitizedName = sanitizeExportIdentifierName(name);
            if (sanitizedName === "symbol_export") {
                return undefined;
            }
            const stat = pickDeclarationStatForExport(declarationStatsByName.get(value.sourceSymbol) ?? [], value.kind, value.sourceLine);
            return {
                name: sanitizedName,
                ...value,
                declarationLength: stat?.statementLength ?? 0,
                hasDeclaration: !!stat,
                nameQuality: scoreExportNameQuality(sanitizedName),
                generatedSignal: stat?.generatedSignal ?? 0,
            };
        })
            .filter((item) => !!item)
            .sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            if (a.generatedSignal !== b.generatedSignal)
                return a.generatedSignal - b.generatedSignal;
            if (a.nameQuality !== b.nameQuality)
                return b.nameQuality - a.nameQuality;
            if (a.declarationLength !== b.declarationLength)
                return a.declarationLength - b.declarationLength;
            if (a.kind !== b.kind)
                return a.kind.localeCompare(b.kind);
            return a.name.localeCompare(b.name);
        });
        const buildCandidateRowsForSource = (sourceFile) => {
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
            if (sourceFile !== activeSourceFile) {
                return indexedCandidateRows;
            }
            const fallbackRows = buildFallbackCandidateRows(sourceContext.declarationStatsByName);
            const ownedFallbackRows = filterOwnedExportRows(fallbackRows);
            if (ownedFallbackRows.length > 0) {
                return ownedFallbackRows;
            }
            return indexedCandidateRows.length > 0 ? indexedCandidateRows : fallbackRows;
        };
        const evaluateSourceCandidate = (sourceFile, rows) => {
            const sourceContext = getSourceLiftContext(sourceFile);
            const alignedRows = applyModuleAlignmentSignals(rows, emittedPath);
            const callableCount = alignedRows.filter((item) => item.kind === "class" || item.kind === "function").length;
            const alignmentAggregate = alignedRows.reduce((sum, item) => sum + scoreModulePathAlignment(item.name, emittedPath), 0) /
                Math.max(1, alignedRows.length);
            const generatedAggregate = alignedRows.reduce((sum, item) => sum + item.generatedSignal, 0) / Math.max(1, alignedRows.length);
            const oversizedDeclarationRatio = alignedRows.filter((item) => item.declarationLength > 9000).length / Math.max(1, alignedRows.length);
            let parserRegistryRows = 0;
            for (const item of alignedRows) {
                const stat = pickDeclarationStatForExport(sourceContext.declarationStatsByName.get(item.sourceSymbol) ?? [], item.kind, item.sourceLine);
                if (!stat)
                    continue;
                if (isParserRegistryDeclaration(stat, sourceContext.sourceChunk)) {
                    parserRegistryRows += 1;
                }
            }
            const parserPenalty = parserRegistryRows > 0 ? (parserRegistryRows / rows.length) * 28 : 0;
            const generatedPenalty = generatedAggregate * 46 + oversizedDeclarationRatio * 28;
            const score = alignedRows.length * 12 +
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
        const activeEvaluation = activeOwnedRows.length > 0
            ? evaluateSourceCandidate(activeSourceFile, activeOwnedRows)
            : { score: Number.NEGATIVE_INFINITY, parserRegistryRows: 0 };
        let bestAlternative;
        for (const candidateSourceFile of sourceCandidateOrder) {
            if (candidateSourceFile === activeSourceFile)
                continue;
            const candidateRows = buildCandidateRowsForSource(candidateSourceFile);
            const ownedCandidateRows = filterOwnedExportRows(candidateRows);
            if (ownedCandidateRows.length === 0)
                continue;
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
            const shouldSwitch = activeOwnedRows.length === 0 ||
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
        let chunkArtifactPath = ensuredArtifact.chunkArtifactPath;
        let sourceChunk = ensuredArtifact.sourceChunk;
        let declarationStatsRows = activeSourceContext.declarationStatsRows;
        let declarationStatsByName = activeSourceContext.declarationStatsByName;
        if (candidateExportRows.length === 0) {
            const fallbackRows = buildFallbackCandidateRows(declarationStatsByName);
            const ownedFallbackRows = filterOwnedExportRows(fallbackRows);
            candidateExportRows = ownedFallbackRows.length > 0 ? ownedFallbackRows : fallbackRows;
        }
        const alignedCandidateRows = applyModuleAlignmentSignals(candidateExportRows, emittedPath);
        const selectedExports = selectPrimaryExports({
            rows: alignedCandidateRows,
            moduleConfidence: row.confidence,
        });
        const initialExportRows = applyTargetedExportRenames(selectedExports.selected, emittedPath);
        const statementBudget = determineAdaptiveStatementBudget({
            sourceFile: activeSourceFile,
            candidateExports: alignedCandidateRows.length,
            selectedExports: initialExportRows.length,
        });
        const maxPrimaryStatementLength = determineMaxPrimaryStatementLength({
            candidateExports: alignedCandidateRows.length,
            statementBudget,
        });
        const maxDependencyStatementLength = determineMaxDependencyStatementLength({
            candidateExports: alignedCandidateRows.length,
            statementBudget,
        });
        let exportRows = initialExportRows;
        let droppedExportsByBudget = 0;
        const allowClosestFallback = alignedCandidateRows.length <= 180 &&
            !/\/(?:index-|chunk-)/i.test(activeSourceFile.toLowerCase()) &&
            !activeSourceFile.toLowerCase().includes(".vite/build/worker");
        const liftWithBudget = (rows, primaryStatementLengthLimit, allowParserRegistryUnpack = false) => (0, symbol_lifter_1.liftModuleSource)({
            sourceFilePath: activeSourceFile,
            sourceText: sourceChunk,
            exports: rows.map((item) => ({
                exportName: item.name,
                sourceSymbol: item.sourceSymbol,
                kind: item.kind,
                sourceLine: item.sourceLine,
            })),
            maxDependencyStatements: statementBudget,
            maxDependencyStatementLength,
            maxPrimaryStatementLength: primaryStatementLengthLimit,
            allowClosestFallback,
            allowParserRegistryUnpack,
        });
        let lifted = liftWithBudget(exportRows, maxPrimaryStatementLength);
        if (lifted.liftedExports.length === 0 && exportRows.length > 0) {
            lifted = liftWithBudget(exportRows, 0);
        }
        while (lifted.dependencyTrimmed && exportRows.length > 8) {
            const nextLength = exportRows.length > 12 ? exportRows.length - 4 : exportRows.length - 2;
            if (nextLength < 8 || nextLength >= exportRows.length)
                break;
            exportRows = exportRows.slice(0, nextLength);
            droppedExportsByBudget = initialExportRows.length - exportRows.length;
            lifted = liftWithBudget(exportRows, maxPrimaryStatementLength);
            if (lifted.liftedExports.length === 0 && exportRows.length > 0) {
                lifted = liftWithBudget(exportRows, 0);
            }
        }
        let parserRegistryUnpackUsed = false;
        const parserRegistryEligible = lifted.liftedExports.length === 0 &&
            exportRows.length > 0 &&
            exportRows.some((item) => {
                const stat = pickDeclarationStatForExport(declarationStatsByName.get(item.sourceSymbol) ?? [], item.kind, item.sourceLine);
                return !!stat && isParserRegistryDeclaration(stat, sourceChunk);
            });
        if (parserRegistryEligible) {
            const unpackedLift = liftWithBudget(exportRows, 0, true);
            if (unpackedLift.liftedExports.length > lifted.liftedExports.length) {
                parserRegistryUnpackUsed = true;
                lifted = unpackedLift;
                row.rationale.add("parser-registry-unpack: enabled");
            }
        }
        let targetedRecoveredExports = 0;
        const unresolvedBeforeRecovery = lifted.unresolvedExports.filter((item) => item.kind === "class" || item.kind === "function");
        if (unresolvedBeforeRecovery.length > 0) {
            const recoveredRows = recoverUnresolvedExportsWithSignals({
                unresolvedExports: unresolvedBeforeRecovery,
                declarationStatsRows,
                sourceChunk,
                moduleConfidence: row.confidence,
                existingRows: exportRows,
            });
            if (recoveredRows.length > 0) {
                const liftedKeys = new Set(lifted.liftedExports.map((item) => `${item.exportName}|${item.kind}`));
                const mergedRows = new Map();
                for (const item of exportRows) {
                    if (!liftedKeys.has(`${item.name}|${item.kind}`))
                        continue;
                    mergedRows.set(`${item.name}|${item.kind}`, item);
                }
                for (const item of recoveredRows) {
                    mergedRows.set(`${item.name}|${item.kind}`, item);
                }
                const recoveryExportRows = Array.from(mergedRows.values());
                let recoveredLift = liftWithBudget(recoveryExportRows, maxPrimaryStatementLength);
                if (recoveredLift.liftedExports.length === 0 && recoveryExportRows.length > 0) {
                    recoveredLift = liftWithBudget(recoveryExportRows, 0);
                }
                if (recoveredLift.liftedExports.length > lifted.liftedExports.length) {
                    exportRows = recoveryExportRows;
                    droppedExportsByBudget = Math.max(0, initialExportRows.length - exportRows.length);
                    lifted = recoveredLift;
                    targetedRecoveredExports = recoveredRows.length;
                    row.rationale.add(`targeted-recovery: ownership-callsites recovered=${targetedRecoveredExports}`);
                }
            }
        }
        const unresolvedRequired = lifted.unresolvedExports.filter((item) => item.kind === "class" || item.kind === "function");
        for (const unresolved of unresolvedRequired) {
            row.rationale.add(`lifter-unresolved: ${unresolved.kind}:${unresolved.sourceSymbol}->${unresolved.exportName}@${unresolved.sourceLine}`);
        }
        const shouldUseTsNoCheck = true;
        const isUnresolvedModule = lifted.liftedExports.length === 0 && exportRows.length > 0;
        const useChunkBridgeMode = isUnresolvedModule && exportRows.every((item) => isSafeImportIdentifier(item.sourceSymbol));
        const usePlaceholderMode = isUnresolvedModule && !useChunkBridgeMode;
        const moduleBody = useChunkBridgeMode
            ? buildChunkBridgeModuleBody({
                exports: exportRows,
                sourceFile: activeSourceFile,
                emittedPath,
                chunkArtifactPath,
            })
            : usePlaceholderMode
                ? buildPlaceholderModuleBody({
                    exports: exportRows,
                    sourceFile: activeSourceFile,
                })
                : lifted.moduleBody;
        if (useChunkBridgeMode) {
            row.rationale.add("targeted-recovery: chunk-bridge-fallback-enabled");
        }
        const headerLines = [
            "/**",
            " * Generated by reverse/deobfuscation pipeline.",
            " * Lift mode: ast-symbol-lifter.",
            ` * Source chunk: ${activeSourceFile}`,
            ` * Chunk artifact: ${chunkArtifactPath}`,
            ` * Confidence: ${row.confidence}`,
            ` * Exports: selected=${exportRows.length}, lifted=${lifted.liftedExports.length}, unresolved=${lifted.unresolvedExports.length}, dropped=${selectedExports.dropped.length + droppedExportsByBudget}`,
            ` * Parser/registry unpack: ${parserRegistryUnpackUsed ? "enabled" : "disabled"}`,
            ` * Chunk bridge mode: ${useChunkBridgeMode ? "enabled" : "disabled"}`,
            ` * Placeholder mode: ${usePlaceholderMode ? "enabled" : "disabled"}`,
            " */",
            "",
            ...(shouldUseTsNoCheck ? ["// @ts-nocheck", ""] : []),
        ];
        const moduleSource = `${headerLines.join("\n")}${moduleBody}`;
        const destinationPath = path.join(projectRoot, emittedPath);
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
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
            exports: usePlaceholderMode || useChunkBridgeMode
                ? exportRows
                : exportRows.filter((item) => lifted.liftedExports.some((liftedExport) => liftedExport.exportName === item.name &&
                    liftedExport.kind === item.kind)),
            references: Array.from(row.references).sort((a, b) => a.localeCompare(b)),
            rationale: Array.from(row.rationale).sort((a, b) => a.localeCompare(b)),
        });
        lifterDiagnosticsRows.push({
            emittedPath,
            sourceFile: activeSourceFile,
            sourceChunkArtifactPath: chunkArtifactPath,
            candidateExports: alignedCandidateRows.length,
            selectedExports: exportRows.length,
            droppedExports: selectedExports.dropped.length,
            droppedExportsByBudget,
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
            placeholderMode: usePlaceholderMode,
            chunkBridgeMode: useChunkBridgeMode,
            targetedRecoveredExports,
            recoveryModeUsed: targetedRecoveredExports > 0,
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
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n.idea/\n.DS_Store\n", "utf8");
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
