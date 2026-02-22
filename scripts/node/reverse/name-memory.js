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
    if (/^bs\d+$/i.test(token))
        return true;
    if (/^(chunk|chunks|asset|assets|auto\d*|renderer\d*|main\d*|services\d*|tauri\d*|domain|symbol|module)$/i.test(token))
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
    if (!unique.includes(layerToken))
        unique.push(layerToken);
    const joined = unique.join(" ");
    if (input.kind === "class") {
        const next = toPascalCase(joined);
        return next.length > 0 ? next : "DomainSymbol";
    }
    const next = toCamelCase(joined);
    return next.length > 0 ? next : "domainValue";
}
function dedupeNames(report) {
    const symbolEntries = report.entries.filter((entry) => entry.kind !== "file");
    const grouped = new Map();
    for (const entry of symbolEntries) {
        const rows = grouped.get(entry.deobfuscated) ?? [];
        rows.push(entry);
        grouped.set(entry.deobfuscated, rows);
    }
    let renamed = 0;
    for (const rows of grouped.values()) {
        if (rows.length <= 1)
            continue;
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
            const base = sanitizeSymbolName({
                name: entry.deobfuscated,
                kind: entry.kind,
                referenceFile: entry.reference.file,
            });
            const suffix = entry.kind === "class" ? `Ref${index + 1}` : `Ref${index + 1}`;
            const nextName = `${base}${suffix}`;
            if (entry.deobfuscated === nextName)
                continue;
            entry.deobfuscated = nextName;
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
