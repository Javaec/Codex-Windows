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
exports.DEFAULT_CODEXMONITOR_SYMBOL_MAP_PATH = exports.DEFAULT_1CODE_SYMBOL_MAP_PATH = exports.DEFAULT_REFERENCE_MAP_PATH = void 0;
exports.loadReferenceModel = loadReferenceModel;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REFERENCE_ANALYSIS_ROOT = path.join(REPO_ROOT, "reference", "analysis");
exports.DEFAULT_REFERENCE_MAP_PATH = path.join(REFERENCE_ANALYSIS_ROOT, "1code-codexmonitor-architecture-map.md");
exports.DEFAULT_1CODE_SYMBOL_MAP_PATH = path.join(REFERENCE_ANALYSIS_ROOT, "1code-symbol-map.json");
exports.DEFAULT_CODEXMONITOR_SYMBOL_MAP_PATH = path.join(REFERENCE_ANALYSIS_ROOT, "CodexMonitor-symbol-map.json");
function normalizeReferenceInputPath(candidate) {
    return path.resolve(candidate);
}
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function readUtf8(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
function dedupeKeywords(values, max) {
    const out = new Set();
    for (const value of values) {
        const normalized = value.trim();
        if (normalized.length < 3 || normalized.length > 80)
            continue;
        if (/^\d+$/.test(normalized))
            continue;
        if (/^[a-z]:[\\/]/i.test(normalized))
            continue;
        if (normalized.includes("\\") || normalized.includes("/reference/"))
            continue;
        if (normalized.split("/").length > 3)
            continue;
        if (/\.(?:ts|tsx|js|mjs|cjs|md|json|css|html|rs)$/i.test(normalized))
            continue;
        if (/^-+$/.test(normalized))
            continue;
        out.add(normalized);
        if (out.size >= max)
            break;
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
}
function splitReferenceToken(token) {
    const normalized = token.trim();
    if (normalized.length === 0)
        return [];
    const parts = normalized.split(/[^A-Za-z0-9_./:-]+/g).filter((part) => part.length >= 3);
    const nested = [];
    for (const part of parts) {
        nested.push(part);
        nested.push(...part.split(/[./:_-]+/g).filter((item) => item.length >= 3));
        const camel = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/g);
        for (const item of camel) {
            if (item.length >= 3)
                nested.push(item);
        }
    }
    return nested;
}
function extractReferenceTokens(markdown) {
    const tokens = [];
    const backtickRegex = /`([^`\n\r]{2,160})`/g;
    let backtickMatch = backtickRegex.exec(markdown);
    while (backtickMatch) {
        tokens.push(backtickMatch[1]);
        backtickMatch = backtickRegex.exec(markdown);
    }
    const wordRegex = /\b[A-Za-z][A-Za-z0-9_./:-]{2,80}\b/g;
    let wordMatch = wordRegex.exec(markdown);
    while (wordMatch) {
        tokens.push(wordMatch[0]);
        wordMatch = wordRegex.exec(markdown);
    }
    return tokens;
}
function categorizeReferenceKeywords(tokens) {
    const routes = new Set([
        "chat",
        "thread",
        "workspace",
        "settings",
        "automation",
        "inbox",
        "terminal",
        "diff",
        "login",
    ]);
    const methods = new Set();
    const stateKeys = new Set();
    const readiness = new Set(["ready", "loading", "error", "connected", "disconnected", "syncing"]);
    const events = new Set();
    const ipc = new Set();
    const ui = new Set(["layout", "sidebar", "panel", "header", "footer", "modal", "dialog"]);
    for (const rawToken of tokens) {
        for (const token of splitReferenceToken(rawToken)) {
            const normalized = token.trim();
            if (normalized.length < 3 || normalized.length > 80)
                continue;
            const lower = normalized.toLowerCase();
            if (/(route|path|navigate|screen|view|chat|thread|workspace|settings|inbox|automation|terminal|diff|login)/.test(lower)) {
                routes.add(normalized);
            }
            if (/(\.|::).+/.test(normalized) || /(create|list|get|set|start|stop|open|close|send|load|save|handle|dispatch|rollback|fork)/.test(lower)) {
                methods.add(normalized);
            }
            if (/(state|store|cache|config|setting|session|atom|key|status)/.test(lower)) {
                stateKeys.add(normalized);
            }
            if (/(ready|loading|error|failed|connected|disconnected|pending|submitted|streaming|idle|online|offline|healthy)/.test(lower)) {
                readiness.add(normalized);
            }
            if (/(event|broadcast|listener|stream|delta|changed|update|updated|created|deleted|queued|queue)/.test(lower)) {
                events.add(normalized);
            }
            if (/(ipc|invoke|send|on|handle|desktopapi|channel|window:|auth:|chat:|git:|app:|stream:|update:)/.test(lower)) {
                ipc.add(normalized);
            }
            if (/(layout|component|panel|sidebar|header|footer|modal|dialog|button|form|content|viewer|chatview|appcontent)/.test(lower)) {
                ui.add(normalized);
            }
        }
    }
    return {
        routes: dedupeKeywords(routes, 180),
        methods: dedupeKeywords(methods, 165),
        stateKeys: dedupeKeywords(stateKeys, 141),
        readiness: dedupeKeywords(readiness, 80),
        events: dedupeKeywords(events, 160),
        ipc: dedupeKeywords(ipc, 160),
        ui: dedupeKeywords(ui, 120),
    };
}
function buildReferenceDomainKeywords(base) {
    return {
        navigation: dedupeKeywords([...base.routes, ...base.ui, "tab", "panel", "sidebar"], 140),
        chat_sessions: dedupeKeywords([...base.routes, ...base.methods, ...base.events, "chat", "thread", "conversation", "session"], 140),
        settings_skills: dedupeKeywords([...base.routes, ...base.stateKeys, "settings", "skill", "skills", "model", "auth", "config"], 140),
        async_readiness: dedupeKeywords([...base.readiness, ...base.events, ...base.ipc, "stream", "delta"], 140),
    };
}
function buildEmptyReferenceKeywordGroups() {
    const base = {
        routes: [],
        methods: [],
        stateKeys: [],
        readiness: [],
        events: [],
        ipc: [],
        ui: [],
    };
    return {
        ...base,
        domains: buildReferenceDomainKeywords(base),
    };
}
function inferLayerFromReferenceFile(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (normalized.startsWith("src/main/"))
        return "main";
    if (normalized.startsWith("src/renderer/"))
        return "renderer";
    if (normalized.startsWith("src/services/"))
        return "services";
    if (normalized.startsWith("src-tauri/src/"))
        return "tauri";
    if (normalized.startsWith("src/features/"))
        return "renderer";
    if (normalized.startsWith("src/components/"))
        return "renderer";
    if (normalized.startsWith("src/hooks/"))
        return "renderer";
    if (normalized.startsWith("src/lib/"))
        return "services";
    if (normalized.startsWith("src/state/"))
        return "services";
    return "unknown";
}
function normalizeArchitectureReferencePath(raw) {
    const normalized = toPosixPath(raw.trim()).replace(/^["'`]+|["'`]+$/g, "");
    if (!normalized)
        return "";
    const clean = normalized.replace(/[)>:;,]+$/g, "");
    const oneCodeAnchor = "/reference/1code/";
    const codexMonitorAnchor = "/reference/codexmonitor/";
    const lower = clean.toLowerCase();
    if (lower.includes(oneCodeAnchor)) {
        return clean.slice(lower.indexOf(oneCodeAnchor) + oneCodeAnchor.length);
    }
    if (lower.includes(codexMonitorAnchor)) {
        return clean.slice(lower.indexOf(codexMonitorAnchor) + codexMonitorAnchor.length);
    }
    if (/^(?:[a-z]:)?\/.+\/src-tauri\/src\//i.test(clean)) {
        return clean.slice(clean.toLowerCase().indexOf("src-tauri/src/"));
    }
    if (/^(?:[a-z]:)?\/.+\/src\//i.test(clean)) {
        return clean.slice(clean.toLowerCase().indexOf("src/"));
    }
    if (/^(?:src|src-tauri\/src)\//i.test(clean))
        return clean;
    return "";
}
function inferReferenceSourceFromLine(line, currentHeadingSource) {
    const lower = line.toLowerCase();
    if (lower.includes("reference/1code") || /^##\s*1code\b/i.test(line))
        return "1code";
    if (lower.includes("reference/codexmonitor") || /^##\s*codexmonitor\b/i.test(line))
        return "codexmonitor";
    return currentHeadingSource;
}
function extractArchitecturePathMapRows(markdown) {
    const rows = new Map();
    const lines = markdown.split(/\r?\n/g);
    let currentSource = null;
    for (const line of lines) {
        currentSource = inferReferenceSourceFromLine(line, currentSource);
        const candidates = new Set();
        const backtickRegex = /`([^`\n\r]+)`/g;
        let backtickMatch = null;
        while ((backtickMatch = backtickRegex.exec(line)) !== null) {
            candidates.add(backtickMatch[1]);
        }
        const pathRegex = /\b(?:[A-Za-z]:\/[^\s|)]+|\/[^\s|)]+|(?:src|src-tauri\/src)\/[^\s|)]+)/g;
        let pathMatch = null;
        while ((pathMatch = pathRegex.exec(line)) !== null) {
            candidates.add(pathMatch[0]);
        }
        for (const candidate of candidates) {
            const normalizedPath = normalizeArchitectureReferencePath(candidate);
            if (!normalizedPath)
                continue;
            if (!/\.(?:tsx?|jsx?|rs)$/i.test(normalizedPath))
                continue;
            const source = currentSource ??
                (normalizedPath.startsWith("src-tauri/src/") ? "codexmonitor" : null);
            if (!source)
                continue;
            const layer = inferLayerFromReferenceFile(normalizedPath);
            const tokens = dedupeKeywords([
                ...splitReferenceToken(normalizedPath),
                ...extractNameTokens(path.basename(normalizedPath, path.extname(normalizedPath))),
            ], 96).map((token) => token.toLowerCase());
            if (tokens.length === 0)
                continue;
            const key = `${source}|${normalizedPath}`;
            const existing = rows.get(key);
            if (existing) {
                const merged = dedupeKeywords([...existing.tokens, ...tokens], 128).map((token) => token.toLowerCase());
                rows.set(key, {
                    ...existing,
                    tokens: merged,
                    score: Math.max(existing.score, layer === "unknown" ? 120 : 170),
                });
                continue;
            }
            rows.set(key, {
                source,
                file: normalizedPath,
                layer,
                tokens,
                score: layer === "unknown" ? 120 : 170,
            });
        }
    }
    return Array.from(rows.values()).sort((a, b) => {
        if (a.score !== b.score)
            return b.score - a.score;
        if (a.source !== b.source)
            return a.source.localeCompare(b.source);
        return a.file.localeCompare(b.file);
    });
}
function extractNameTokens(value) {
    const raw = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/g)
        .filter((part) => part.length >= 2)
        .map((part) => part.toLowerCase());
    return dedupeKeywords(raw, 64).map((item) => item.toLowerCase());
}
function normalizeReferenceSymbolKind(kind) {
    const lower = kind.toLowerCase();
    if (/(class|struct|enum|interface|type)/.test(lower))
        return "class";
    if (/(function|fn|method)/.test(lower))
        return "function";
    return "other";
}
function isMeaningfulReferenceSymbolName(name) {
    if (name.length < 4 || name.length > 72)
        return false;
    if (!/[A-Za-z]/.test(name))
        return false;
    if (/^[a-z]{1,3}$/.test(name))
        return false;
    if (/^[A-Z]{1,3}$/.test(name))
        return false;
    if (/^\d+$/.test(name))
        return false;
    if (/^(run|main|start|stop|kind|usage|header|app|state|data)$/i.test(name))
        return false;
    return true;
}
function loadReferenceSignalProfile(referenceMapPath, reportDir) {
    const normalizedPath = path.resolve(referenceMapPath);
    const empty = buildEmptyReferenceKeywordGroups();
    const warnings = [];
    if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isFile()) {
        warnings.push(`Reference map not found: ${toPosixPath(normalizedPath)}`);
        return {
            sourcePath: toPosixPath(normalizedPath),
            copiedPath: "",
            loaded: false,
            bytes: 0,
            excerpt: [],
            warnings,
            keywordGroups: empty,
        };
    }
    const markdown = readUtf8(normalizedPath);
    const categorized = categorizeReferenceKeywords(extractReferenceTokens(markdown));
    const groups = {
        ...categorized,
        domains: buildReferenceDomainKeywords(categorized),
    };
    const copyPath = path.join(reportDir, path.basename(normalizedPath));
    ensureDir(path.dirname(copyPath));
    fs.copyFileSync(normalizedPath, copyPath);
    const excerpt = markdown
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 20);
    return {
        sourcePath: toPosixPath(normalizedPath),
        copiedPath: toPosixPath(copyPath),
        loaded: true,
        bytes: Buffer.byteLength(markdown, "utf8"),
        excerpt,
        warnings,
        keywordGroups: groups,
    };
}
function loadReferenceSymbolMapRows(input) {
    const normalizedPath = path.resolve(input.mapPath);
    const warnings = [];
    if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isFile()) {
        warnings.push(`Reference symbol map not found: ${toPosixPath(normalizedPath)}`);
        return {
            loaded: false,
            sourcePath: toPosixPath(normalizedPath),
            copiedPath: "",
            warnings,
            rows: [],
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(readUtf8(normalizedPath));
    }
    catch (error) {
        warnings.push(`Failed to parse symbol map (${toPosixPath(normalizedPath)}): ${error instanceof Error ? error.message : String(error)}`);
        return {
            loaded: false,
            sourcePath: toPosixPath(normalizedPath),
            copiedPath: "",
            warnings,
            rows: [],
        };
    }
    const rows = [];
    const consume = (list) => {
        if (!list)
            return;
        for (const item of list) {
            const name = (item.name ?? "").trim();
            const file = toPosixPath((item.file ?? "").trim());
            const kind = (item.kind ?? "").trim();
            if (!name || !file || !kind)
                continue;
            if (!isMeaningfulReferenceSymbolName(name))
                continue;
            const symbolKind = normalizeReferenceSymbolKind(kind);
            if (symbolKind === "other")
                continue;
            const tokens = dedupeKeywords([...extractNameTokens(name), ...extractNameTokens(file)], 80);
            rows.push({
                source: input.source,
                name,
                file,
                kind,
                score: Number.isFinite(item.score) ? Number(item.score) : 0,
                refs: Number.isFinite(item.refs) ? Number(item.refs) : 0,
                exported: !!item.exported,
                symbolKind,
                tokens,
            });
        }
    };
    consume(parsed.topClasses);
    consume(parsed.topFunctions);
    const deduped = new Map();
    for (const row of rows) {
        const key = `${row.source}|${row.symbolKind}|${row.name}|${row.file}`;
        const existing = deduped.get(key);
        if (!existing || row.score > existing.score)
            deduped.set(key, row);
    }
    const copyPath = path.join(input.reportDir, `${input.source}-symbol-map.json`);
    ensureDir(path.dirname(copyPath));
    fs.copyFileSync(normalizedPath, copyPath);
    return {
        loaded: true,
        sourcePath: toPosixPath(normalizedPath),
        copiedPath: toPosixPath(copyPath),
        warnings,
        rows: Array.from(deduped.values()),
    };
}
function loadReferenceSymbolProfile(input) {
    const oneCode = loadReferenceSymbolMapRows({
        source: "1code",
        mapPath: input.oneCodeSymbolMapPath,
        reportDir: input.reportDir,
    });
    const codexMonitor = loadReferenceSymbolMapRows({
        source: "codexmonitor",
        mapPath: input.codexMonitorSymbolMapPath,
        reportDir: input.reportDir,
    });
    return {
        loaded: oneCode.loaded && codexMonitor.loaded,
        oneCodePath: oneCode.sourcePath,
        codexMonitorPath: codexMonitor.sourcePath,
        oneCodeCopiedPath: oneCode.copiedPath,
        codexMonitorCopiedPath: codexMonitor.copiedPath,
        warnings: [...oneCode.warnings, ...codexMonitor.warnings],
        symbols: [...oneCode.rows, ...codexMonitor.rows],
    };
}
function buildUnifiedReferenceFileProfiles(symbols, pathMapRows) {
    const map = new Map();
    for (const symbol of symbols) {
        const key = `${symbol.source}|${symbol.file}`;
        const current = map.get(key) ?? {
            source: symbol.source,
            file: symbol.file,
            maxScore: 0,
            symbolCount: 0,
            tokens: new Set(),
            origin: "symbol-map",
        };
        current.maxScore = Math.max(current.maxScore, symbol.score);
        current.symbolCount += 1;
        for (const token of symbol.tokens)
            current.tokens.add(token);
        current.origin = "symbol-map";
        map.set(key, current);
    }
    for (const row of pathMapRows) {
        const key = `${row.source}|${row.file}`;
        const current = map.get(key) ?? {
            source: row.source,
            file: row.file,
            maxScore: 0,
            symbolCount: 0,
            tokens: new Set(),
            origin: "path-map",
        };
        current.maxScore = Math.max(current.maxScore, row.score);
        for (const token of row.tokens)
            current.tokens.add(token.toLowerCase());
        if (current.origin !== "symbol-map")
            current.origin = "path-map";
        map.set(key, current);
    }
    return Array.from(map.values())
        .map((row) => ({
        source: row.source,
        file: row.file,
        symbolCount: row.symbolCount,
        maxScore: row.maxScore,
        tokens: Array.from(row.tokens).sort((a, b) => a.localeCompare(b)),
        origin: row.origin,
    }))
        .sort((a, b) => {
        if (a.maxScore !== b.maxScore)
            return b.maxScore - a.maxScore;
        if (a.symbolCount !== b.symbolCount)
            return b.symbolCount - a.symbolCount;
        return a.file.localeCompare(b.file);
    });
}
function loadReferenceModel(input) {
    const referenceMapPath = normalizeReferenceInputPath(input.referenceMapPath ?? exports.DEFAULT_REFERENCE_MAP_PATH);
    const oneCodeSymbolMapPath = normalizeReferenceInputPath(input.oneCodeSymbolMapPath ?? exports.DEFAULT_1CODE_SYMBOL_MAP_PATH);
    const codexMonitorSymbolMapPath = normalizeReferenceInputPath(input.codexMonitorSymbolMapPath ?? exports.DEFAULT_CODEXMONITOR_SYMBOL_MAP_PATH);
    const signals = loadReferenceSignalProfile(referenceMapPath, input.reportDir);
    const symbols = loadReferenceSymbolProfile({
        reportDir: input.reportDir,
        oneCodeSymbolMapPath,
        codexMonitorSymbolMapPath,
    });
    const architectureText = signals.loaded && fs.existsSync(referenceMapPath) ? readUtf8(referenceMapPath) : "";
    const pathMap = architectureText ? extractArchitecturePathMapRows(architectureText) : [];
    return {
        generatedAtUtc: new Date().toISOString(),
        signals,
        symbols,
        unified: {
            files: buildUnifiedReferenceFileProfiles(symbols.symbols, pathMap),
            domainKeywords: signals.keywordGroups.domains,
            pathMap,
        },
    };
}
