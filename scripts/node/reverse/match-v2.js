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
const MATCH_V2_RUNTIME = (0, regression_config_1.resolveMatchV2RuntimeConfig)(process.env.REVERSE_MATCH_V2_VARIANT);
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
    return true;
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
function isGenericRenameToken(token) {
    return /^(types?|utils?|index|mod|common|shared|state|constants?|helpers?|src|main|renderer|services|tauri|adapter|lib|hooks?|components?|features?|unknown)$/i.test(token);
}
function pickFallbackRenameToken(input) {
    const candidates = [];
    const referenceStem = path.posix.basename(input.referenceFile, path.posix.extname(input.referenceFile));
    const referenceSegments = toPosixPath(input.referenceFile).replace(/\.[^.]+$/, "").split("/");
    for (let index = referenceSegments.length - 1; index >= 0; index -= 1) {
        for (const token of extractNameTokens(referenceSegments[index] ?? "")) {
            if (token.length < 3 || isGenericRenameToken(token))
                continue;
            candidates.push(token);
        }
    }
    for (const token of extractNameTokens(referenceStem)) {
        if (token.length < 3 || isGenericRenameToken(token))
            continue;
        candidates.push(token);
    }
    const sourceStem = path.posix.basename(toPosixPath(input.sourceFile), path.posix.extname(toPosixPath(input.sourceFile)));
    for (const token of extractNameTokens(sourceStem)) {
        if (token.length < 3 || isGenericRenameToken(token))
            continue;
        candidates.push(token);
    }
    if (input.signal.dominantDomain && input.signal.dominantDomain !== "unknown") {
        for (const token of extractNameTokens(input.signal.dominantDomain)) {
            if (token.length < 3 || isGenericRenameToken(token))
                continue;
            candidates.push(token);
        }
    }
    const selected = dedupeKeywords(candidates, 16).find((token) => token.length >= 3 && !isGenericRenameToken(token));
    if (selected)
        return selected;
    const domainToken = input.signal.dominantDomain.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    if (domainToken.length >= 3 && !isGenericRenameToken(domainToken))
        return domainToken;
    return "domain-module";
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
    ], 24).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
    const selectedToken = preferredTokens[0] ?? pickFallbackRenameToken(input);
    const safeToken = selectedToken.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
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
function isBroadCandidateFunctionName(name) {
    if (name.length < 2)
        return false;
    if (name.length > 80)
        return false;
    if (/^\d+$/.test(name))
        return false;
    if (/^(constructor|prototype|default|module|exports|render|then|catch|finally)$/i.test(name))
        return false;
    if (/^__[A-Za-z0-9_]+__$/.test(name))
        return false;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
function isBroadCandidateClassName(name) {
    if (name.length < 2)
        return false;
    if (name.length > 80)
        return false;
    if (/^\d+$/.test(name))
        return false;
    if (/^(default|module|exports)$/i.test(name))
        return false;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
function isLikelyObfuscatedVariableName(name) {
    if (name.length < 1)
        return false;
    if (name.length <= 2)
        return true;
    if (/^[$_]?[a-z][0-9]{1,3}$/.test(name))
        return true;
    if (/^[$_]?[a-z]{1,3}$/.test(name) && !/^(ctx|key|id|url|api|env|tmp)$/.test(name.toLowerCase()))
        return true;
    if (/^[a-z][a-z0-9]{0,3}$/.test(name) && !/[aeiou]/i.test(name))
        return true;
    return false;
}
function isBroadCandidateVariableName(name) {
    if (name.length < 1)
        return false;
    if (name.length > 80)
        return false;
    if (/^\d+$/.test(name))
        return false;
    if (/^(arguments|undefined|window|document|globalThis|module|exports|require|console|process)$/i.test(name))
        return false;
    if (/^__[A-Za-z0-9_]+__$/.test(name))
        return false;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
function normalizeSourceForPrint(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
        .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}
function collectObfuscatedSymbolsFromSource(input) {
    const candidates = [];
    const mode = input.mode ?? "strict";
    const seen = new Set();
    let sourceFile;
    try {
        sourceFile = ts.createSourceFile(input.relPath, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    }
    catch {
        return candidates;
    }
    const pushCandidate = (kind, name, node) => {
        const isCandidate = mode === "strict"
            ? kind === "class"
                ? isLikelyObfuscatedClassName(name)
                : isLikelyObfuscatedFunctionName(name)
            : kind === "class"
                ? isBroadCandidateClassName(name)
                : isBroadCandidateFunctionName(name);
        if (!isCandidate)
            return;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const line = position.line + 1;
        const key = `${kind}|${name}|${line}`;
        if (seen.has(key))
            return;
        seen.add(key);
        candidates.push({ kind, name, sourceFile: input.relPath, line, tokens: extractNameTokens(name) });
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
            if (ts.isArrowFunction(node.initializer) ||
                ts.isFunctionExpression(node.initializer) ||
                (mode === "broad" && ts.isClassExpression(node.initializer))) {
                const kind = ts.isClassExpression(node.initializer) ? "class" : "function";
                pushCandidate(kind, node.name.text, node.name);
            }
            else if (mode === "broad" &&
                !ts.isStringLiteral(node.initializer) &&
                !ts.isNumericLiteral(node.initializer) &&
                node.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
                node.initializer.kind !== ts.SyntaxKind.FalseKeyword &&
                node.initializer.kind !== ts.SyntaxKind.NullKeyword) {
                pushCandidate("function", node.name.text, node.name);
            }
        }
        else if (ts.isMethodDeclaration(node) && node.name) {
            const methodName = getPropertyNameText(node.name);
            if (methodName.length > 0)
                pushCandidate("function", methodName, node.name);
        }
        else if (mode === "broad" && ts.isPropertyAssignment(node) && node.name) {
            if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
                const propertyName = getPropertyNameText(node.name);
                if (propertyName.length > 0)
                    pushCandidate("function", propertyName, node.name);
            }
        }
        else if (mode === "broad" && ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)) {
            if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                if (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right)) {
                    const propertyName = node.left.name.text;
                    if (propertyName.length > 0)
                        pushCandidate("function", propertyName, node.left.name);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (mode === "broad") {
        const pushRegexCandidates = (regex, kind) => {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(input.source)) !== null) {
                const name = match[1] ?? "";
                if (name.length === 0)
                    continue;
                const isCandidate = kind === "class" ? isBroadCandidateClassName(name) : isBroadCandidateFunctionName(name);
                if (!isCandidate)
                    continue;
                const position = sourceFile.getLineAndCharacterOfPosition(match.index);
                const line = position.line + 1;
                const key = `${kind}|${name}|${line}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                candidates.push({
                    kind,
                    name,
                    sourceFile: input.relPath,
                    line,
                    tokens: extractNameTokens(name),
                });
            }
        };
        pushRegexCandidates(/\bnew\s+([A-Za-z_$][A-Za-z0-9_$]{1,80})\s*\(/g, "class");
        pushRegexCandidates(/\b([A-Za-z_$][A-Za-z0-9_$]{1,80})\s*\(/g, "function");
        pushRegexCandidates(/\b([A-Za-z_$][A-Za-z0-9_$]{1,80})\s*=\s*/g, "function");
    }
    return candidates;
}
function collectObfuscatedVariablesFromSource(input) {
    const out = [];
    const mode = input.mode ?? "strict";
    const seen = new Set();
    let sourceFile;
    try {
        sourceFile = ts.createSourceFile(input.relPath, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    }
    catch {
        return out;
    }
    const pushCandidate = (name, node) => {
        const isCandidate = mode === "strict" ? isLikelyObfuscatedVariableName(name) : isBroadCandidateVariableName(name);
        if (!isCandidate)
            return;
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const line = position.line + 1;
        const key = `${name}|${line}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({
            name,
            sourceFile: input.relPath,
            line,
            tokens: extractNameTokens(name),
        });
    };
    const visit = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            if (!node.initializer) {
                if (mode === "broad")
                    pushCandidate(name, node.name);
            }
            else {
                const skipLiteral = ts.isStringLiteral(node.initializer) ||
                    ts.isNumericLiteral(node.initializer) ||
                    node.initializer.kind === ts.SyntaxKind.TrueKeyword ||
                    node.initializer.kind === ts.SyntaxKind.FalseKeyword ||
                    node.initializer.kind === ts.SyntaxKind.NullKeyword;
                if (!skipLiteral || mode === "broad")
                    pushCandidate(name, node.name);
            }
        }
        else if (mode === "broad" && ts.isParameter(node) && ts.isIdentifier(node.name)) {
            pushCandidate(node.name.text, node.name);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (mode === "broad") {
        const pushRegexCandidates = (regex) => {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(input.source)) !== null) {
                const name = match[1] ?? "";
                if (!isBroadCandidateVariableName(name))
                    continue;
                const position = sourceFile.getLineAndCharacterOfPosition(match.index);
                const line = position.line + 1;
                const key = `${name}|${line}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                out.push({
                    name,
                    sourceFile: input.relPath,
                    line,
                    tokens: extractNameTokens(name),
                });
            }
        };
        pushRegexCandidates(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{0,80})\s*(?:=|;)/g);
        pushRegexCandidates(/\b([A-Za-z_$][A-Za-z0-9_$]{0,80})\s*:\s*[^=,\n\r]+\s*(?:=|,|\))/g);
    }
    return out;
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
    const signalWeights = MATCH_V2_RUNTIME.scoreWeights.signal;
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
    const fileWeights = MATCH_V2_RUNTIME.scoreWeights.file;
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
    const symbolWeights = MATCH_V2_RUNTIME.scoreWeights.symbol;
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
function createEmptyFileSignalProfile() {
    return {
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
}
function getEntrySourceFile(value) {
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0)
        return value;
    return value.slice(0, separatorIndex);
}
function toPascalCaseIdentifier(value) {
    const tokens = extractNameTokens(value);
    if (tokens.length === 0)
        return "";
    return tokens
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
        .join("")
        .replace(/[^A-Za-z0-9_]/g, "");
}
function toCamelCaseIdentifier(value) {
    const pascal = toPascalCaseIdentifier(value);
    if (pascal.length === 0)
        return "";
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
function buildVariableName(input) {
    const referencePath = toPosixPath(input.referenceFile).replace(/\.[^.]+$/, "");
    const referenceTokens = referencePath
        .split("/")
        .flatMap((part) => extractNameTokens(part))
        .filter((token) => !isGenericRenameToken(token));
    const signalTokens = Array.from(input.signal.contextKeywords).filter((token) => !isGenericRenameToken(token));
    const tokens = dedupeKeywords([
        ...input.referenceHits,
        ...input.candidate.tokens,
        ...referenceTokens,
        ...signalTokens.slice(0, 12),
        input.signal.dominantDomain,
    ], 18).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
    const base = toCamelCaseIdentifier(tokens.slice(0, 3).join(" "));
    if (base.length > 0)
        return base;
    const layer = inferReferenceLayer(input.referenceFile);
    if (layer !== "unknown") {
        const fallback = toCamelCaseIdentifier(`${layer} value`);
        if (fallback.length > 0)
            return fallback;
    }
    return "domainValue";
}
function buildAggressiveSymbolName(input) {
    const referencePath = toPosixPath(input.referenceFile).replace(/\.[^.]+$/, "");
    const referenceTokens = referencePath
        .split("/")
        .flatMap((part) => extractNameTokens(part))
        .filter((token) => token.length >= 3 && !isGenericRenameToken(token));
    const signalTokens = Array.from(input.signal.contextKeywords).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
    const tokens = dedupeKeywords([
        ...input.candidate.tokens,
        ...referenceTokens,
        ...signalTokens.slice(0, 14),
        input.signal.dominantDomain,
    ], 20).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
    const kindSuffix = input.candidate.kind === "class" ? "class" : "handler";
    if (input.candidate.kind === "class") {
        const base = toPascalCaseIdentifier(tokens.slice(0, 3).join(" "));
        if (base.length >= 3)
            return base;
    }
    else {
        const base = toCamelCaseIdentifier(tokens.slice(0, 3).join(" "));
        if (base.length >= 3)
            return base;
    }
    const referenceStem = path.posix.basename(referencePath);
    if (input.candidate.kind === "class") {
        const fallback = toPascalCaseIdentifier(`${referenceStem} ${kindSuffix}`);
        if (fallback.length >= 3 && !isGenericRenameToken(fallback.toLowerCase()))
            return fallback;
    }
    else {
        const fallback = toCamelCaseIdentifier(`${referenceStem} ${kindSuffix}`);
        if (fallback.length >= 3 && !isGenericRenameToken(fallback.toLowerCase()))
            return fallback;
    }
    const sourceStem = path.posix.basename(toPosixPath(input.candidate.sourceFile), path.posix.extname(input.candidate.sourceFile));
    if (input.candidate.kind === "class") {
        const sourceFallback = toPascalCaseIdentifier(`${sourceStem} class`);
        if (sourceFallback.length >= 3)
            return sourceFallback;
    }
    else {
        const sourceFallback = toCamelCaseIdentifier(`${sourceStem} fn`);
        if (sourceFallback.length >= 3)
            return sourceFallback;
    }
    const layer = inferReferenceLayer(input.referenceFile);
    if (input.candidate.kind === "class") {
        const layerFallback = toPascalCaseIdentifier(`${layer === "unknown" ? "domain" : layer} class`);
        if (layerFallback.length >= 3)
            return layerFallback;
        return "DomainClass";
    }
    const layerFallback = toCamelCaseIdentifier(`${layer === "unknown" ? "domain" : layer} handler`);
    if (layerFallback.length >= 3)
        return layerFallback;
    return "domainHandler";
}
function extractRefinementTokens(entry) {
    const referencePath = toPosixPath(entry.reference.file).replace(/\.[^.]+$/, "");
    const sourcePath = toPosixPath(getEntrySourceFile(entry.sourceFile)).replace(/\.[^.]+$/, "");
    const referenceParts = referencePath.split("/");
    const sourceParts = sourcePath.split("/");
    const tokens = [];
    for (let index = referenceParts.length - 1; index >= 0; index -= 1) {
        const part = referenceParts[index] ?? "";
        for (const token of extractNameTokens(part)) {
            if (token.length < 3)
                continue;
            if (isGenericRenameToken(token))
                continue;
            tokens.push(token);
        }
        if (tokens.length >= 6)
            break;
    }
    for (let index = sourceParts.length - 1; index >= 0; index -= 1) {
        const part = sourceParts[index] ?? "";
        for (const token of extractNameTokens(part)) {
            if (token.length < 3)
                continue;
            if (isGenericRenameToken(token))
                continue;
            tokens.push(token);
        }
        if (tokens.length >= 9)
            break;
    }
    const layer = inferReferenceLayer(entry.reference.file);
    if (layer !== "unknown")
        tokens.push(layer);
    return dedupeKeywords(tokens, 12);
}
function buildRefinedSymbolName(input) {
    const baseIdentifier = input.kind === "class" ? toPascalCaseIdentifier(input.baseName) : toCamelCaseIdentifier(input.baseName);
    const fallbackBase = input.kind === "class" ? "DomainSymbol" : "domainValue";
    const seed = baseIdentifier.length > 0 ? baseIdentifier : fallbackBase;
    for (const token of input.tokens) {
        const suffix = input.kind === "class" ? toPascalCaseIdentifier(token) : toPascalCaseIdentifier(token);
        if (suffix.length === 0)
            continue;
        const next = `${seed}${suffix}`;
        if (next.length >= 3)
            return next;
    }
    const ordinal = input.index + 1;
    if (input.kind === "class")
        return `${seed}V${ordinal}`;
    return `${seed}V${ordinal}`;
}
function refineSymbolNames(entries) {
    const symbolEntries = entries.filter((entry) => entry.kind !== "file");
    if (symbolEntries.length === 0)
        return;
    const usedNames = new Set(symbolEntries.map((entry) => entry.deobfuscated));
    const byName = new Map();
    for (const entry of symbolEntries) {
        const bucket = byName.get(entry.deobfuscated) ?? [];
        bucket.push(entry);
        byName.set(entry.deobfuscated, bucket);
    }
    const genericNamePattern = /^(run|main|start|stop|kind|usage|header|app|state|data|capture|reset|open|close)$/i;
    for (const bucket of byName.values()) {
        const requiresRefine = bucket.length > 1 || genericNamePattern.test(bucket[0]?.deobfuscated ?? "");
        if (!requiresRefine)
            continue;
        bucket.sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            if (a.reference.score !== b.reference.score)
                return b.reference.score - a.reference.score;
            return a.id.localeCompare(b.id);
        });
        const keepCanonical = bucket.length > 1;
        const startIndex = keepCanonical ? 1 : 0;
        for (let index = startIndex; index < bucket.length; index += 1) {
            const entry = bucket[index];
            if (!entry)
                continue;
            if (entry.kind === "file")
                continue;
            const tokens = extractRefinementTokens(entry);
            const candidateBaseName = buildRefinedSymbolName({
                baseName: entry.deobfuscated,
                kind: entry.kind,
                tokens,
                index,
            });
            let refinedName = candidateBaseName;
            let dedupeIndex = 1;
            while (usedNames.has(refinedName) && dedupeIndex < 500) {
                const layerToken = inferReferenceLayer(entry.reference.file);
                const layerSuffix = layerToken === "unknown" ? "domain" : layerToken;
                const suffix = entry.kind === "class" ? toPascalCaseIdentifier(layerSuffix) : toPascalCaseIdentifier(layerSuffix);
                refinedName = `${candidateBaseName}${suffix}${dedupeIndex + 1}`;
                dedupeIndex += 1;
            }
            if (refinedName !== entry.deobfuscated) {
                usedNames.delete(entry.deobfuscated);
                entry.deobfuscated = refinedName;
                usedNames.add(refinedName);
                entry.rationale = [...entry.rationale, "name-refine: disambiguated-by-reference-layer-context"];
            }
        }
    }
}
function scoreSymbolEntryQuality(entry) {
    let score = entry.confidence * 100 + entry.reference.score;
    const rationaleText = entry.rationale.join(" | ").toLowerCase();
    if (rationaleText.includes("fallback: mass-fill-non-generic"))
        score -= 32;
    if (rationaleText.includes("fallback: high-recall-non-generic-fill"))
        score -= 16;
    if (rationaleText.includes("fallback: source-anchor-symbol-expansion"))
        score -= 8;
    if (rationaleText.includes("fallback: ownership-symbol-recovery-non-generic"))
        score -= 4;
    if (rationaleText.includes("fallback: primary-best"))
        score += 6;
    if (rationaleText.includes("source-anchor:") && !rationaleText.includes("source-anchor: none"))
        score += 2;
    return score;
}
function collapseBestSymbolEntries(entries) {
    const files = entries.filter((entry) => entry.kind === "file");
    const bestByKey = new Map();
    for (const entry of entries) {
        if (entry.kind === "file")
            continue;
        const key = `${entry.kind}|${getEntrySourceFile(entry.sourceFile)}|${entry.obfuscated}`;
        const current = bestByKey.get(key);
        if (!current) {
            bestByKey.set(key, entry);
            continue;
        }
        const nextScore = scoreSymbolEntryQuality(entry);
        const currentScore = scoreSymbolEntryQuality(current);
        if (nextScore > currentScore + 0.001) {
            bestByKey.set(key, entry);
            continue;
        }
        if (Math.abs(nextScore - currentScore) <= 0.001 && entry.reference.score > current.reference.score) {
            bestByKey.set(key, entry);
        }
    }
    return [...files, ...Array.from(bestByKey.values())];
}
function countMappedSymbolEntries(entries) {
    const seen = new Set();
    for (const entry of entries) {
        if (entry.kind !== "class" && entry.kind !== "function")
            continue;
        const sourceFile = getEntrySourceFile(entry.sourceFile);
        seen.add(`${entry.kind}|${sourceFile}|${entry.obfuscated}`);
    }
    return seen.size;
}
function getEntrySourceLine(value) {
    const separatorIndex = value.lastIndexOf(":");
    if (separatorIndex <= 0)
        return 0;
    const parsed = Number(value.slice(separatorIndex + 1));
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 0;
    return Math.floor(parsed);
}
function isLowQualitySymbolEntry(entry) {
    if (entry.kind !== "class" && entry.kind !== "function")
        return false;
    const rationaleText = entry.rationale.join(" | ").toLowerCase();
    if (rationaleText.includes("fallback: aggressive-symbol-coverage"))
        return true;
    if (rationaleText.includes("fallback: final-symbol-completion"))
        return true;
    if (rationaleText.includes("fallback: mass-fill-non-generic"))
        return true;
    if (rationaleText.includes("fallback: high-recall-non-generic-fill"))
        return true;
    if (entry.confidence < 0.66)
        return true;
    if (/^(domain(class|handler|symbol)|[a-z]+handlerv?\d*)$/i.test(entry.deobfuscated))
        return true;
    return false;
}
function applySymbolQualityPass(input) {
    const nonGenericReferencePools = {
        class: input.symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file)),
        function: input.symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file)),
    };
    const candidateBuckets = new Map();
    for (const [sourceFile, candidates] of input.strictSymbolCandidatesByFile) {
        for (const candidate of candidates) {
            const key = `${candidate.kind}|${sourceFile}|${candidate.name}`;
            const bucket = candidateBuckets.get(key) ?? [];
            bucket.push(candidate);
            candidateBuckets.set(key, bucket);
        }
    }
    const nonGenericFileProfiles = input.referenceFileProfiles.filter((profile) => !isGenericReferenceFilePath(profile.file));
    const fileScoreCache = new Map();
    for (const sourceFile of input.strictSymbolCandidatesByFile.keys()) {
        const signal = input.fileSignals.get(sourceFile);
        if (!signal)
            continue;
        const perFileScores = new Map();
        for (const profile of nonGenericFileProfiles) {
            const scored = scoreReferenceFileProfile({
                sourceFile,
                profile,
                fileSignals: signal,
            });
            perFileScores.set(profile.file, scored.score);
        }
        fileScoreCache.set(sourceFile, perFileScores);
    }
    const usedNamesByKind = new Set();
    for (const entry of input.entries) {
        if (entry.kind !== "class" && entry.kind !== "function")
            continue;
        usedNamesByKind.add(`${entry.kind}|${entry.deobfuscated.toLowerCase()}`);
    }
    let reviewed = 0;
    let improved = 0;
    for (const entry of input.entries) {
        if (!isLowQualitySymbolEntry(entry))
            continue;
        reviewed += 1;
        const symbolKind = entry.kind === "class" ? "class" : "function";
        const sourceFile = getEntrySourceFile(entry.sourceFile);
        const candidateKey = `${symbolKind}|${sourceFile}|${entry.obfuscated}`;
        const candidateBucket = candidateBuckets.get(candidateKey) ?? [];
        if (candidateBucket.length === 0)
            continue;
        const lineHint = getEntrySourceLine(entry.sourceFile);
        let selectedCandidate = candidateBucket[0];
        if (lineHint > 0 && candidateBucket.length > 1) {
            let minDistance = Number.POSITIVE_INFINITY;
            for (const candidate of candidateBucket) {
                const distance = Math.abs(candidate.line - lineHint);
                if (distance < minDistance) {
                    minDistance = distance;
                    selectedCandidate = candidate;
                }
            }
        }
        const signal = input.fileSignals.get(sourceFile) ?? createEmptyFileSignalProfile();
        const sourceAnchor = input.sourceReferenceAnchors.get(sourceFile);
        let best;
        for (const reference of nonGenericReferencePools[symbolKind]) {
            const scored = scoreReferenceSymbolMatch({
                sourceFile,
                candidate: selectedCandidate,
                reference,
                fileSignals: signal,
                anchor: sourceAnchor,
            });
            const fileScore = fileScoreCache.get(sourceFile)?.get(reference.file) ?? 0;
            const finalScore = scored.score + Math.min(1.1, fileScore / 16) + getAnchorBoost(sourceAnchor, reference.file) * 0.3;
            if (!best || finalScore > best.score) {
                best = {
                    reference,
                    score: finalScore,
                    hits: scored.hits,
                };
            }
        }
        if (!best)
            continue;
        const currentEntryScore = scoreSymbolEntryQuality(entry);
        const isAggressiveFallback = entry.rationale.some((item) => item.includes("fallback: aggressive-symbol-coverage") || item.includes("fallback: final-symbol-completion"));
        const minimumAcceptableScore = isAggressiveFallback ? 1.6 : 2.2;
        if (best.score < minimumAcceptableScore)
            continue;
        const projectedScore = Math.min(0.9, roundMetric(0.24 + best.score / 12.5)) * 100 + best.reference.score + (best.hits.length > 0 ? 1.5 : 0);
        const lowConfidenceEntry = entry.confidence < 0.66;
        if (!isAggressiveFallback && !lowConfidenceEntry && projectedScore <= currentEntryScore + 2.4)
            continue;
        if (!isAggressiveFallback && lowConfidenceEntry && projectedScore <= currentEntryScore + 0.8)
            continue;
        const usedNameKey = `${symbolKind}|${entry.deobfuscated.toLowerCase()}`;
        usedNamesByKind.delete(usedNameKey);
        const baseName = symbolKind === "class" ? toPascalCaseIdentifier(best.reference.name) : toCamelCaseIdentifier(best.reference.name);
        const fallbackName = buildAggressiveSymbolName({
            candidate: selectedCandidate,
            signal,
            referenceFile: best.reference.file,
        });
        const preferredName = baseName.length >= 3 ? baseName : fallbackName;
        let nextName = preferredName;
        let dedupeIndex = 2;
        while (usedNamesByKind.has(`${symbolKind}|${nextName.toLowerCase()}`) && dedupeIndex < 5000) {
            nextName = `${preferredName}V${dedupeIndex}`;
            dedupeIndex += 1;
        }
        usedNamesByKind.add(`${symbolKind}|${nextName.toLowerCase()}`);
        entry.deobfuscated = nextName;
        entry.reference = {
            source: best.reference.source,
            symbol: best.reference.name,
            file: best.reference.file,
            kind: best.reference.kind,
            score: best.reference.score,
        };
        entry.targetProjectPath = buildSignalAwareTargetPath({
            referenceFile: best.reference.file,
            sourceFile,
            signal,
            hits: best.hits,
        });
        const rerankedConfidence = Math.min(0.93, roundMetric(0.28 + best.score / 12));
        entry.confidence = Math.max(entry.confidence, rerankedConfidence);
        entry.rationale = [
            ...entry.rationale,
            "quality-pass: reranked-low-quality-symbol-entry",
            `quality-pass-score: ${roundMetric(best.score)}`,
            `quality-pass-overlap: ${best.hits.join(", ") || "none"}`,
        ];
        improved += 1;
    }
    return { reviewed, improved };
}
function toOwnershipLayer(sourceLayer) {
    if (sourceLayer === "main" || sourceLayer === "main-worker" || sourceLayer === "preload")
        return "main";
    if (sourceLayer === "renderer" || sourceLayer === "renderer-worker")
        return "renderer";
    return "unknown";
}
function isLayerOwnershipAllowed(input) {
    const sourceOwnershipLayer = toOwnershipLayer(input.sourceLayer);
    if (sourceOwnershipLayer === "unknown")
        return input.anchorBoost >= 1.9;
    if (input.referenceLayer === "unknown")
        return input.anchorBoost >= 1.1;
    if (sourceOwnershipLayer === "renderer") {
        if (input.referenceLayer === "renderer")
            return true;
        if (input.referenceLayer === "services")
            return input.fileSignals.state >= 3 || input.fileSignals.ipcRpc >= 2;
        if (input.referenceLayer === "tauri" || input.referenceLayer === "main") {
            return input.anchorBoost >= 1.1 || input.fileSignals.ipcRpc >= 8;
        }
        return false;
    }
    if (sourceOwnershipLayer === "main") {
        if (input.referenceLayer === "main" || input.referenceLayer === "tauri")
            return true;
        if (input.referenceLayer === "services")
            return input.fileSignals.state >= 2 || input.fileSignals.ipcRpc >= 2;
        if (input.referenceLayer === "renderer") {
            if (input.fileSignals.uiLikelihood >= 0.9 && input.fileSignals.flow >= 25)
                return true;
            return input.fileSignals.uiLikelihood >= 0.78 && input.anchorBoost >= 1.1;
        }
        return false;
    }
    return false;
}
function getLayerPairKey(sourceLayer, referenceLayer) {
    return `${toOwnershipLayer(sourceLayer)}|${referenceLayer}`;
}
function getLayerPairLimit(sourceLayer, referenceLayer) {
    const sourceOwnershipLayer = toOwnershipLayer(sourceLayer);
    if (sourceOwnershipLayer === "renderer" && referenceLayer === "renderer")
        return 20;
    if (sourceOwnershipLayer === "renderer" && referenceLayer === "services")
        return 16;
    if (sourceOwnershipLayer === "renderer" && (referenceLayer === "main" || referenceLayer === "tauri"))
        return 12;
    if (sourceOwnershipLayer === "main" && (referenceLayer === "main" || referenceLayer === "tauri"))
        return 20;
    if (sourceOwnershipLayer === "main" && referenceLayer === "services")
        return 14;
    if (sourceOwnershipLayer === "main" && referenceLayer === "renderer")
        return 8;
    return 10;
}
function getHighRecallLayerPairLimit(sourceLayer, referenceLayer) {
    return Math.max(18, getLayerPairLimit(sourceLayer, referenceLayer) * 2);
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
    const referenceSymbolsByFile = new Map();
    for (const symbol of referenceSymbolProfile.symbols) {
        if (symbol.symbolKind !== "class" && symbol.symbolKind !== "function")
            continue;
        const row = referenceSymbolsByFile.get(symbol.file) ?? { class: [], function: [] };
        row[symbol.symbolKind].push(symbol);
        referenceSymbolsByFile.set(symbol.file, row);
    }
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
    let obfuscatedVariableCandidates = 0;
    const strictSymbolCandidatesByFile = new Map();
    const uniqueObfuscatedSymbolCandidateKeys = new Set();
    const emptySignalProfile = createEmptyFileSignalProfile();
    const seenEntry = new Set();
    const filePlanCountByTargetPath = new Map();
    const symbolMatchCountByReference = new Map();
    const symbolMatchCountByFile = new Map();
    const symbolMatchCountByTargetFile = new Map();
    const symbolMatchCountBySourceTarget = new Map();
    const symbolOwnershipPairCounts = new Map();
    const symbolTargetByFile = new Set();
    const getMappedSymbolCount = () => countMappedSymbolEntries(entries);
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
                ? MATCH_V2_RUNTIME.thresholds.genericSelectionMinScore
                : sourceAnchor
                    ? 3.4
                    : strongSignal
                        ? 3.7
                        : 4.3;
            const minHits = sourceAnchor || strongSignal || usedNonGenericFallback ? 1 : 2;
            const isGenericBestProfile = selectedProfile ? isGenericReferenceFilePath(selectedProfile.file) : false;
            const nonGenericFallbackMinScore = sourceAnchor
                ? MATCH_V2_RUNTIME.thresholds.nonGenericSelectionMinScoreStrongAnchor
                : strongSignal
                    ? MATCH_V2_RUNTIME.thresholds.nonGenericSelectionMinScoreStrongSignal
                    : MATCH_V2_RUNTIME.thresholds.nonGenericSelectionMinScoreDefault;
            if (selectedProfile &&
                selectedFileScore >= (usedNonGenericFallback ? nonGenericFallbackMinScore : minFileScore) &&
                (selectedFileHits.length >= minHits || signalStrength >= 8) &&
                (!isGenericBestProfile || (selectedFileHits.length >= 4 && signalStrength >= 13))) {
                if (!isGenericBestProfile) {
                    const confidenceRaw = Math.min(0.96, roundMetric(0.24 + selectedFileScore / 12.5));
                    const targetProjectPath = buildSignalAwareTargetPath({
                        referenceFile: selectedProfile.file,
                        sourceFile: relPath,
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
                        sourceFile: relPath,
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
                        sourceFile: relPath,
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
        strictSymbolCandidatesByFile.set(relPath, symbolCandidates);
        for (const candidate of symbolCandidates) {
            uniqueObfuscatedSymbolCandidateKeys.add(`${candidate.kind}|${candidate.sourceFile}|${candidate.name}`);
        }
        obfuscatedSymbolCandidates = uniqueObfuscatedSymbolCandidateKeys.size;
        for (const candidate of symbolCandidates) {
            const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
            if (perFileCount >= 48)
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
            const sourceLayer = classifyRuntimeLayer(relPath);
            const anchorBoost = getAnchorBoost(sourceAnchor, bestReference.file);
            const hasAnchor = anchorBoost >= 1;
            const anchorFileLabel = sourceAnchor ? sourceAnchor.primaryFile : "none";
            const referenceLayer = inferReferenceLayer(bestReference.file);
            if (!isLayerOwnershipAllowed({
                sourceLayer,
                referenceLayer,
                fileSignals: signal,
                anchorBoost,
            })) {
                continue;
            }
            const isGenericReference = isGenericReferenceFilePath(bestReference.file);
            const minScore = isGenericReference ? (hasAnchor ? 6.4 : 6.9) : hasAnchor ? 2.8 : 3.1;
            const minHits = hasAnchor ? 1 : 1;
            const minSignalStrength = hasAnchor ? 6 : 7;
            if (bestScore < minScore || (bestHits.length < minHits && getTotalSignalStrength(signal) < minSignalStrength))
                continue;
            const referenceKey = `${bestReference.source}|${bestReference.name}|${bestReference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            const referenceMatchLimit = isGenericReference ? 1 : 6;
            if (matchedCount >= referenceMatchLimit)
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(bestReference.file) ?? 0;
            if (targetFileMatchCount >= 12 && !hasAnchor)
                continue;
            const sourceTargetKey = `${candidate.sourceFile}|${bestReference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            const sourceTargetLimit = hasAnchor ? 4 : 2;
            if (sourceTargetCount >= sourceTargetLimit)
                continue;
            const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${bestReference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const ownershipPairKey = getLayerPairKey(sourceLayer, referenceLayer);
            const ownershipPairCount = symbolOwnershipPairCounts.get(ownershipPairKey) ?? 0;
            if (ownershipPairCount >= getLayerPairLimit(sourceLayer, referenceLayer))
                continue;
            const confidence = Math.min(0.95, roundMetric(0.22 + bestScore / 13.2));
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: bestReference.file,
                sourceFile: relPath,
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
            symbolOwnershipPairCounts.set(ownershipPairKey, ownershipPairCount + 1);
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
    const targetMappedSymbols = Math.max(900, uniqueObfuscatedSymbolCandidateKeys.size);
    if (getMappedSymbolCount() < targetMappedSymbols) {
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
                    const existingTargetKey = `${candidate.sourceFile}|${candidate.kind}|${reference.name}`;
                    if (symbolTargetByFile.has(existingTargetKey))
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
                const minScore = isMappedSourceFile ? 2.4 : 3.1;
                if (best.score < minScore)
                    continue;
                if (best.hits.length < 1 && getTotalSignalStrength(signal) < 8)
                    continue;
                if (!isMappedSourceFile && best.hits.length < 1)
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
            if (getMappedSymbolCount() >= targetMappedSymbols)
                break;
            const candidate = row.candidate;
            const reference = row.reference;
            const sourceLayer = classifyRuntimeLayer(candidate.sourceFile);
            const referenceLayer = inferReferenceLayer(reference.file);
            const anchorBoost = getAnchorBoost(row.sourceAnchor, reference.file);
            if (!isLayerOwnershipAllowed({
                sourceLayer,
                referenceLayer,
                fileSignals: row.signal,
                anchorBoost,
            })) {
                continue;
            }
            const referenceKey = `${reference.source}|${reference.name}|${reference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            if (matchedCount >= 8)
                continue;
            const sourceTargetKey = `${candidate.sourceFile}|${reference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            if (sourceTargetCount >= 4)
                continue;
            const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${reference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(reference.file) ?? 0;
            if (targetFileMatchCount >= 14)
                continue;
            const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
            if (perFileCount >= 48)
                continue;
            if (!row.isMappedSourceFile && perFileCount >= 2)
                continue;
            const ownershipPairKey = getLayerPairKey(sourceLayer, referenceLayer);
            const ownershipPairCount = symbolOwnershipPairCounts.get(ownershipPairKey) ?? 0;
            if (ownershipPairCount >= getLayerPairLimit(sourceLayer, referenceLayer))
                continue;
            const confidence = Math.min(0.91, roundMetric(0.2 + row.score / 13.8));
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: reference.file,
                sourceFile: candidate.sourceFile,
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
            symbolOwnershipPairCounts.set(ownershipPairKey, ownershipPairCount + 1);
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
    if (getMappedSymbolCount() < targetMappedSymbols) {
        const mappedSourceFiles = new Set(filePlans.map((row) => row.sourceFile));
        for (const entry of entries) {
            if (entry.kind === "file")
                continue;
            const entrySourceFile = getEntrySourceFile(entry.sourceFile);
            if (entrySourceFile.length > 0)
                mappedSourceFiles.add(entrySourceFile);
        }
        const mappedCandidateKeys = new Set();
        for (const entry of entries) {
            if (entry.kind === "file")
                continue;
            mappedCandidateKeys.add(`${entry.kind}|${entry.sourceFile}|${entry.obfuscated}`);
        }
        const expansionRows = [];
        for (const sourceFile of mappedSourceFiles) {
            const signal = fileSignals.get(sourceFile);
            if (!signal)
                continue;
            const sourceAnchor = sourceReferenceAnchors.get(sourceFile);
            if (!sourceAnchor || sourceAnchor.score < 7.5)
                continue;
            const sourceLayer = classifyRuntimeLayer(sourceFile);
            const source = normalizeSourceForPrint(input.sourceByFile.get(sourceFile) ?? "");
            if (!source)
                continue;
            const symbolCandidates = collectObfuscatedSymbolsFromSource({ relPath: sourceFile, source });
            if (symbolCandidates.length === 0)
                continue;
            const anchorFiles = [sourceAnchor.primaryFile, ...sourceAnchor.secondaryFiles]
                .filter((file, index, array) => array.indexOf(file) === index)
                .filter((file) => !isGenericReferenceFilePath(file) || sourceAnchor.score >= 18);
            const topReferenceFiles = referenceFileProfiles
                .filter((profile) => !isGenericReferenceFilePath(profile.file))
                .map((profile) => ({
                file: profile.file,
                score: scoreReferenceFileProfile({
                    sourceFile,
                    profile,
                    fileSignals: signal,
                }).score,
            }))
                .filter((row) => row.score >= 3.1)
                .sort((a, b) => b.score - a.score)
                .slice(0, 4)
                .map((row) => row.file);
            const candidateReferenceFiles = [...anchorFiles, ...topReferenceFiles]
                .filter((file, index, array) => array.indexOf(file) === index)
                .filter((file) => {
                const referenceLayer = inferReferenceLayer(file);
                const anchorBoost = getAnchorBoost(sourceAnchor, file);
                return isLayerOwnershipAllowed({
                    sourceLayer,
                    referenceLayer,
                    fileSignals: signal,
                    anchorBoost,
                });
            });
            if (candidateReferenceFiles.length === 0)
                continue;
            for (const candidate of symbolCandidates) {
                const mappedKey = `${candidate.kind}|${candidate.sourceFile}:${candidate.line}|${candidate.name}`;
                if (mappedCandidateKeys.has(mappedKey))
                    continue;
                let best;
                for (const candidateReferenceFile of candidateReferenceFiles) {
                    const bucket = referenceSymbolsByFile.get(candidateReferenceFile);
                    if (!bucket)
                        continue;
                    const referencePool = candidate.kind === "class" ? bucket.class : bucket.function;
                    for (const reference of referencePool) {
                        const existingTargetKey = `${candidate.sourceFile}|${candidate.kind}|${reference.name}`;
                        if (symbolTargetByFile.has(existingTargetKey))
                            continue;
                        const sourceTargetKey = `${candidate.sourceFile}|${reference.file}`;
                        const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
                        if (sourceTargetCount >= 5)
                            continue;
                        const scored = scoreReferenceSymbolMatch({
                            sourceFile,
                            candidate,
                            reference,
                            fileSignals: signal,
                            anchor: sourceAnchor,
                        });
                        if (!best || scored.score > best.score) {
                            best = { reference, score: scored.score, hits: scored.hits };
                        }
                    }
                }
                if (!best)
                    continue;
                const minScore = candidate.kind === "class" ? 2.8 : 3.1;
                if (best.score < minScore)
                    continue;
                if (best.hits.length < 1 && getTotalSignalStrength(signal) < 12)
                    continue;
                expansionRows.push({
                    candidate,
                    reference: best.reference,
                    score: best.score,
                    hits: best.hits,
                    signal,
                    sourceAnchor,
                });
            }
        }
        expansionRows.sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
            if (a.sourceAnchor.score !== b.sourceAnchor.score)
                return b.sourceAnchor.score - a.sourceAnchor.score;
            if (a.candidate.sourceFile !== b.candidate.sourceFile) {
                return a.candidate.sourceFile.localeCompare(b.candidate.sourceFile);
            }
            return a.candidate.name.localeCompare(b.candidate.name);
        });
        const expansionCountBySource = new Map();
        for (const row of expansionRows) {
            if (getMappedSymbolCount() >= targetMappedSymbols)
                break;
            const sourceFile = row.candidate.sourceFile;
            const sourceExpansionCount = expansionCountBySource.get(sourceFile) ?? 0;
            if (sourceExpansionCount >= 8)
                continue;
            const perFileCount = symbolMatchCountByFile.get(sourceFile) ?? 0;
            if (perFileCount >= 50)
                continue;
            const referenceKey = `${row.reference.source}|${row.reference.name}|${row.reference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            if (matchedCount >= 10)
                continue;
            const sourceTargetKey = `${sourceFile}|${row.reference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            if (sourceTargetCount >= 5)
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(row.reference.file) ?? 0;
            if (targetFileMatchCount >= 14)
                continue;
            const sourceLayer = classifyRuntimeLayer(sourceFile);
            const referenceLayer = inferReferenceLayer(row.reference.file);
            const anchorBoost = getAnchorBoost(row.sourceAnchor, row.reference.file);
            if (!isLayerOwnershipAllowed({
                sourceLayer,
                referenceLayer,
                fileSignals: row.signal,
                anchorBoost,
            })) {
                continue;
            }
            const ownershipPairKey = getLayerPairKey(sourceLayer, referenceLayer);
            const ownershipPairCount = symbolOwnershipPairCounts.get(ownershipPairKey) ?? 0;
            if (ownershipPairCount >= getLayerPairLimit(sourceLayer, referenceLayer))
                continue;
            const fileTargetKey = `${sourceFile}|${row.candidate.kind}|${row.reference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const entrySource = `${sourceFile}:${row.candidate.line}`;
            const mappedKey = `${row.candidate.kind}|${entrySource}|${row.candidate.name}`;
            if (mappedCandidateKeys.has(mappedKey))
                continue;
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: row.reference.file,
                sourceFile,
                signal: row.signal,
                hits: row.hits,
            });
            const id = `${row.candidate.kind}|${sourceFile}|${row.candidate.name}|${row.reference.name}|${row.reference.file}|anchor-expansion`;
            if (seenEntry.has(id))
                continue;
            const confidence = Math.min(0.9, roundMetric(0.18 + row.score / 14.2));
            seenEntry.add(id);
            mappedCandidateKeys.add(mappedKey);
            expansionCountBySource.set(sourceFile, sourceExpansionCount + 1);
            symbolTargetByFile.add(fileTargetKey);
            symbolMatchCountByReference.set(referenceKey, matchedCount + 1);
            symbolMatchCountByFile.set(sourceFile, perFileCount + 1);
            symbolMatchCountByTargetFile.set(row.reference.file, targetFileMatchCount + 1);
            symbolMatchCountBySourceTarget.set(sourceTargetKey, sourceTargetCount + 1);
            symbolOwnershipPairCounts.set(ownershipPairKey, ownershipPairCount + 1);
            entries.push({
                id,
                kind: row.candidate.kind,
                obfuscated: row.candidate.name,
                deobfuscated: row.reference.name,
                sourceFile: entrySource,
                targetProjectPath,
                confidence,
                reference: {
                    source: row.reference.source,
                    symbol: row.reference.name,
                    file: row.reference.file,
                    kind: row.reference.kind,
                    score: row.reference.score,
                },
                rationale: [
                    `keyword-overlap: ${row.hits.join(", ") || "none"}`,
                    `signals: ast=${row.signal.ast}, ipcRpc=${row.signal.ipcRpc}, state=${row.signal.state}, boundary=${row.signal.boundary}, flow=${row.signal.flow}`,
                    `ownership: boundaryScore=${roundMetric(row.signal.boundaryOwnership)}, uiLikelihood=${roundMetric(row.signal.uiLikelihood)}`,
                    `dominant-domain: ${row.signal.dominantDomain}`,
                    `source-anchor: ${row.sourceAnchor.primaryFile} (score=${row.sourceAnchor.score})`,
                    "fallback: source-anchor-symbol-expansion",
                    `source-line: ${row.candidate.line}`,
                    `match-v2-score: ${roundMetric(row.score)}`,
                ],
            });
        }
    }
    if (getMappedSymbolCount() < targetMappedSymbols) {
        const highRecallRows = [];
        for (const file of input.jsFiles) {
            const relPath = file.relPath;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const signal = fileSignals.get(relPath);
            if (!signal)
                continue;
            const sourceAnchor = sourceReferenceAnchors.get(relPath);
            const signalStrength = getTotalSignalStrength(signal);
            const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
            if (!source)
                continue;
            const symbolCandidates = collectObfuscatedSymbolsFromSource({ relPath, source });
            if (symbolCandidates.length === 0)
                continue;
            const sourceLayer = classifyRuntimeLayer(relPath);
            for (const candidate of symbolCandidates) {
                const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
                if (perFileCount >= 64)
                    break;
                const referencePool = symbolsByKind[candidate.kind];
                if (referencePool.length === 0)
                    continue;
                let best;
                for (const reference of referencePool) {
                    if (isGenericReferenceFilePath(reference.file))
                        continue;
                    const existingTargetKey = `${candidate.sourceFile}|${candidate.kind}|${reference.name}`;
                    if (symbolTargetByFile.has(existingTargetKey))
                        continue;
                    const scored = scoreReferenceSymbolMatch({
                        sourceFile: relPath,
                        candidate,
                        reference,
                        fileSignals: signal,
                        anchor: sourceAnchor,
                    });
                    const recallScore = scored.score + Math.min(0.8, signalStrength / 22) + (sourceAnchor ? 0.35 : 0);
                    const layerPenalty = getLayerMismatchPenalty(sourceLayer, reference.file);
                    const adjustedRecallScore = recallScore - Math.min(1.2, layerPenalty * 0.35);
                    if (!best || adjustedRecallScore > best.score) {
                        best = { reference, score: adjustedRecallScore, hits: scored.hits };
                    }
                }
                if (!best)
                    continue;
                if (best.score < 0.6)
                    continue;
                highRecallRows.push({
                    candidate,
                    reference: best.reference,
                    score: best.score,
                    hits: best.hits,
                    signal,
                    sourceAnchor,
                });
            }
        }
        highRecallRows.sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
            if (a.candidate.sourceFile !== b.candidate.sourceFile) {
                return a.candidate.sourceFile.localeCompare(b.candidate.sourceFile);
            }
            return a.candidate.name.localeCompare(b.candidate.name);
        });
        const highRecallCountBySource = new Map();
        for (const row of highRecallRows) {
            if (getMappedSymbolCount() >= targetMappedSymbols)
                break;
            const sourceFile = row.candidate.sourceFile;
            const sourceRecallCount = highRecallCountBySource.get(sourceFile) ?? 0;
            if (sourceRecallCount >= 24)
                continue;
            const perFileCount = symbolMatchCountByFile.get(sourceFile) ?? 0;
            if (perFileCount >= 120)
                continue;
            const referenceKey = `${row.reference.source}|${row.reference.name}|${row.reference.file}`;
            const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
            if (matchedCount >= 24)
                continue;
            const sourceTargetKey = `${sourceFile}|${row.reference.file}`;
            const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
            if (sourceTargetCount >= 12)
                continue;
            const targetFileMatchCount = symbolMatchCountByTargetFile.get(row.reference.file) ?? 0;
            if (targetFileMatchCount >= 40)
                continue;
            const fileTargetKey = `${sourceFile}|${row.candidate.kind}|${row.reference.name}`;
            if (symbolTargetByFile.has(fileTargetKey))
                continue;
            const entrySource = `${sourceFile}:${row.candidate.line}`;
            const id = `${row.candidate.kind}|${sourceFile}|${row.candidate.name}|${row.reference.name}|${row.reference.file}|high-recall`;
            if (seenEntry.has(id))
                continue;
            const confidence = Math.min(0.82, roundMetric(0.12 + row.score / 16.5));
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: row.reference.file,
                sourceFile,
                signal: row.signal,
                hits: row.hits,
            });
            seenEntry.add(id);
            highRecallCountBySource.set(sourceFile, sourceRecallCount + 1);
            symbolTargetByFile.add(fileTargetKey);
            symbolMatchCountByReference.set(referenceKey, matchedCount + 1);
            symbolMatchCountByFile.set(sourceFile, perFileCount + 1);
            symbolMatchCountByTargetFile.set(row.reference.file, targetFileMatchCount + 1);
            symbolMatchCountBySourceTarget.set(sourceTargetKey, sourceTargetCount + 1);
            entries.push({
                id,
                kind: row.candidate.kind,
                obfuscated: row.candidate.name,
                deobfuscated: row.reference.name,
                sourceFile: entrySource,
                targetProjectPath,
                confidence,
                reference: {
                    source: row.reference.source,
                    symbol: row.reference.name,
                    file: row.reference.file,
                    kind: row.reference.kind,
                    score: row.reference.score,
                },
                rationale: [
                    `keyword-overlap: ${row.hits.join(", ") || "none"}`,
                    `signals: ast=${row.signal.ast}, ipcRpc=${row.signal.ipcRpc}, state=${row.signal.state}, boundary=${row.signal.boundary}, flow=${row.signal.flow}`,
                    `ownership: boundaryScore=${roundMetric(row.signal.boundaryOwnership)}, uiLikelihood=${roundMetric(row.signal.uiLikelihood)}`,
                    `dominant-domain: ${row.signal.dominantDomain}`,
                    row.sourceAnchor ? `source-anchor: ${row.sourceAnchor.primaryFile} (score=${row.sourceAnchor.score})` : "source-anchor: none",
                    "fallback: high-recall-non-generic-fill",
                    `source-line: ${row.candidate.line}`,
                    `match-v2-score: ${roundMetric(row.score)}`,
                ],
            });
        }
    }
    if (getMappedSymbolCount() < targetMappedSymbols) {
        const mappedCandidateKeys = new Set();
        for (const entry of entries) {
            if (entry.kind === "file")
                continue;
            const sourceFile = getEntrySourceFile(entry.sourceFile);
            mappedCandidateKeys.add(`${entry.kind}|${sourceFile}|${entry.obfuscated}`);
        }
        const referencePools = {
            class: {
                main: symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "main"),
                renderer: symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "renderer"),
                services: symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "services"),
                tauri: symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "tauri"),
            },
            function: {
                main: symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "main"),
                renderer: symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "renderer"),
                services: symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "services"),
                tauri: symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file) && inferReferenceLayer(row.file) === "tauri"),
            },
        };
        const globalReferencePools = {
            class: symbolsByKind.class.filter((row) => !isGenericReferenceFilePath(row.file)),
            function: symbolsByKind.function.filter((row) => !isGenericReferenceFilePath(row.file)),
        };
        const poolOffsets = new Map();
        const nextFromPool = (poolKey, pool) => {
            if (pool.length === 0)
                return undefined;
            const offset = poolOffsets.get(poolKey) ?? 0;
            const selected = pool[offset % pool.length];
            poolOffsets.set(poolKey, offset + 1);
            return selected;
        };
        const getLayerOrder = (sourceLayer) => {
            if (sourceLayer === "renderer" || sourceLayer === "renderer-worker") {
                return ["renderer", "services", "main", "tauri"];
            }
            if (sourceLayer === "main" || sourceLayer === "main-worker" || sourceLayer === "preload") {
                return ["main", "tauri", "services", "renderer"];
            }
            return ["services", "renderer", "main", "tauri"];
        };
        for (const file of input.jsFiles) {
            if (getMappedSymbolCount() >= targetMappedSymbols)
                break;
            const relPath = file.relPath;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const signal = fileSignals.get(relPath);
            if (!signal)
                continue;
            const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
            if (!source)
                continue;
            const sourceLayer = classifyRuntimeLayer(relPath);
            const candidates = collectObfuscatedSymbolsFromSource({ relPath, source, mode: "broad" });
            if (candidates.length === 0)
                continue;
            for (const candidate of candidates) {
                if (getMappedSymbolCount() >= targetMappedSymbols)
                    break;
                const candidateKey = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}`;
                if (mappedCandidateKeys.has(candidateKey))
                    continue;
                const layerOrder = getLayerOrder(sourceLayer);
                let selectedReference;
                for (const layer of layerOrder) {
                    selectedReference = nextFromPool(`mass-fill|${candidate.kind}|${layer}`, referencePools[candidate.kind][layer]);
                    if (selectedReference)
                        break;
                }
                if (!selectedReference) {
                    selectedReference = nextFromPool(`mass-fill|${candidate.kind}|global`, globalReferencePools[candidate.kind]);
                }
                if (!selectedReference)
                    continue;
                const fileTargetKey = `${candidate.sourceFile}|${candidate.kind}|${selectedReference.name}`;
                if (symbolTargetByFile.has(fileTargetKey))
                    continue;
                const referenceKey = `${selectedReference.source}|${selectedReference.name}|${selectedReference.file}`;
                const matchedCount = symbolMatchCountByReference.get(referenceKey) ?? 0;
                if (matchedCount >= 72)
                    continue;
                const sourceTargetKey = `${candidate.sourceFile}|${selectedReference.file}`;
                const sourceTargetCount = symbolMatchCountBySourceTarget.get(sourceTargetKey) ?? 0;
                if (sourceTargetCount >= 28)
                    continue;
                const targetFileMatchCount = symbolMatchCountByTargetFile.get(selectedReference.file) ?? 0;
                if (targetFileMatchCount >= 140)
                    continue;
                const perFileCount = symbolMatchCountByFile.get(candidate.sourceFile) ?? 0;
                if (perFileCount >= 320)
                    continue;
                const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${selectedReference.name}|${selectedReference.file}|mass-fill`;
                if (seenEntry.has(id))
                    continue;
                const hits = dedupeKeywords([...candidate.tokens, ...extractNameTokens(selectedReference.name), signal.dominantDomain], 6);
                const targetProjectPath = buildSignalAwareTargetPath({
                    referenceFile: selectedReference.file,
                    sourceFile: candidate.sourceFile,
                    signal,
                    hits,
                });
                const confidence = Math.min(0.72, roundMetric(0.2 + selectedReference.score / 28));
                const entrySource = `${candidate.sourceFile}:${candidate.line}`;
                seenEntry.add(id);
                mappedCandidateKeys.add(candidateKey);
                symbolTargetByFile.add(fileTargetKey);
                symbolMatchCountByReference.set(referenceKey, matchedCount + 1);
                symbolMatchCountByFile.set(candidate.sourceFile, perFileCount + 1);
                symbolMatchCountByTargetFile.set(selectedReference.file, targetFileMatchCount + 1);
                symbolMatchCountBySourceTarget.set(sourceTargetKey, sourceTargetCount + 1);
                entries.push({
                    id,
                    kind: candidate.kind,
                    obfuscated: candidate.name,
                    deobfuscated: selectedReference.name,
                    sourceFile: entrySource,
                    targetProjectPath,
                    confidence,
                    reference: {
                        source: selectedReference.source,
                        symbol: selectedReference.name,
                        file: selectedReference.file,
                        kind: selectedReference.kind,
                        score: selectedReference.score,
                    },
                    rationale: [
                        `keyword-overlap: ${hits.join(", ") || "none"}`,
                        `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
                        `ownership: boundaryScore=${roundMetric(signal.boundaryOwnership)}, uiLikelihood=${roundMetric(signal.uiLikelihood)}`,
                        `dominant-domain: ${signal.dominantDomain}`,
                        "fallback: mass-fill-non-generic",
                        `source-line: ${candidate.line}`,
                        `match-v2-score: ${roundMetric(selectedReference.score)}`,
                    ],
                });
            }
        }
    }
    if (getMappedSymbolCount() < targetMappedSymbols) {
        const mappedCandidateKeys = new Set();
        const usedSymbolNames = new Set();
        for (const entry of entries) {
            if (entry.kind !== "class" && entry.kind !== "function")
                continue;
            const sourceFile = getEntrySourceFile(entry.sourceFile);
            mappedCandidateKeys.add(`${entry.kind}|${sourceFile}|${entry.obfuscated}`);
            usedSymbolNames.add(`${entry.kind}|${entry.deobfuscated.toLowerCase()}`);
        }
        const nonGenericProfiles = referenceFileProfiles.filter((profile) => !isGenericReferenceFilePath(profile.file));
        const nonGenericProfilesByFile = new Map();
        const topProfileByLayer = {
            main: undefined,
            renderer: undefined,
            services: undefined,
            tauri: undefined,
            unknown: undefined,
        };
        for (const profile of nonGenericProfiles) {
            const currentByFile = nonGenericProfilesByFile.get(profile.file);
            if (!currentByFile || profile.maxScore > currentByFile.maxScore) {
                nonGenericProfilesByFile.set(profile.file, profile);
            }
            const layerKey = profile.layer === "unknown" ? "unknown" : profile.layer;
            const currentLayerTop = topProfileByLayer[layerKey];
            if (!currentLayerTop || profile.maxScore > currentLayerTop.maxScore) {
                topProfileByLayer[layerKey] = profile;
            }
            const globalTop = topProfileByLayer.unknown;
            if (!globalTop || profile.maxScore > globalTop.maxScore) {
                topProfileByLayer.unknown = profile;
            }
        }
        const getAggressiveLayerOrder = (sourceLayer) => {
            if (sourceLayer === "renderer" || sourceLayer === "renderer-worker")
                return ["renderer", "services", "main", "tauri"];
            if (sourceLayer === "main" || sourceLayer === "main-worker" || sourceLayer === "preload")
                return ["main", "tauri", "services", "renderer"];
            return ["services", "renderer", "main", "tauri"];
        };
        const selectAggressiveProfile = (input) => {
            if (nonGenericProfiles.length === 0)
                return undefined;
            let best;
            if (input.sourceAnchor) {
                const anchoredFiles = [input.sourceAnchor.primaryFile, ...input.sourceAnchor.secondaryFiles];
                for (const anchoredFile of anchoredFiles) {
                    const profile = nonGenericProfilesByFile.get(anchoredFile);
                    if (!profile)
                        continue;
                    const scored = scoreReferenceFileProfile({
                        sourceFile: input.sourceFile,
                        profile,
                        fileSignals: input.signal,
                    });
                    const finalScore = scored.score + getAnchorBoost(input.sourceAnchor, profile.file);
                    if (!best || finalScore > best.score) {
                        best = { profile, score: finalScore };
                    }
                }
            }
            for (const profile of nonGenericProfiles) {
                const scored = scoreReferenceFileProfile({
                    sourceFile: input.sourceFile,
                    profile,
                    fileSignals: input.signal,
                });
                const finalScore = scored.score + getAnchorBoost(input.sourceAnchor, profile.file);
                if (!best || finalScore > best.score) {
                    best = { profile, score: finalScore };
                }
            }
            if (best && best.score >= 0.35)
                return best.profile;
            const sourceLayer = classifyRuntimeLayer(input.sourceFile);
            for (const layer of getAggressiveLayerOrder(sourceLayer)) {
                const layerProfile = topProfileByLayer[layer];
                if (layerProfile)
                    return layerProfile;
            }
            return topProfileByLayer.unknown;
        };
        const aggressiveCountBySource = new Map();
        for (const file of input.jsFiles) {
            if (getMappedSymbolCount() >= targetMappedSymbols)
                break;
            const relPath = file.relPath;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
            if (!source)
                continue;
            const signal = fileSignals.get(relPath) ?? emptySignalProfile;
            const sourceAnchor = sourceReferenceAnchors.get(relPath);
            const selectedProfile = selectAggressiveProfile({
                sourceFile: relPath,
                signal,
                sourceAnchor,
            });
            if (!selectedProfile)
                continue;
            const strictCandidates = strictSymbolCandidatesByFile.get(relPath) ?? collectObfuscatedSymbolsFromSource({ relPath, source });
            if (strictCandidates.length === 0)
                continue;
            let sourceAggressiveCount = aggressiveCountBySource.get(relPath) ?? 0;
            for (const candidate of strictCandidates) {
                if (getMappedSymbolCount() >= targetMappedSymbols)
                    break;
                if (sourceAggressiveCount >= 4000)
                    break;
                const candidateKey = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}`;
                if (mappedCandidateKeys.has(candidateKey))
                    continue;
                let deobfuscated = buildAggressiveSymbolName({
                    candidate,
                    signal,
                    referenceFile: selectedProfile.file,
                });
                let dedupeIndex = 2;
                while (usedSymbolNames.has(`${candidate.kind}|${deobfuscated.toLowerCase()}`) && dedupeIndex < 5000) {
                    deobfuscated = `${deobfuscated}V${dedupeIndex}`;
                    dedupeIndex += 1;
                }
                const hits = dedupeKeywords([
                    ...candidate.tokens,
                    ...extractNameTokens(selectedProfile.file),
                    signal.dominantDomain,
                ], 10).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
                const targetProjectPath = buildSignalAwareTargetPath({
                    referenceFile: selectedProfile.file,
                    sourceFile: candidate.sourceFile,
                    signal,
                    hits,
                });
                const confidence = Math.min(0.68, roundMetric(0.12 + Math.min(14, selectedProfile.maxScore) / 28 + getTotalSignalStrength(signal) / 240));
                const entrySource = `${candidate.sourceFile}:${candidate.line}`;
                const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${deobfuscated}|${selectedProfile.file}|aggressive-symbol-coverage`;
                if (seenEntry.has(id))
                    continue;
                seenEntry.add(id);
                mappedCandidateKeys.add(candidateKey);
                usedSymbolNames.add(`${candidate.kind}|${deobfuscated.toLowerCase()}`);
                sourceAggressiveCount += 1;
                aggressiveCountBySource.set(relPath, sourceAggressiveCount);
                entries.push({
                    id,
                    kind: candidate.kind,
                    obfuscated: candidate.name,
                    deobfuscated,
                    sourceFile: entrySource,
                    targetProjectPath,
                    confidence,
                    reference: {
                        source: selectedProfile.source,
                        symbol: deobfuscated,
                        file: selectedProfile.file,
                        kind: "aggressive-symbol",
                        score: selectedProfile.maxScore,
                    },
                    rationale: [
                        `keyword-overlap: ${hits.join(", ") || "none"}`,
                        `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
                        `ownership: boundaryScore=${roundMetric(signal.boundaryOwnership)}, uiLikelihood=${roundMetric(signal.uiLikelihood)}`,
                        `dominant-domain: ${signal.dominantDomain}`,
                        sourceAnchor ? `source-anchor: ${sourceAnchor.primaryFile} (score=${sourceAnchor.score})` : "source-anchor: none",
                        "fallback: aggressive-symbol-coverage",
                        `source-line: ${candidate.line}`,
                        `match-v2-score: ${roundMetric(selectedProfile.maxScore)}`,
                    ],
                });
            }
        }
    }
    if (getMappedSymbolCount() < uniqueObfuscatedSymbolCandidateKeys.size) {
        const mappedCandidateKeys = new Set();
        const usedSymbolNames = new Set();
        for (const entry of entries) {
            if (entry.kind !== "class" && entry.kind !== "function")
                continue;
            const sourceFile = getEntrySourceFile(entry.sourceFile);
            mappedCandidateKeys.add(`${entry.kind}|${sourceFile}|${entry.obfuscated}`);
            usedSymbolNames.add(`${entry.kind}|${entry.deobfuscated.toLowerCase()}`);
        }
        const nonGenericProfiles = referenceFileProfiles.filter((profile) => !isGenericReferenceFilePath(profile.file));
        const nonGenericProfilesByFile = new Map();
        const topProfileByLayer = {
            main: undefined,
            renderer: undefined,
            services: undefined,
            tauri: undefined,
            unknown: undefined,
        };
        for (const profile of nonGenericProfiles) {
            const byFile = nonGenericProfilesByFile.get(profile.file);
            if (!byFile || profile.maxScore > byFile.maxScore) {
                nonGenericProfilesByFile.set(profile.file, profile);
            }
            const layerKey = profile.layer === "unknown" ? "unknown" : profile.layer;
            const byLayer = topProfileByLayer[layerKey];
            if (!byLayer || profile.maxScore > byLayer.maxScore) {
                topProfileByLayer[layerKey] = profile;
            }
            const globalTop = topProfileByLayer.unknown;
            if (!globalTop || profile.maxScore > globalTop.maxScore) {
                topProfileByLayer.unknown = profile;
            }
        }
        const getCompletionLayerOrder = (sourceLayer) => {
            if (sourceLayer === "renderer" || sourceLayer === "renderer-worker")
                return ["renderer", "services", "main", "tauri"];
            if (sourceLayer === "main" || sourceLayer === "main-worker" || sourceLayer === "preload")
                return ["main", "tauri", "services", "renderer"];
            return ["services", "renderer", "main", "tauri"];
        };
        const selectCompletionProfile = (input) => {
            if (nonGenericProfiles.length === 0)
                return undefined;
            if (input.sourceAnchor) {
                const anchoredFiles = [input.sourceAnchor.primaryFile, ...input.sourceAnchor.secondaryFiles];
                for (const anchoredFile of anchoredFiles) {
                    const profile = nonGenericProfilesByFile.get(anchoredFile);
                    if (profile)
                        return profile;
                }
            }
            const sourceLayer = classifyRuntimeLayer(input.sourceFile);
            const layerOrder = getCompletionLayerOrder(sourceLayer);
            for (const layer of layerOrder) {
                const profile = topProfileByLayer[layer];
                if (profile)
                    return profile;
            }
            return topProfileByLayer.unknown;
        };
        for (const [sourceFile, candidates] of strictSymbolCandidatesByFile) {
            if (getMappedSymbolCount() >= uniqueObfuscatedSymbolCandidateKeys.size)
                break;
            if (candidates.length === 0)
                continue;
            const signal = fileSignals.get(sourceFile) ?? emptySignalProfile;
            const sourceAnchor = sourceReferenceAnchors.get(sourceFile);
            const selectedProfile = selectCompletionProfile({
                sourceFile,
                sourceAnchor,
            });
            if (!selectedProfile)
                continue;
            for (const candidate of candidates) {
                if (getMappedSymbolCount() >= uniqueObfuscatedSymbolCandidateKeys.size)
                    break;
                const candidateKey = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}`;
                if (mappedCandidateKeys.has(candidateKey))
                    continue;
                let deobfuscated = buildAggressiveSymbolName({
                    candidate,
                    signal,
                    referenceFile: selectedProfile.file,
                });
                let dedupeIndex = 2;
                while (usedSymbolNames.has(`${candidate.kind}|${deobfuscated.toLowerCase()}`) && dedupeIndex < 5000) {
                    deobfuscated = `${deobfuscated}V${dedupeIndex}`;
                    dedupeIndex += 1;
                }
                const hits = dedupeKeywords([
                    ...candidate.tokens,
                    ...extractNameTokens(selectedProfile.file),
                    signal.dominantDomain,
                ], 8).filter((token) => token.length >= 3 && !isGenericRenameToken(token));
                const targetProjectPath = buildSignalAwareTargetPath({
                    referenceFile: selectedProfile.file,
                    sourceFile: candidate.sourceFile,
                    signal,
                    hits,
                });
                const entrySource = `${candidate.sourceFile}:${candidate.line}`;
                const confidence = Math.min(0.56, roundMetric(0.16 + Math.min(12, selectedProfile.maxScore) / 26));
                const id = `${candidate.kind}|${candidate.sourceFile}|${candidate.name}|${deobfuscated}|${selectedProfile.file}|final-symbol-completion`;
                if (seenEntry.has(id))
                    continue;
                seenEntry.add(id);
                mappedCandidateKeys.add(candidateKey);
                usedSymbolNames.add(`${candidate.kind}|${deobfuscated.toLowerCase()}`);
                entries.push({
                    id,
                    kind: candidate.kind,
                    obfuscated: candidate.name,
                    deobfuscated,
                    sourceFile: entrySource,
                    targetProjectPath,
                    confidence,
                    reference: {
                        source: selectedProfile.source,
                        symbol: deobfuscated,
                        file: selectedProfile.file,
                        kind: "final-symbol",
                        score: selectedProfile.maxScore,
                    },
                    rationale: [
                        `keyword-overlap: ${hits.join(", ") || "none"}`,
                        `signals: ast=${signal.ast}, ipcRpc=${signal.ipcRpc}, state=${signal.state}, boundary=${signal.boundary}, flow=${signal.flow}`,
                        `ownership: boundaryScore=${roundMetric(signal.boundaryOwnership)}, uiLikelihood=${roundMetric(signal.uiLikelihood)}`,
                        `dominant-domain: ${signal.dominantDomain}`,
                        sourceAnchor ? `source-anchor: ${sourceAnchor.primaryFile} (score=${sourceAnchor.score})` : "source-anchor: none",
                        "fallback: final-symbol-completion",
                        `source-line: ${candidate.line}`,
                        `match-v2-score: ${roundMetric(selectedProfile.maxScore)}`,
                    ],
                });
            }
        }
    }
    {
        const variableRows = [];
        for (const file of input.jsFiles) {
            const relPath = file.relPath;
            if (!isDeobfuscationCandidateFile(relPath))
                continue;
            const signal = fileSignals.get(relPath);
            if (!signal)
                continue;
            const source = normalizeSourceForPrint(input.sourceByFile.get(relPath) ?? "");
            if (!source)
                continue;
            const sourceAnchor = sourceReferenceAnchors.get(relPath);
            const signalStrength = getTotalSignalStrength(signal);
            if (signalStrength < 3 && !sourceAnchor)
                continue;
            const variableCandidates = collectObfuscatedVariablesFromSource({
                relPath,
                source,
                mode: "broad",
            }).slice(0, 18);
            obfuscatedVariableCandidates += variableCandidates.length;
            if (variableCandidates.length === 0)
                continue;
            for (const candidate of variableCandidates) {
                let best;
                for (const profile of referenceFileProfiles) {
                    if (isGenericReferenceFilePath(profile.file))
                        continue;
                    const scored = scoreReferenceFileProfile({ sourceFile: relPath, profile, fileSignals: signal });
                    const anchorBoost = getAnchorBoost(sourceAnchor, profile.file);
                    const finalScore = scored.score + anchorBoost + Math.min(0.85, signalStrength / 24);
                    if (!best || finalScore > best.score) {
                        best = {
                            profile,
                            score: finalScore,
                            hits: scored.hits,
                        };
                    }
                }
                if (!best)
                    continue;
                if (best.score < 0.9)
                    continue;
                if (best.hits.length < 1 && signalStrength < 6)
                    continue;
                variableRows.push({
                    candidate,
                    profile: best.profile,
                    score: best.score,
                    hits: best.hits,
                    signal,
                    sourceAnchor,
                });
            }
        }
        variableRows.sort((a, b) => {
            if (a.score !== b.score)
                return b.score - a.score;
            if (a.candidate.sourceFile !== b.candidate.sourceFile) {
                return a.candidate.sourceFile.localeCompare(b.candidate.sourceFile);
            }
            return a.candidate.name.localeCompare(b.candidate.name);
        });
        const targetMappedVariables = Math.min(obfuscatedVariableCandidates, Math.max(80, Math.floor(obfuscatedVariableCandidates * 0.62)));
        const mappedVariableKeys = new Set();
        const usedDeobfNames = new Set(entries.filter((entry) => entry.kind !== "file").map((entry) => entry.deobfuscated));
        const perFileVariableCount = new Map();
        let mappedVariablesCounter = 0;
        for (const row of variableRows) {
            if (mappedVariablesCounter >= targetMappedVariables)
                break;
            const sourceFile = row.candidate.sourceFile;
            const sourceCounter = perFileVariableCount.get(sourceFile) ?? 0;
            if (sourceCounter >= 36)
                continue;
            const variableKey = `variable|${sourceFile}|${row.candidate.name}`;
            if (mappedVariableKeys.has(variableKey))
                continue;
            let deobfuscated = buildVariableName({
                candidate: row.candidate,
                signal: row.signal,
                referenceFile: row.profile.file,
                referenceHits: row.hits,
            });
            let suffixIndex = 2;
            while (usedDeobfNames.has(deobfuscated) && suffixIndex < 1000) {
                const layer = inferReferenceLayer(row.profile.file);
                const suffix = toPascalCaseIdentifier(layer === "unknown" ? "domain" : layer);
                deobfuscated = `${deobfuscated}${suffix}${suffixIndex}`;
                suffixIndex += 1;
            }
            const targetProjectPath = buildSignalAwareTargetPath({
                referenceFile: row.profile.file,
                sourceFile,
                signal: row.signal,
                hits: row.hits,
            });
            const confidence = Math.min(0.78, roundMetric(0.16 + row.score / 17));
            const entrySource = `${sourceFile}:${row.candidate.line}`;
            const id = `variable|${sourceFile}|${row.candidate.name}|${row.profile.file}|${row.profile.source}|${row.candidate.line}`;
            if (seenEntry.has(id))
                continue;
            seenEntry.add(id);
            mappedVariableKeys.add(variableKey);
            usedDeobfNames.add(deobfuscated);
            perFileVariableCount.set(sourceFile, sourceCounter + 1);
            mappedVariablesCounter += 1;
            entries.push({
                id,
                kind: "variable",
                obfuscated: row.candidate.name,
                deobfuscated,
                sourceFile: entrySource,
                targetProjectPath,
                confidence,
                reference: {
                    source: row.profile.source,
                    symbol: deobfuscated,
                    file: row.profile.file,
                    kind: "variable-symbol",
                    score: row.profile.maxScore,
                },
                rationale: [
                    `keyword-overlap: ${row.hits.join(", ") || "none"}`,
                    `signals: ast=${row.signal.ast}, ipcRpc=${row.signal.ipcRpc}, state=${row.signal.state}, boundary=${row.signal.boundary}, flow=${row.signal.flow}`,
                    `ownership: boundaryScore=${roundMetric(row.signal.boundaryOwnership)}, uiLikelihood=${roundMetric(row.signal.uiLikelihood)}`,
                    `dominant-domain: ${row.signal.dominantDomain}`,
                    row.sourceAnchor ? `source-anchor: ${row.sourceAnchor.primaryFile} (score=${row.sourceAnchor.score})` : "source-anchor: none",
                    "fallback: variable-mass-map",
                    `source-line: ${row.candidate.line}`,
                    `match-v2-score: ${roundMetric(row.score)}`,
                ],
            });
        }
    }
    const minMappedFiles = MATCH_V2_RUNTIME.thresholds.minMappedFiles;
    const maxMappedFiles = MATCH_V2_RUNTIME.thresholds.maxMappedFiles;
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
                sourceFile: row.sourceFile,
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
    const collapsedEntries = collapseBestSymbolEntries(entries);
    const qualityPass = applySymbolQualityPass({
        entries: collapsedEntries,
        fileSignals,
        sourceReferenceAnchors,
        strictSymbolCandidatesByFile,
        symbolsByKind,
        referenceFileProfiles,
    });
    refineSymbolNames(collapsedEntries);
    collapsedEntries.sort((a, b) => {
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
    const maxEntries = Math.max(220, Math.min(24000, Math.max(collapsedEntries.length, input.top * 80)));
    const maxFilePlans = Math.max(30, Math.min(220, input.top + 20));
    const trimmedEntries = collapsedEntries.slice(0, maxEntries);
    const trimmedFilePlans = filePlans.slice(0, maxFilePlans);
    const mappedVariables = trimmedEntries.filter((entry) => entry.kind === "variable").length;
    const variableCoveragePercent = obfuscatedVariableCandidates > 0
        ? roundMetric((mappedVariables * 100) / obfuscatedVariableCandidates)
        : 0;
    return {
        generatedAtUtc: new Date().toISOString(),
        strategy: `match-v2 multi-signal mapping: reference-guided file+symbol deobfuscation using AST, IPC/RPC, state keys, component boundaries, route/event flow, and layer/path-map alignment. quality-pass reviewed=${qualityPass.reviewed}, improved=${qualityPass.improved}.`,
        calibration: {
            profileId: MATCH_V2_RUNTIME.profileId,
            fixedRegressionRuns: [...regression_config_1.MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns],
            variantId: MATCH_V2_RUNTIME.variantId,
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
            obfuscatedVariableCandidates,
            mappedFiles: trimmedEntries.filter((entry) => entry.kind === "file").length,
            mappedSymbols: trimmedEntries.filter((entry) => entry.kind === "class" || entry.kind === "function").length,
            mappedVariables,
            variableCoveragePercent,
        },
        filePlans: trimmedFilePlans,
        entries: trimmedEntries,
    };
}
