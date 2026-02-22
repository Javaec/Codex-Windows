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
exports.persistNameMemory = persistNameMemory;
exports.applyNameMemory = applyNameMemory;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const NAME_MEMORY_SCHEMA_VERSION = 1;
const NAME_MEMORY_RELATIVE_PATH = "work/reverse-name-memory.json";
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function getMemoryPath(repoRoot) {
    return path.resolve(repoRoot, NAME_MEMORY_RELATIVE_PATH);
}
function createDefaultStore() {
    return {
        schemaVersion: NAME_MEMORY_SCHEMA_VERSION,
        updatedAtUtc: new Date().toISOString(),
        byApp: {},
    };
}
function readStore(filePath) {
    if (!fs.existsSync(filePath))
        return createDefaultStore();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== NAME_MEMORY_SCHEMA_VERSION || typeof parsed.byApp !== "object" || !parsed.byApp) {
        return createDefaultStore();
    }
    return {
        schemaVersion: NAME_MEMORY_SCHEMA_VERSION,
        updatedAtUtc: typeof parsed.updatedAtUtc === "string" ? parsed.updatedAtUtc : new Date().toISOString(),
        byApp: parsed.byApp,
    };
}
function writeStore(filePath, store) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
function normalizeSourceFile(value) {
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0)
        return value;
    return value.slice(0, separatorIndex);
}
function extractSourceLine(value) {
    const separatorIndex = value.lastIndexOf(":");
    if (separatorIndex <= 0)
        return 0;
    const parsed = Number(value.slice(separatorIndex + 1));
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 0;
    return Math.floor(parsed);
}
function makeSymbolKey(entry) {
    return `${entry.kind}|${normalizeSourceFile(entry.sourceFile)}|${entry.obfuscated}`;
}
function toPascalCase(value) {
    const parts = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/g)
        .filter((part) => part.length > 0)
        .map((part) => part.toLowerCase());
    if (parts.length === 0)
        return "";
    return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}
function toCamelCase(value) {
    const pascal = toPascalCase(value);
    if (pascal.length === 0)
        return "";
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
function splitTokens(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/g)
        .filter((token) => token.length > 0)
        .map((token) => token.toLowerCase());
}
function isNoisyNameToken(token) {
    if (token.length <= 1)
        return true;
    if (/^\d+$/.test(token))
        return true;
    if (/^v\d+$/i.test(token))
        return true;
    if (/^ref\d*$/i.test(token))
        return true;
    if (/^line\d+$/i.test(token))
        return true;
    if (/^bs\d+$/i.test(token))
        return true;
    if (/^(src|chunk|chunks|asset|assets|auto\d*|renderer\d*|main\d*|services\d*|tauri\d*|domain|symbol|module)$/i.test(token))
        return true;
    return false;
}
function inferLayerFromReference(file) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    if (normalized.startsWith("src/main/"))
        return "main";
    if (normalized.startsWith("src/renderer/") || normalized.startsWith("src/features/") || normalized.startsWith("src/components/")) {
        return "renderer";
    }
    if (normalized.startsWith("src/services/") || normalized.startsWith("src/lib/") || normalized.startsWith("src/state/"))
        return "services";
    if (normalized.startsWith("src-tauri/src/"))
        return "tauri";
    return "domain";
}
function sanitizeSymbolName(input) {
    const referenceTokens = splitTokens(input.referenceFile.replace(/\.[^.]+$/, ""));
    const rawTokens = [...splitTokens(input.name), ...referenceTokens];
    const filtered = rawTokens.filter((token) => !isNoisyNameToken(token));
    const unique = [];
    for (const token of filtered) {
        if (unique.includes(token))
            continue;
        unique.push(token);
        if (unique.length >= 4)
            break;
    }
    const layer = inferLayerFromReference(input.referenceFile);
    const layerToken = layer === "domain" ? "domain" : layer;
    if (unique.length === 0)
        unique.push(layerToken);
    if (unique.length <= 2 && !unique.includes(layerToken))
        unique.push(layerToken);
    const joined = unique.join(" ");
    if (input.kind === "class") {
        const next = toPascalCase(joined);
        return next.length > 0 ? next : "DomainSymbol";
    }
    const next = toCamelCase(joined);
    return next.length > 0 ? next : "domainValue";
}
function isIdentifierLikeName(name) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
function shouldSanitizeName(entry) {
    if (entry.kind === "file")
        return false;
    const name = entry.deobfuscated.trim();
    if (name.length < 3)
        return true;
    if (name.length > 90)
        return true;
    if (!isIdentifierLikeName(name))
        return true;
    if (/(Ref\d+$|N\d+$|Line\d+$)/i.test(name))
        return true;
    if (/(V\d+){2,}$/i.test(name))
        return true;
    if (/^([a-z]{1,2}\d*|[A-Z]{1,2}\d*)$/i.test(name))
        return true;
    if (/^(domain|main|renderer|services|tauri|handler|module|symbol|value)([A-Z0-9].*)?$/i.test(name))
        return true;
    return false;
}
function buildStableCollisionSuffix(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    const normalized = (hash >>> 0).toString(36).toUpperCase();
    return `Id${normalized.slice(0, 5)}`;
}
function buildDedupeName(input) {
    if (input.entry.kind === "file")
        return input.entry.deobfuscated;
    const sourceLine = extractSourceLine(input.entry.sourceFile);
    const sourceFile = normalizeSourceFile(input.entry.sourceFile).replace(/\.[^.]+$/, "");
    const referenceFile = input.entry.reference.file.replace(/\.[^.]+$/, "");
    const targetFile = input.entry.targetProjectPath.replace(/\.[^.]+$/, "");
    const obfuscatedTokens = splitTokens(input.entry.obfuscated).filter((token) => !isNoisyNameToken(token));
    const toIdentifier = input.entry.kind === "class" ? toPascalCase : toCamelCase;
    const fallback = input.entry.kind === "class" ? "DomainSymbol" : "domainValue";
    const toName = (tokens) => {
        const joined = tokens.join(" ");
        return toIdentifier(joined) || toIdentifier(input.entry.deobfuscated) || fallback;
    };
    const seedTokens = [
        ...splitTokens(input.entry.deobfuscated),
        ...splitTokens(sourceFile),
        ...splitTokens(referenceFile),
        ...splitTokens(targetFile),
    ];
    const uniqueTokens = [];
    for (const token of seedTokens) {
        if (isNoisyNameToken(token))
            continue;
        if (uniqueTokens.includes(token))
            continue;
        uniqueTokens.push(token);
        if (uniqueTokens.length >= 8)
            break;
    }
    const layerToken = inferLayerFromReference(input.entry.reference.file);
    if (layerToken !== "domain" && !uniqueTokens.includes(layerToken)) {
        uniqueTokens.push(layerToken);
    }
    if (uniqueTokens.length === 0)
        uniqueTokens.push("domain");
    const baseName = toName(uniqueTokens);
    if (!input.usedNames.has(baseName))
        return baseName;
    if (obfuscatedTokens.length > 0) {
        const withObfuscated = toName([...uniqueTokens, obfuscatedTokens[0]]);
        if (!input.usedNames.has(withObfuscated))
            return withObfuscated;
    }
    if (sourceLine > 0) {
        const withLine = toName([...uniqueTokens, `line${sourceLine}`]);
        if (!input.usedNames.has(withLine))
            return withLine;
    }
    if (obfuscatedTokens.length > 0 && sourceLine > 0) {
        const withBoth = toName([...uniqueTokens, obfuscatedTokens[0], `line${sourceLine}`]);
        if (!input.usedNames.has(withBoth))
            return withBoth;
    }
    const collisionKey = `${input.entry.kind}|${input.entry.sourceFile}|${input.entry.obfuscated}|${input.entry.reference.file}`;
    const withHash = `${baseName}${buildStableCollisionSuffix(collisionKey)}`;
    if (!input.usedNames.has(withHash))
        return withHash;
    let nextName = baseName;
    let suffix = 2;
    while (input.usedNames.has(nextName) && suffix < 5000) {
        nextName = `${baseName}N${suffix}`;
        suffix += 1;
    }
    return nextName;
}
function dedupeNames(report) {
    const symbolEntries = report.entries.filter((entry) => entry.kind !== "file");
    const grouped = new Map();
    const usedNamesByScope = new Map();
    for (const entry of symbolEntries) {
        const scopeKey = `${entry.kind}|${entry.targetProjectPath}`;
        const namesInScope = usedNamesByScope.get(scopeKey) ?? new Set();
        namesInScope.add(entry.deobfuscated);
        usedNamesByScope.set(scopeKey, namesInScope);
        const groupedKey = `${scopeKey}|${entry.deobfuscated}`;
        const rows = grouped.get(groupedKey) ?? [];
        rows.push(entry);
        grouped.set(groupedKey, rows);
    }
    let renamed = 0;
    for (const rows of grouped.values()) {
        if (rows.length <= 1)
            continue;
        const first = rows[0];
        if (!first)
            continue;
        const scopeKey = `${first.kind}|${first.targetProjectPath}`;
        const usedNames = usedNamesByScope.get(scopeKey) ?? new Set();
        rows.sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            return b.reference.score - a.reference.score;
        });
        for (let index = 1; index < rows.length; index += 1) {
            const entry = rows[index];
            if (!entry)
                continue;
            if (entry.kind === "file")
                continue;
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
function cloneReport(report) {
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
function toMemoryEntry(entry, key) {
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
function isCandidateBetter(candidate, current) {
    if (candidate.confidence > current.confidence + 0.015)
        return true;
    if (candidate.referenceScore > current.referenceScore + 0.25)
        return true;
    if (candidate.referenceScore > current.referenceScore && candidate.confidence >= current.confidence - 0.02)
        return true;
    return false;
}
function selectBestCurrentEntries(report) {
    const selected = new Map();
    for (const entry of report.entries) {
        if (entry.kind === "file")
            continue;
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
function persistNameMemory(input) {
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
        if (current.deobfuscated !== candidate.deobfuscated)
            renamed += 1;
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
function applyNameMemory(input) {
    const memoryPath = getMemoryPath(input.repoRoot);
    const store = readStore(memoryPath);
    const appMemory = store.byApp[input.appKey] ?? {};
    const nextReport = cloneReport(input.deobfuscationTable);
    let applied = 0;
    let renamed = 0;
    for (const entry of nextReport.entries) {
        if (entry.kind === "file")
            continue;
        const key = makeSymbolKey(entry);
        const remembered = appMemory[key];
        if (!remembered)
            continue;
        const memoryWinsByConfidence = remembered.confidence >= entry.confidence + 0.02;
        const memoryWinsByReference = remembered.referenceScore >= entry.reference.score + 0.35 &&
            remembered.confidence >= entry.confidence - 0.03;
        if (!memoryWinsByConfidence && !memoryWinsByReference)
            continue;
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
        if (previousName !== entry.deobfuscated)
            renamed += 1;
    }
    for (const entry of nextReport.entries) {
        if (entry.kind === "file")
            continue;
        if (!shouldSanitizeName(entry))
            continue;
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
