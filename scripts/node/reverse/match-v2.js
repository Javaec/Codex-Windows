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
exports.buildDeobfuscationTableMatchV2 = buildDeobfuscationTableMatchV2;
const path = __importStar(require("node:path"));
const ts = __importStar(require("typescript"));
const regression_config_1 = require("./regression-config");
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const VENDOR_FILE_HINTS = /(cytoscape|cose-bilkent|mermaid|monaco|vscode-languageserver|xterm|zod|antlr|codicon|pdf\.worker|minimap|highlight-code)/i;
const LOCALE_ASSET_FILE_PATTERN = /^webview\/assets\/[a-z]{2}(?:-[a-z]{2})?-[A-Za-z0-9_-]+\.(?:js|mjs|cjs)$/i;
function roundMetric(value) {
    if (!Number.isFinite(value))
        return 0;
    return Number(value.toFixed(2));
}
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function dedupeKeywords(values, max) {
    const out = new Set();
    for (const value of values) {
        const normalized = value.trim().toLowerCase();
        if (normalized.length < 3 || normalized.length > 90)
            continue;
        if (/^\d+$/.test(normalized))
            continue;
        out.add(normalized);
        if (out.size >= max)
            break;
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
}
function splitSignalToken(value) {
    const normalized = value.trim();
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
function addValueTokens(target, value, limit) {
    for (const token of splitSignalToken(value)) {
        const normalized = token.toLowerCase();
        if (normalized.length < 3)
            continue;
        target.add(normalized);
        if (target.size >= limit)
            break;
    }
}
function extractNameTokens(value) {
    const raw = value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/g)
        .filter((part) => part.length >= 2)
        .map((part) => part.toLowerCase());
    return dedupeKeywords(raw, 64);
}
function isLocaleAssetFile(file) {
    return LOCALE_ASSET_FILE_PATTERN.test(toPosixPath(file));
}
function isLikelyCoreAppFile(file) {
    const lower = toPosixPath(file).toLowerCase();
    if (lower.startsWith(".vite/build/main-"))
        return true;
    if (lower.startsWith(".vite/build/preload-"))
        return true;
    if (lower.startsWith(".vite/build/worker"))
        return true;
    if (lower.startsWith("webview/assets/index-"))
        return true;
    if (lower.startsWith("webview/assets/main-"))
        return true;
    if (lower.startsWith("webview/assets/worker-"))
        return true;
    return false;
}
function isDeobfuscationCandidateFile(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (!JS_EXTENSIONS.has(path.extname(normalized)))
        return false;
    if (isLocaleAssetFile(normalized))
        return false;
    if (VENDOR_FILE_HINTS.test(normalized))
        return false;
    if (normalized.startsWith(".vite/build/main-"))
        return true;
    if (normalized.startsWith(".vite/build/preload-"))
        return true;
    if (normalized.startsWith(".vite/build/worker"))
        return true;
    if (!normalized.startsWith("webview/assets/"))
        return false;
    return /^(?:index|chunk|worker|main|desktop|channel|clone|data-controls|diff|agent-settings|automation|git-settings|init)-/.test(path.basename(normalized));
}
function classifyRuntimeLayer(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (normalized.startsWith(".vite/build/main"))
        return "main";
    if (normalized.startsWith(".vite/build/preload"))
        return "preload";
    if (normalized.startsWith(".vite/build/worker"))
        return "main-worker";
    if (normalized.startsWith("webview/assets/worker"))
        return "renderer-worker";
    if (normalized.startsWith("webview/assets/"))
        return "renderer";
    return "unknown";
}
function buildReferenceTargetPath(referenceFile) {
    const normalized = toPosixPath(referenceFile).replace(/^\.?\//, "");
    if (normalized.startsWith("src-tauri/src/")) {
        return `reconstructed/src-tauri-adapter/${normalized.replace(/^src-tauri\/src\//, "").replace(/\.rs$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/main/")) {
        return `reconstructed/${normalized.replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/renderer/")) {
        return `reconstructed/${normalized.replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/services/")) {
        return `reconstructed/${normalized.replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/features/")) {
        return `reconstructed/src/renderer/${normalized.replace(/^src\//, "").replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/components/") || normalized.startsWith("src/hooks/")) {
        return `reconstructed/src/renderer/${normalized.replace(/^src\//, "").replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/lib/") || normalized.startsWith("src/state/")) {
        return `reconstructed/src/services/${normalized.replace(/^src\//, "").replace(/\.tsx?$/i, ".ts")}`;
    }
    if (normalized.startsWith("src/")) {
        return `reconstructed/src/services/${normalized.replace(/^src\//, "").replace(/\.tsx?$/i, ".ts")}`;
    }
    if (/\.rs$/i.test(normalized)) {
        return `reconstructed/src-tauri-adapter/${normalized.replace(/\.rs$/i, ".ts")}`;
    }
    return `reconstructed/${normalized}`;
}
function isGenericFileStem(stem) {
    return /^(types?|utils?|index|mod|common|shared|state|constants?|helpers?)$/i.test(stem);
}
function buildSignalAwareTargetPath(input) {
    const target = buildReferenceTargetPath(input.referenceFile);
    const normalized = toPosixPath(target);
    const ext = path.posix.extname(normalized) || ".ts";
    const dir = path.posix.dirname(normalized);
    const stem = path.posix.basename(normalized, ext);
    if (!isGenericFileStem(stem))
        return normalized;
    const preferredTokens = dedupeKeywords([
        ...input.hits,
        ...Array.from(input.signal.contextKeywords).slice(0, 80),
        input.signal.dominantDomain,
    ], 24).filter((token) => token.length >= 3 && !/^(types?|utils?|common|shared|state|constants?|unknown)$/.test(token));
    const selectedToken = preferredTokens[0];
    if (!selectedToken)
        return normalized;
    const safeToken = selectedToken.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    if (!safeToken)
        return normalized;
    return path.posix.join(dir, `${safeToken}${ext}`);
}
function isGenericReferenceFilePath(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (/(^|\/)(types?|utils?|index|mod|common|shared|state|constants?)\.(ts|tsx|rs|js|mjs|cjs)$/i.test(normalized))
        return true;
    if (/(^|\/)(types?|utils?|common|shared)(\/|$)/i.test(normalized))
        return true;
    if (/\/icons\/index\./i.test(normalized))
        return true;
    return false;
}
function classifyReferenceDomain(file) {
    const normalized = toPosixPath(file).toLowerCase();
    if (/(chat|thread|conversation|agent|mention|diff)/.test(normalized))
        return "chat_sessions";
    if (/(settings|skill|auth|config|model|preferences|profile)/.test(normalized))
        return "settings_skills";
    if (/(route|router|navigation|sidebar|panel|layout|viewer|view|ui)/.test(normalized))
        return "navigation";
    if (/(event|stream|delta|status|state|runtime|ipc|tauri|backend|transport|sync|ready)/.test(normalized))
        return "async_readiness";
    return "unknown";
}
function scoreRegressionHint(sourceFile, referenceFile) {
    const normalizedSource = toPosixPath(sourceFile);
    const normalizedReference = toPosixPath(referenceFile);
    let boost = 0;
    for (const rule of regression_config_1.MATCH_V2_REGRESSION_HINTS) {
        if (!rule.sourcePattern.test(normalizedSource))
            continue;
        const preferredHit = rule.preferredReferencePatterns.some((pattern) => pattern.test(normalizedReference));
        const avoidHit = rule.avoidReferencePatterns?.some((pattern) => pattern.test(normalizedReference)) ?? false;
        if (preferredHit)
            boost += 0.95;
        if (avoidHit)
            boost -= 0.85;
    }
    return boost;
}
function getLayerMismatchPenalty(layer, referenceFile) {
    const normalized = toPosixPath(referenceFile).toLowerCase();
    const isRendererReference = /(^|\/)src\/renderer\//.test(normalized) || /\/renderer\//.test(normalized);
    const isMainReference = /(^|\/)src\/main\//.test(normalized) || /\/main\//.test(normalized);
    const isPreloadReference = /(^|\/)src\/preload\//.test(normalized) || /\/preload\//.test(normalized);
    const isTauriReference = /src-tauri\/src\//.test(normalized) || /\/backend\//.test(normalized);
    if ((layer === "renderer" || layer === "renderer-worker") && (isMainReference || isTauriReference))
        return 1.7;
    if ((layer === "main" || layer === "main-worker") && isRendererReference)
        return 1.6;
    if (layer === "preload" && !isPreloadReference && (isRendererReference || isMainReference || isTauriReference))
        return 1.1;
    return 0;
}
function computeDomainScores(contextKeywords, domainKeywords) {
    const scores = {};
    let dominantDomain = "unknown";
    let dominantScore = 0;
    for (const [domain, keywords] of Object.entries(domainKeywords)) {
        const keywordSet = new Set(keywords.map((item) => item.trim().toLowerCase()).filter((item) => item.length >= 3));
        if (keywordSet.size === 0) {
            scores[domain] = 0;
            continue;
        }
        let hits = 0;
        for (const token of contextKeywords) {
            if (!keywordSet.has(token.toLowerCase()))
                continue;
            hits += 1;
        }
        const score = roundMetric((hits * 100) / Math.max(12, keywordSet.size));
        scores[domain] = score;
        if (score > dominantScore) {
            dominantScore = score;
            dominantDomain = domain;
        }
    }
    if (dominantScore < 1.2)
        dominantDomain = "unknown";
    return { domainScores: scores, dominantDomain };
}
function scoreDomainAlignment(profile, referenceFile) {
    const referenceDomain = classifyReferenceDomain(referenceFile);
    if (referenceDomain === "unknown")
        return { boost: 0, penalty: 0.25 };
    const domainScore = profile.domainScores[referenceDomain] ?? 0;
    if (profile.dominantDomain === referenceDomain) {
        return { boost: Math.min(1.6, domainScore * 0.25 + 0.35), penalty: 0 };
    }
    if (profile.dominantDomain !== "unknown") {
        const dominantScore = profile.domainScores[profile.dominantDomain] ?? 0;
        if (dominantScore >= domainScore + 0.8)
            return { boost: 0, penalty: 0.95 };
    }
    return { boost: Math.min(0.45, domainScore * 0.1), penalty: 0.2 };
}
function computeSourceReferenceAnchors(input) {
    const anchors = new Map();
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isDeobfuscationCandidateFile(relPath))
            continue;
        const signal = input.fileSignals.get(relPath);
        if (!signal)
            continue;
        let best;
        const top = [];
        for (const profile of input.referenceFileProfiles) {
            const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
            if (!best || scored.score > best.score)
                best = { profile, score: scored.score, hits: scored.hits };
            top.push({ profile, score: scored.score, hits: scored.hits });
        }
        if (!best)
            continue;
        top.sort((a, b) => b.score - a.score);
        const selected = top.filter((row) => row.score >= best.score - 1.2).slice(0, 4);
        if (selected.length === 0)
            continue;
        if (best.score < 3.8 && getTotalSignalStrength(signal) < 9)
            continue;
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
function getAnchorBoost(anchor, referenceFile) {
    if (!anchor)
        return 0;
    if (referenceFile === anchor.primaryFile)
        return 1.9;
    if (anchor.secondaryFiles.includes(referenceFile))
        return 1.1;
    return 0;
}
function isLikelyObfuscatedClassName(name) {
    if (name.length < 2)
        return false;
    if (name.length === 2)
        return true;
    if (/^[A-Z][a-z]?$/.test(name))
        return true;
    if (/^[A-Z][0-9]{1,2}$/.test(name))
        return true;
    if (/^[A-Z][A-Za-z0-9]{0,3}$/.test(name) && !/[aeiou]/i.test(name))
        return true;
    return false;
}
function isLikelyObfuscatedFunctionName(name) {
    if (name.length < 2)
        return false;
    const lower = name.toLowerCase();
    if (name.length <= 2)
        return true;
    if (/^[$_]?[a-z][0-9]{1,2}$/.test(name))
        return true;
    if (/^[$_]?[a-z]{1,3}$/.test(name) && !/(get|set|use|run|open|close|load|save|send|read|write)/.test(lower))
        return true;
    if (/^[a-z][a-z0-9]{0,3}$/.test(name) && !/[aeiou]/i.test(name))
        return true;
    return false;
}
function normalizeSourceForPrint(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
        .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}
function collectObfuscatedSymbolsFromSource(input) {
    const candidates = [];
    let sourceFile;
    try {
        sourceFile = ts.createSourceFile(input.relPath, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    }
    catch {
        return candidates;
    }
    const pushCandidate = (kind, name, node) => {
        const isCandidate = kind === "class" ? isLikelyObfuscatedClassName(name) : isLikelyObfuscatedFunctionName(name);
        if (!isCandidate)
            return;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        candidates.push({ kind, name, sourceFile: input.relPath, line: position.line + 1, tokens: extractNameTokens(name) });
    };
    const getPropertyNameText = (name) => {
        if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
            return name.text;
        if (ts.isStringLiteral(name) || ts.isNumericLiteral(name))
            return name.text;
        if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
            return name.expression.text;
        return "";
    };
    const visit = (node) => {
        if (ts.isClassDeclaration(node) && node.name) {
            pushCandidate("class", node.name.text, node.name);
        }
        else if (ts.isFunctionDeclaration(node) && node.name) {
            pushCandidate("function", node.name.text, node.name);
        }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
                pushCandidate("function", node.name.text, node.name);
        }
        else if (ts.isMethodDeclaration(node) && node.name) {
            const methodName = getPropertyNameText(node.name);
            if (methodName.length > 0)
                pushCandidate("function", methodName, node.name);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return candidates;
}
function inferReferenceLayer(file) {
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
function buildReferenceFileProfiles(symbols, unifiedFiles) {
    const map = new Map();
    for (const symbol of symbols) {
        const key = `${symbol.source}|${symbol.file}`;
        const row = map.get(key) ?? {
            source: symbol.source,
            file: symbol.file,
            maxScore: 0,
            symbolCount: 0,
            tokens: new Set(),
            origin: "symbol-map",
            layer: inferReferenceLayer(symbol.file),
        };
        row.maxScore = Math.max(row.maxScore, symbol.score);
        row.symbolCount += 1;
        for (const token of symbol.tokens)
            row.tokens.add(token.toLowerCase());
        row.origin = "symbol-map";
        row.layer = inferReferenceLayer(symbol.file);
        map.set(key, row);
    }
    for (const row of unifiedFiles) {
        const key = `${row.source}|${row.file}`;
        const current = map.get(key) ?? {
            source: row.source,
            file: row.file,
            maxScore: 0,
            symbolCount: 0,
            tokens: new Set(),
            origin: row.origin,
            layer: inferReferenceLayer(row.file),
        };
        current.maxScore = Math.max(current.maxScore, row.maxScore);
        current.symbolCount = Math.max(current.symbolCount, row.symbolCount);
        for (const token of row.tokens)
            current.tokens.add(token.toLowerCase());
        if (current.origin !== "symbol-map")
            current.origin = row.origin;
        current.layer = inferReferenceLayer(row.file);
        map.set(key, current);
    }
    return Array.from(map.values());
}
function buildFileSignalProfiles(input) {
    const profiles = new Map();
    const ensureProfile = (file) => {
        const current = profiles.get(file);
        if (current)
            return current;
        const created = {
            contextKeywords: new Set(),
            ast: 0,
            ipcRpc: 0,
            state: 0,
            boundary: 0,
            boundaryOwnership: 0,
            uiLikelihood: 0,
            flow: 0,
            domainScores: {},
            dominantDomain: "unknown",
        };
        profiles.set(file, created);
        return created;
    };
    for (const file of input.jsFiles) {
        if (!isDeobfuscationCandidateFile(file.relPath))
            continue;
        ensureProfile(file.relPath);
    }
    const addRows = (rows, kind, increment) => {
        for (const row of rows) {
            for (const file of row.files) {
                if (!isDeobfuscationCandidateFile(file))
                    continue;
                const profile = ensureProfile(file);
                addValueTokens(profile.contextKeywords, row.value, 320);
                if (kind === "ast")
                    profile.ast += increment;
                if (kind === "ipcRpc")
                    profile.ipcRpc += increment;
                if (kind === "state")
                    profile.state += increment;
                if (kind === "flow")
                    profile.flow += increment;
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
        if (!isDeobfuscationCandidateFile(boundary.ownerFile))
            continue;
        const profile = ensureProfile(boundary.ownerFile);
        profile.boundary += 3;
        profile.ast += 2;
        if (typeof boundary.ownershipScore === "number" && Number.isFinite(boundary.ownershipScore)) {
            profile.boundaryOwnership = Math.max(profile.boundaryOwnership, boundary.ownershipScore);
        }
        if (typeof boundary.uiLikelihood === "number" && Number.isFinite(boundary.uiLikelihood)) {
            profile.uiLikelihood = Math.max(profile.uiLikelihood, boundary.uiLikelihood);
        }
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
            for (const value of group)
                addValueTokens(profile.contextKeywords, value, 360);
        }
        profile.flow += Math.min(5, boundary.routes.length + boundary.events.length);
        profile.ipcRpc += Math.min(5, boundary.rpcMethods.length + boundary.ipcChannels.length);
        profile.state += Math.min(4, boundary.stateKeys.length + boundary.statuses.length);
    }
    return profiles;
}
function getFileSignalScore(profile) {
    const signalWeights = regression_config_1.MATCH_V2_SCORE_WEIGHTS.signal;
    const ownershipBoost = Math.min(0.9, profile.boundaryOwnership / 42);
    const uiBoost = Math.min(0.5, profile.uiLikelihood * 0.5);
    return roundMetric(Math.min(signalWeights.astCap, profile.ast * signalWeights.astWeight) +
        Math.min(signalWeights.ipcRpcCap, profile.ipcRpc * signalWeights.ipcRpcWeight) +
        Math.min(signalWeights.stateCap, profile.state * signalWeights.stateWeight) +
        Math.min(signalWeights.boundaryCap, profile.boundary * signalWeights.boundaryWeight) +
        Math.min(signalWeights.flowCap, profile.flow * signalWeights.flowWeight) +
        ownershipBoost +
        uiBoost);
}
function scoreReferenceFileProfile(input) {
    const fileWeights = regression_config_1.MATCH_V2_SCORE_WEIGHTS.file;
    const hits = [];
    for (const token of input.profile.tokens) {
        if (!input.fileSignals.contextKeywords.has(token))
            continue;
        hits.push(token);
    }
    const layer = classifyRuntimeLayer(input.sourceFile);
    let layerBoost = 0;
    if ((layer === "renderer" || layer === "renderer-worker") && input.profile.layer === "renderer")
        layerBoost += fileWeights.layerRendererBoost;
    if ((layer === "main" || layer === "main-worker") && input.profile.layer === "main")
        layerBoost += fileWeights.layerMainBoost;
    if (layer === "preload" && input.profile.file.includes("/preload/"))
        layerBoost += fileWeights.layerPreloadBoost;
    if ((layer === "main" || layer === "main-worker") && input.profile.layer === "tauri") {
        layerBoost += fileWeights.layerMainToTauriBoost;
    }
    if ((layer === "renderer" || layer === "renderer-worker") && input.profile.layer === "services") {
        layerBoost += fileWeights.layerRendererToServicesBoost;
    }
    const layerMismatchPenalty = getLayerMismatchPenalty(layer, input.profile.file);
    const domain = scoreDomainAlignment(input.fileSignals, input.profile.file);
    const qualityBoost = Math.min(fileWeights.qualityBoostCap, input.profile.maxScore / fileWeights.qualityDivisor);
    const sourceBoost = input.profile.source === "1code" ? fileWeights.sourceOneCodeBoost : fileWeights.sourceCodexMonitorBoost;
    const originBoost = input.profile.origin === "symbol-map" ? fileWeights.originSymbolMapBoost : fileWeights.originPathMapBoost;
    const pathMapAlignmentBoost = input.profile.origin === "path-map" && layerMismatchPenalty === 0 && input.profile.layer !== "unknown"
        ? fileWeights.pathMapLayerAlignBoost
        : 0;
    const pathMapUnknownPenalty = input.profile.origin === "path-map" && input.profile.layer === "unknown" ? fileWeights.pathMapUnknownPenalty : 0;
    const regressionBoost = scoreRegressionHint(input.sourceFile, input.profile.file);
    const genericPathPenalty = isGenericReferenceFilePath(input.profile.file) ? fileWeights.genericPathPenalty : 0;
    const broadFilePenalty = input.profile.symbolCount > fileWeights.broadFilePenaltyStart
        ? Math.min(fileWeights.broadFilePenaltyCap, (input.profile.symbolCount - fileWeights.broadFilePenaltyStart) * fileWeights.broadFilePenaltyStep)
        : 0;
    const heavyTokenPenalty = input.profile.tokens.size > fileWeights.heavyTokenPenaltyStart
        ? Math.min(fileWeights.heavyTokenPenaltyCap, (input.profile.tokens.size - fileWeights.heavyTokenPenaltyStart) * fileWeights.heavyTokenPenaltyStep)
        : 0;
    const rustPenalty = /\.rs$/i.test(input.profile.file) ? fileWeights.rustPenalty : 0;
    const score = hits.length * fileWeights.tokenHitWeight +
        layerBoost +
        domain.boost +
        qualityBoost +
        sourceBoost +
        originBoost +
        pathMapAlignmentBoost +
        regressionBoost +
        getFileSignalScore(input.fileSignals) -
        genericPathPenalty -
        broadFilePenalty -
        heavyTokenPenalty -
        layerMismatchPenalty -
        domain.penalty -
        pathMapUnknownPenalty -
        rustPenalty;
    return { score, hits: dedupeKeywords(hits, 12) };
}
function scoreSymbolOwnershipAlignment(input) {
    const referencePath = toPosixPath(input.referenceFile).toLowerCase();
    const isRendererReference = /(^|\/)src\/renderer\//.test(referencePath);
    const isMainReference = /(^|\/)src\/main\//.test(referencePath);
    const isServicesReference = /(^|\/)src\/services\//.test(referencePath);
    const isTauriReference = /^src-tauri\/src\//.test(referencePath) || /(^|\/)src-tauri-adapter\//.test(referencePath);
    const ownership = input.fileSignals.boundaryOwnership;
    const uiLikelihood = input.fileSignals.uiLikelihood;
    const ownershipBoost = Math.min(0.95, ownership / 36);
    const hitBoost = Math.min(0.45, input.hitCount * 0.08);
    let boost = 0;
    let penalty = 0;
    if (isRendererReference && uiLikelihood >= 0.45) {
        boost += Math.min(0.85, uiLikelihood * 0.9);
    }
    if ((isMainReference || isTauriReference) && uiLikelihood <= 0.35 && ownership >= 10) {
        boost += Math.min(0.6, ownership / 28);
    }
    if (isServicesReference && ownership >= 12 && input.fileSignals.state >= 4) {
        boost += 0.35;
    }
    if (isRendererReference && uiLikelihood < 0.2 && input.sourceLayer !== "renderer" && input.sourceLayer !== "renderer-worker") {
        penalty += 0.55;
    }
    if ((isMainReference || isTauriReference) && uiLikelihood >= 0.75 && input.sourceLayer === "renderer") {
        penalty += 0.4;
    }
    boost += ownershipBoost + hitBoost;
    return { boost, penalty };
}
function scoreReferenceSymbolMatch(input) {
    const symbolWeights = regression_config_1.MATCH_V2_SCORE_WEIGHTS.symbol;
    const scopedKeywords = new Set(input.fileSignals.contextKeywords);
    for (const token of input.candidate.tokens)
        scopedKeywords.add(token);
    const hits = [];
    for (const token of input.reference.tokens) {
        if (!scopedKeywords.has(token.toLowerCase()))
            continue;
        hits.push(token);
    }
    const layer = classifyRuntimeLayer(input.sourceFile);
    let layerBoost = 0;
    if ((layer === "renderer" || layer === "renderer-worker") && input.reference.file.includes("/renderer/")) {
        layerBoost += symbolWeights.layerRendererBoost;
    }
    if ((layer === "main" || layer === "main-worker") && input.reference.file.includes("/main/")) {
        layerBoost += symbolWeights.layerMainBoost;
    }
    if (layer === "preload" && input.reference.file.includes("/preload/")) {
        layerBoost += symbolWeights.layerPreloadBoost;
    }
    const layerMismatchPenalty = getLayerMismatchPenalty(layer, input.reference.file);
    const domain = scoreDomainAlignment(input.fileSignals, input.reference.file);
    const anchorBoost = getAnchorBoost(input.anchor, input.reference.file);
    const symbolKindBoost = input.candidate.kind === input.reference.symbolKind ? symbolWeights.symbolKindBoost : 0;
    const qualityBoost = Math.min(symbolWeights.qualityBoostCap, input.reference.score / symbolWeights.qualityDivisor);
    const genericPathPenalty = isGenericReferenceFilePath(input.reference.file) ? symbolWeights.genericPathPenalty : 0;
    const genericNamePenalty = /^(run|main|start|stop|kind|usage|header|app|state|data)$/i.test(input.reference.name)
        ? symbolWeights.genericNamePenalty
        : 0;
    const rustPenalty = /\.rs$/i.test(input.reference.file) ? symbolWeights.rustPenalty : 0;
    const broadFilePenalty = /(types?|utils?|common|shared|state)/i.test(input.reference.file)
        ? symbolWeights.broadFilePenalty
        : 0;
    const pathMapLayerAlignmentBoost = /(^|\/)src\/(?:main|renderer|services)\//.test(toPosixPath(input.reference.file)) && layerMismatchPenalty === 0
        ? symbolWeights.pathMapLayerAlignBoost
        : 0;
    const ownershipAlignment = scoreSymbolOwnershipAlignment({
        sourceLayer: layer,
        referenceFile: input.reference.file,
        fileSignals: input.fileSignals,
        hitCount: hits.length,
    });
    const score = hits.length * symbolWeights.tokenHitWeight +
        layerBoost +
        domain.boost +
        anchorBoost +
        symbolKindBoost +
        qualityBoost +
        pathMapLayerAlignmentBoost +
        ownershipAlignment.boost +
        getFileSignalScore(input.fileSignals) +
        Math.min(symbolWeights.candidateTokenBoostCap, input.candidate.tokens.length * symbolWeights.candidateTokenBoostStep) -
        genericPathPenalty -
        broadFilePenalty -
        genericNamePenalty -
        layerMismatchPenalty -
        domain.penalty -
        ownershipAlignment.penalty -
        rustPenalty;
    return { score, hits: dedupeKeywords(hits, 12) };
}
function getTotalSignalStrength(profile) {
    return profile.ast + profile.ipcRpc + profile.state + profile.boundary + profile.flow;
}
function isFileCandidateForPlan(input) {
    const baseName = path.basename(input.relPath);
    const bareName = baseName.replace(/\.[^.]+$/, "");
    const obviousObfuscated = isLikelyObfuscatedClassName(bareName) || /-(?:[A-Za-z0-9]{6,})\.(?:js|mjs|cjs)$/i.test(baseName);
    if (obviousObfuscated)
        return true;
    const bundlerChunkLike = /^(?:index|main|chunk|worker|desktop|channel|clone|data-controls|diff|agent-settings|automation|git-settings|init)-[A-Za-z0-9]{6,}\.(?:js|mjs|cjs)$/i.test(baseName);
    if (!bundlerChunkLike)
        return false;
    const signalStrength = getTotalSignalStrength(input.signal);
    const strongCoreSignals = isLikelyCoreAppFile(input.relPath) && signalStrength >= 7 && input.signal.contextKeywords.size >= 5;
    const anchorDrivenSignals = !!input.sourceAnchor && input.sourceAnchor.score >= 3.4 && signalStrength >= 6;
    const richFlowSignals = input.signal.flow >= 8 && input.signal.ipcRpc >= 4 && input.signal.contextKeywords.size >= 6;
    const dominantKnownDomain = input.signal.dominantDomain !== "unknown" && signalStrength >= 8;
    return strongCoreSignals || anchorDrivenSignals || richFlowSignals || dominantKnownDomain;
}
function buildDeobfuscationTableMatchV2(input) {
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
    const referenceFileProfiles = buildReferenceFileProfiles(referenceSymbolProfile.symbols, input.referenceModel.unified.files);
    const sourceReferenceAnchors = computeSourceReferenceAnchors({
        jsFiles: input.jsFiles,
        fileSignals,
        referenceFileProfiles,
    });
    const entries = [];
    const filePlans = [];
    let obfuscatedFileCandidates = 0;
    let obfuscatedSymbolCandidates = 0;
    const seenEntry = new Set();
    const filePlanCountByTargetPath = new Map();
    const symbolMatchCountByReference = new Map();
    const symbolMatchCountByFile = new Map();
    const symbolMatchCountByTargetFile = new Map();
    const symbolMatchCountBySourceTarget = new Map();
    const symbolTargetByFile = new Set();
    for (const file of input.jsFiles) {
        const relPath = file.relPath;
        if (!isDeobfuscationCandidateFile(relPath))
            continue;
        const signal = fileSignals.get(relPath);
        if (!signal)
            continue;
        if (!isLikelyCoreAppFile(relPath) && signal.contextKeywords.size < 3)
            continue;
        const sourceAnchor = sourceReferenceAnchors.get(relPath);
        const signalStrength = getTotalSignalStrength(signal);
        if (isFileCandidateForPlan({ relPath, signal, sourceAnchor })) {
            obfuscatedFileCandidates += 1;
            let mappedFilePlan = false;
            let bestFileScore = 0;
            let bestFileHits = [];
            let bestProfile;
            if (sourceAnchor) {
                for (const profile of referenceFileProfiles) {
                    if (profile.file !== sourceAnchor.primaryFile)
                        continue;
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    if (scored.score <= bestFileScore)
                        continue;
                    bestFileScore = scored.score;
                    bestFileHits = scored.hits;
                    bestProfile = profile;
                }
            }
            if (!bestProfile) {
                for (const profile of referenceFileProfiles) {
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    if (scored.score <= bestFileScore)
                        continue;
                    bestFileScore = scored.score;
                    bestFileHits = scored.hits;
                    bestProfile = profile;
                }
            }
            let selectedProfile = bestProfile;
            let selectedFileScore = bestFileScore;
            let selectedFileHits = bestFileHits;
            let usedNonGenericFallback = false;
            if (bestProfile && isGenericReferenceFilePath(bestProfile.file)) {
                const fallbackRows = [];
                for (const profile of referenceFileProfiles) {
                    if (isGenericReferenceFilePath(profile.file))
                        continue;
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    fallbackRows.push({ profile, score: scored.score, hits: scored.hits });
                }
                fallbackRows.sort((a, b) => b.score - a.score);
                const fallbackPrimary = fallbackRows[0];
                const fallbackAnchored = sourceAnchor &&
                    fallbackRows.find((row) => row.profile.file === sourceAnchor.primaryFile || sourceAnchor.secondaryFiles.includes(row.profile.file));
                const fallbackRow = fallbackAnchored && fallbackAnchored.score >= ((fallbackPrimary?.score ?? 0) - 1.3) ? fallbackAnchored : fallbackPrimary;
                const fallbackScore = fallbackRow?.score ?? 0;
                const fallbackHits = fallbackRow?.hits ?? [];
                const fallbackProfile = fallbackRow?.profile;
                const genericGap = bestFileScore - fallbackScore;
                const sourceAnchorsFallback = sourceAnchor ? fallbackProfile?.file === sourceAnchor.primaryFile : false;
                const strongSignal = signalStrength >= 12;
                const shouldUseFallback = !!fallbackProfile &&
                    fallbackScore >= 3.0 &&
                    (genericGap <= 4.5 || sourceAnchorsFallback || signalStrength >= 9);
                if (fallbackProfile && shouldUseFallback) {
                    selectedProfile = fallbackProfile;
                    selectedFileScore = fallbackScore;
                    selectedFileHits = fallbackHits;
                    usedNonGenericFallback = true;
                }
            }
            const strongSignal = signalStrength >= 12;
            const minFileScore = selectedProfile && isGenericReferenceFilePath(selectedProfile.file)
                ? regression_config_1.MATCH_V2_THRESHOLDS.genericSelectionMinScore
                : sourceAnchor
                    ? 3.4
                    : strongSignal
                        ? 3.7
                        : 4.3;
            const minHits = sourceAnchor || strongSignal || usedNonGenericFallback ? 1 : 2;
            const isGenericBestProfile = selectedProfile ? isGenericReferenceFilePath(selectedProfile.file) : false;
            const nonGenericFallbackMinScore = sourceAnchor
                ? regression_config_1.MATCH_V2_THRESHOLDS.nonGenericSelectionMinScoreStrongAnchor
                : strongSignal
                    ? regression_config_1.MATCH_V2_THRESHOLDS.nonGenericSelectionMinScoreStrongSignal
                    : regression_config_1.MATCH_V2_THRESHOLDS.nonGenericSelectionMinScoreDefault;
            if (selectedProfile &&
                selectedFileScore >= (usedNonGenericFallback ? nonGenericFallbackMinScore : minFileScore) &&
                (selectedFileHits.length >= minHits || signalStrength >= 8) &&
                (!isGenericBestProfile || (selectedFileHits.length >= 4 && signalStrength >= 13))) {
                if (!isGenericBestProfile) {
                    const confidenceRaw = Math.min(0.96, roundMetric(0.24 + selectedFileScore / 12.5));
                    const targetProjectPath = buildSignalAwareTargetPath({
                        referenceFile: selectedProfile.file,
                        signal,
                        hits: selectedFileHits,
                    });
                    const targetCount = filePlanCountByTargetPath.get(targetProjectPath) ?? 0;
                    const targetLimit = usedNonGenericFallback ? 2 : 1;
                    if (targetCount >= targetLimit) {
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
                        targetCount > 0 ? "target-collision: allowed-duplicate-target-mapping" : "target-collision: none",
                        `reference-file: ${selectedProfile.file}`,
                        `match-v2-score: ${roundMetric(selectedFileScore)}`,
                    ];
                    filePlans.push({ sourceFile: relPath, proposedModulePath: targetProjectPath, confidence, rationale, referenceSource: selectedProfile.source });
                    filePlanCountByTargetPath.set(targetProjectPath, targetCount + 1);
                    mappedFilePlan = true;
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
            if (!mappedFilePlan && sourceAnchor && signalStrength >= 9) {
                const anchorCandidates = [sourceAnchor.primaryFile, ...sourceAnchor.secondaryFiles].filter((candidate) => !isGenericReferenceFilePath(candidate));
                let fallbackAnchor;
                for (const candidateFile of anchorCandidates) {
                    const profile = referenceFileProfiles.find((item) => item.file === candidateFile);
                    if (!profile)
                        continue;
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    if (!fallbackAnchor || scored.score > fallbackAnchor.score) {
                        fallbackAnchor = { profile, score: scored.score, hits: scored.hits };
                    }
                }
                if (fallbackAnchor && fallbackAnchor.score >= 3.1) {
                    const targetProjectPath = buildSignalAwareTargetPath({
                        referenceFile: fallbackAnchor.profile.file,
                        signal,
                        hits: fallbackAnchor.hits,
                    });
                    const targetCount = filePlanCountByTargetPath.get(targetProjectPath) ?? 0;
                    if (targetCount < 1) {
                        const confidence = Math.min(0.92, roundMetric(0.2 + fallbackAnchor.score / 13));
                        const proposedName = path.basename(fallbackAnchor.profile.file).replace(/\.[^.]+$/, "");
                        const rationale = [
                            `keyword-overlap: ${fallbackAnchor.hits.join(", ") || "none"}`,
                            `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
                            `dominant-domain: ${signal.dominantDomain}`,
                            `source-anchor: ${sourceAnchor.primaryFile} (score=${sourceAnchor.score})`,
                            "fallback: anchor-secondary-non-generic",
                            "target-collision: none",
                            `reference-file: ${fallbackAnchor.profile.file}`,
                            `match-v2-score: ${roundMetric(fallbackAnchor.score)}`,
                        ];
                        filePlans.push({
                            sourceFile: relPath,
                            proposedModulePath: targetProjectPath,
                            confidence,
                            rationale,
                            referenceSource: fallbackAnchor.profile.source,
                        });
                        filePlanCountByTargetPath.set(targetProjectPath, targetCount + 1);
                        mappedFilePlan = true;
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
                                    source: fallbackAnchor.profile.source,
                                    symbol: proposedName,
                                    file: fallbackAnchor.profile.file,
                                    kind: "module-file",
                                    score: fallbackAnchor.profile.maxScore,
                                },
                                rationale,
                            });
                        }
                    }
                }
            }
            if (!mappedFilePlan && signalStrength >= 8) {
                let floorFallback;
                for (const profile of referenceFileProfiles) {
                    if (isGenericReferenceFilePath(profile.file))
                        continue;
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    if (!floorFallback || scored.score > floorFallback.score) {
                        floorFallback = { profile, score: scored.score, hits: scored.hits };
                    }
                }
                if (floorFallback && floorFallback.score >= 1.8 && floorFallback.hits.length >= 1) {
                    const targetProjectPath = buildSignalAwareTargetPath({
                        referenceFile: floorFallback.profile.file,
                        signal,
                        hits: floorFallback.hits,
                    });
                    const targetCount = filePlanCountByTargetPath.get(targetProjectPath) ?? 0;
                    if (targetCount < 2) {
                        const confidence = Math.min(0.78, roundMetric(0.32 + floorFallback.score / 20));
                        const proposedName = path.basename(floorFallback.profile.file).replace(/\.[^.]+$/, "");
                        const rationale = [
                            `keyword-overlap: ${floorFallback.hits.join(", ") || "none"}`,
                            `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
                            `dominant-domain: ${signal.dominantDomain}`,
                            sourceAnchor ? `source-anchor: ${sourceAnchor.primaryFile} (score=${sourceAnchor.score})` : "source-anchor: none",
                            "fallback: non-generic-floor-candidate",
                            targetCount > 0 ? "target-collision: allowed-duplicate-target-mapping" : "target-collision: none",
                            `reference-file: ${floorFallback.profile.file}`,
                            `match-v2-score: ${roundMetric(floorFallback.score)}`,
                        ];
                        filePlans.push({
                            sourceFile: relPath,
                            proposedModulePath: targetProjectPath,
                            confidence,
                            rationale,
                            referenceSource: floorFallback.profile.source,
                        });
                        filePlanCountByTargetPath.set(targetProjectPath, targetCount + 1);
                        mappedFilePlan = true;
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
                                    source: floorFallback.profile.source,
                                    symbol: proposedName,
                                    file: floorFallback.profile.file,
                                    kind: "module-file",
                                    score: floorFallback.profile.maxScore,
                                },
                                rationale,
                            });
                        }
                    }
                }
            }
        }
        const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
        if (!source)
            continue;
        const symbolCandidates = collectObfuscatedSymbolsFromSource({ relPath, source });
        obfuscatedSymbolCandidates += symbolCandidates.length;
        for (const candidate of symbolCandidates) {
            const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
            if (perFileCount >= 16)
                break;
            const referencePool = symbolsByKind[candidate.kind];
            if (referencePool.length === 0)
                continue;
            let bestScore = 0;
            let bestHits = [];
            let bestReference;
            for (const reference of referencePool) {
                const scored = scoreReferenceSymbolMatch({ sourceFile: relPath, candidate, reference, fileSignals: signal, anchor: sourceAnchor });
                if (scored.score <= bestScore)
                    continue;
                bestScore = scored.score;
                bestHits = scored.hits;
                bestReference = reference;
            }
            if (!bestReference)
                continue;
            const anchorBoost = getAnchorBoost(sourceAnchor, bestReference.file);
            const hasAnchor = anchorBoost >= 1;
            const anchorFileLabel = sourceAnchor ? sourceAnchor.primaryFile : "none";
            const isGenericReference = isGenericReferenceFilePath(bestReference.file);
            const minScore = isGenericReference ? (hasAnchor ? 6.4 : 6.9) : hasAnchor ? 4.9 : 5.1;
            const minHits = hasAnchor ? 1 : 2;
            const minSignalStrength = hasAnchor ? 8 : 10;
            if (bestScore < minScore || (bestHits.length < minHits && getTotalSignalStrength(signal) < minSignalStrength))
                continue;
            const referenceKey = `${bestReference.source}|${bestReference.name}|${bestReference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            const referenceMatchLimit = isGenericReference ? 1 : 2;
            if (matchedCount >= referenceMatchLimit)
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(bestReference.file) ?? 0;
            if (targetFileMatchCount >= 4 && !hasAnchor)
                continue;
            const sourceTargetKey = `${candidate.sourceFile}|${bestReference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            const sourceTargetLimit = hasAnchor ? 2 : 2;
            if (sourceTargetCount >= sourceTargetLimit)
                continue;
            const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${bestReference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const confidence = Math.min(0.95, roundMetric(0.22 + bestScore / 13.2));
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: bestReference.file,
                signal,
                hits: bestHits,
            });
            const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${bestReference.name}|${bestReference.file}`;
            if (seenEntry.has(id))
                continue;
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
                    `ownership: boundaryScore=${roundMetric(signal.boundaryOwnership)}, uiLikelihood=${roundMetric(signal.uiLikelihood)}`,
                    `dominant-domain: ${signal.dominantDomain}`,
                    hasAnchor ? `source-anchor: ${anchorFileLabel}` : "source-anchor: none",
                    `source-line: ${candidate.line}`,
                    `match-v2-score: ${roundMetric(bestScore)}`,
                ],
            });
        }
    }
    const targetMappedSymbols = 11;
    if (entries.filter((entry) => entry.kind !== "file").length < targetMappedSymbols) {
        const mappedSourceFiles = new Set(filePlans.map((row) => row.sourceFile));
        for (const entry of entries) {
            if (entry.kind === "file")
                continue;
            const separatorIndex = entry.sourceFile.indexOf(":");
            const entrySourceFile = separatorIndex > 0 ? entry.sourceFile.slice(0, separatorIndex) : entry.sourceFile;
            if (entrySourceFile.length > 0)
                mappedSourceFiles.add(entrySourceFile);
        }
        const symbolRecoveryRows = [];
        for (const file of input.jsFiles) {
            const relPath = file.relPath;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const signal = fileSignals.get(relPath);
            if (!signal)
                continue;
            const isMappedSourceFile = mappedSourceFiles.has(relPath);
            if (!isMappedSourceFile) {
                const signalStrength = getTotalSignalStrength(signal);
                const hasStrongOwnership = signal.boundaryOwnership >= 22 || signal.uiLikelihood >= 0.7;
                if (signalStrength < 16 && !hasStrongOwnership)
                    continue;
            }
            if (signal.boundaryOwnership < 8 && signal.uiLikelihood < 0.25)
                continue;
            const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
            if (!source)
                continue;
            const sourceAnchor = sourceReferenceAnchors.get(relPath);
            if (!isMappedSourceFile && !sourceAnchor)
                continue;
            const symbolCandidates = collectObfuscatedSymbolsFromSource({ relPath, source });
            for (const candidate of symbolCandidates) {
                const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|`;
                const hasAnyTarget = Array.from(symbolTargetByFile).some((key) => key.startsWith(fileTargetKey));
                if (hasAnyTarget && signal.boundaryOwnership < 2 && signal.uiLikelihood < 0.1)
                    continue;
                const referencePool = symbolsByKind[candidate.kind];
                let best;
                for (const reference of referencePool) {
                    if (isGenericReferenceFilePath(reference.file))
                        continue;
                    const scored = scoreReferenceSymbolMatch({
                        sourceFile: relPath,
                        candidate,
                        reference,
                        fileSignals: signal,
                        anchor: sourceAnchor,
                    });
                    if (!best || scored.score > best.score) {
                        best = { reference, score: scored.score, hits: scored.hits };
                    }
                }
                if (!best)
                    continue;
                const minScore = isMappedSourceFile ? 3.8 : 4.9;
                if (best.score < minScore)
                    continue;
                if (best.hits.length < 2 && getTotalSignalStrength(signal) < 10)
                    continue;
                if (!isMappedSourceFile && best.hits.length < 2)
                    continue;
                symbolRecoveryRows.push({
                    candidate,
                    reference: best.reference,
                    score: best.score,
                    hits: best.hits,
                    signal,
                    sourceAnchor,
                    isMappedSourceFile,
                });
            }
        }
        symbolRecoveryRows.sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
            if (a.candidate.sourceFile !== b.candidate.sourceFile) {
                return a.candidate.sourceFile.localeCompare(b.candidate.sourceFile);
            }
            return a.candidate.name.localeCompare(b.candidate.name);
        });
        for (const row of symbolRecoveryRows) {
            if (entries.filter((entry) => entry.kind !== "file").length >= targetMappedSymbols)
                break;
            const candidate = row.candidate;
            const reference = row.reference;
            const referenceKey = `${reference.source}|${reference.name}|${reference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            if (matchedCount >= 3)
                continue;
            const sourceTargetKey = `${candidate.sourceFile}|${reference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            if (sourceTargetCount >= 3)
                continue;
            const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${reference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(reference.file) ?? 0;
            if (targetFileMatchCount >= 6)
                continue;
            const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
            if (perFileCount >= 20)
                continue;
            if (!row.isMappedSourceFile && perFileCount >= 1)
                continue;
            const confidence = Math.min(0.91, roundMetric(0.2 + row.score / 13.8));
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: reference.file,
                signal: row.signal,
                hits: row.hits,
            });
            const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${reference.name}|${reference.file}|recovery`;
            if (seenEntry.has(id))
                continue;
            seenEntry.add(id);
            symbolTargetByFile.add(fileTargetKey);
            symbolMatchCountByReference.set(referenceKey, matchedCount + 1);
            symbolMatchCountByFile.set(candidate.sourceFile, perFileCount + 1);
            symbolMatchCountByTargetFile.set(reference.file, targetFileMatchCount + 1);
            symbolMatchCountBySourceTarget.set(sourceTargetKey, sourceTargetCount + 1);
            entries.push({
                id,
                kind: candidate.kind,
                obfuscated: candidate.name,
                deobfuscated: reference.name,
                sourceFile: `${candidate.sourceFile}:${candidate.line}`,
                targetProjectPath,
                confidence,
                reference: {
                    source: reference.source,
                    symbol: reference.name,
                    file: reference.file,
                    kind: reference.kind,
                    score: reference.score,
                },
                rationale: [
                    `keyword-overlap: ${row.hits.join(", ") || "none"}`,
                    `signals: ast=${row.signal.ast}, ipcRpc=${row.signal.ipcRpc}, state=${row.signal.state}, boundary=${row.signal.boundary}, flow=${row.signal.flow}`,
                    `ownership: boundaryScore=${roundMetric(row.signal.boundaryOwnership)}, uiLikelihood=${roundMetric(row.signal.uiLikelihood)}`,
                    `dominant-domain: ${row.signal.dominantDomain}`,
                    row.sourceAnchor ? `source-anchor: ${row.sourceAnchor.primaryFile} (score=${row.sourceAnchor.score})` : "source-anchor: none",
                    "fallback: ownership-symbol-recovery-non-generic",
                    `source-line: ${candidate.line}`,
                    `match-v2-score: ${roundMetric(row.score)}`,
                ],
            });
        }
    }
    const minMappedFiles = regression_config_1.MATCH_V2_THRESHOLDS.minMappedFiles;
    const maxMappedFiles = regression_config_1.MATCH_V2_THRESHOLDS.maxMappedFiles;
    if (filePlans.length < minMappedFiles) {
        const mappedSourceFiles = new Set(filePlans.map((row) => row.sourceFile));
        const unresolvedRows = [];
        for (const file of input.jsFiles) {
            const relPath = file.relPath;
            if (mappedSourceFiles.has(relPath))
                continue;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const signal = fileSignals.get(relPath);
            if (!signal)
                continue;
            if (!isLikelyCoreAppFile(relPath) && signal.contextKeywords.size < 4)
                continue;
            const sourceAnchor = sourceReferenceAnchors.get(relPath);
            const signalStrength = getTotalSignalStrength(signal);
            if (signalStrength < 7)
                continue;
            let best;
            for (const profile of referenceFileProfiles) {
                if (isGenericReferenceFilePath(profile.file))
                    continue;
                const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                if (!best || scored.score > best.score) {
                    best = { profile, score: scored.score, hits: scored.hits };
                }
            }
            if (!best)
                continue;
            if (best.score < 1.4)
                continue;
            if (best.hits.length < 1 && signalStrength < 11)
                continue;
            unresolvedRows.push({
                sourceFile: relPath,
                profile: best.profile,
                score: best.score,
                hits: best.hits,
                signal,
                sourceAnchor,
            });
        }
        unresolvedRows.sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
            const signalA = getTotalSignalStrength(a.signal);
            const signalB = getTotalSignalStrength(b.signal);
            if (signalA !== signalB)
                return signalB - signalA;
            return a.sourceFile.localeCompare(b.sourceFile);
        });
        for (const row of unresolvedRows) {
            if (filePlans.length >= maxMappedFiles)
                break;
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: row.profile.file,
                signal: row.signal,
                hits: row.hits,
            });
            const targetCount = filePlanCountByTargetPath.get(targetProjectPath) ?? 0;
            if (targetCount >= 2)
                continue;
            const confidence = Math.min(0.74, roundMetric(0.28 + row.score / 18));
            const proposedName = path.basename(row.profile.file).replace(/\.[^.]+$/, "");
            const rationale = [
                `keyword-overlap: ${row.hits.join(", ") || "none"}`,
                `signals: ast=${row.signal.ast}, ipcRpc=${row.signal.ipcRpc}, state=${row.signal.state}, boundary=${row.signal.boundary}, flow=${row.signal.flow}`,
                `dominant-domain: ${row.signal.dominantDomain}`,
                row.sourceAnchor
                    ? `source-anchor: ${row.sourceAnchor.primaryFile} (score=${row.sourceAnchor.score})`
                    : "source-anchor: none",
                "fallback: regression-fill-non-generic",
                targetCount > 0 ? "target-collision: allowed-duplicate-target-mapping" : "target-collision: none",
                `reference-file: ${row.profile.file}`,
                `match-v2-score: ${roundMetric(row.score)}`,
            ];
            filePlans.push({
                sourceFile: row.sourceFile,
                proposedModulePath: targetProjectPath,
                confidence,
                rationale,
                referenceSource: row.profile.source,
            });
            filePlanCountByTargetPath.set(targetProjectPath, targetCount + 1);
            const id = `file|${row.sourceFile}|${targetProjectPath}`;
            if (!seenEntry.has(id)) {
                seenEntry.add(id);
                entries.push({
                    id,
                    kind: "file",
                    obfuscated: row.sourceFile,
                    deobfuscated: proposedName,
                    sourceFile: row.sourceFile,
                    targetProjectPath,
                    confidence,
                    reference: {
                        source: row.profile.source,
                        symbol: proposedName,
                        file: row.profile.file,
                        kind: "module-file",
                        score: row.profile.maxScore,
                    },
                    rationale,
                });
            }
        }
    }
    entries.sort((a, b) => {
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        if (a.sourceFile !== b.sourceFile)
            return a.sourceFile.localeCompare(b.sourceFile);
        return a.obfuscated.localeCompare(b.obfuscated);
    });
    filePlans.sort((a, b) => {
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        return a.sourceFile.localeCompare(b.sourceFile);
    });
    const maxEntries = Math.max(100, Math.min(520, input.top * 3));
    const maxFilePlans = Math.max(30, Math.min(220, input.top + 20));
    const trimmedEntries = entries.slice(0, maxEntries);
    const trimmedFilePlans = filePlans.slice(0, maxFilePlans);
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: "match-v2 multi-signal mapping: reference-guided file+symbol deobfuscation using AST, IPC/RPC, state keys, component boundaries, route/event flow, and layer/path-map alignment.",
        calibration: {
            profileId: regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id,
            fixedRegressionRuns: [...regression_config_1.MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns],
        },
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
