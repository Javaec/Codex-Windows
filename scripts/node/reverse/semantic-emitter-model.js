"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSemanticEmitterModel = buildSemanticEmitterModel;
exports.resolveSemanticAliasHint = resolveSemanticAliasHint;
const deobfuscation_report_1 = require("./deobfuscation-report");
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
function toSafeExportIdentifier(input) {
    const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized))
        return normalized;
    return "symbol_export";
}
function sanitizeExportName(input) {
    const primary = toSafeExportIdentifier(input);
    if (primary !== "symbol_export")
        return primary;
    return toSafeExportIdentifier(input.trim().replace(/\s+/g, "_"));
}
function scoreAliasNameQuality(input) {
    let score = 1;
    if (input.length < 4)
        score -= 0.45;
    if (input.length > 56)
        score -= 0.3;
    if (/\d{3,}$/.test(input))
        score -= 0.35;
    if (/^[a-z]{1,3}$/i.test(input))
        score -= 0.5;
    const tokens = splitIdentifierTokens(input).map((token) => token.toLowerCase());
    if (tokens.length <= 1)
        score -= 0.2;
    if (tokens.length > 5)
        score -= 0.35;
    if (/(?:value|data|item|object|entry|result|state|handler|runtime|service)$/i.test(input)) {
        score -= 0.3;
    }
    return Math.max(0, Math.min(1, score));
}
function isGenericAliasName(input) {
    if (input.length < 5)
        return true;
    if (/\d{2,}$/.test(input))
        return true;
    if (/^(?:get|set|use|run|do|make|build|create|update|load|fetch|handle|process|resolve|compute|parse|format|map)[a-z0-9]*$/i.test(input)) {
        const tokens = splitIdentifierTokens(input);
        if (tokens.length <= 2 && input.length <= 18)
            return true;
    }
    return false;
}
function isNoisyAliasToken(token) {
    if (token.length <= 2)
        return true;
    if (/^\d+$/.test(token))
        return true;
    if (/^(?:id|ref|tmp|temp|var|misc|unknown|chunk|assets|renderer|main|services|tauri)$/.test(token)) {
        return true;
    }
    return false;
}
function toAliasHintKey(sourceFile, sourceSymbol) {
    return `${sourceFile}|${sourceSymbol}`;
}
function validateModuleShape(input) {
    if (input.targetPath.length === 0) {
        throw new Error("Semantic emitter model: empty targetPath.");
    }
    if (input.sourceFile.length === 0) {
        throw new Error(`Semantic emitter model: empty sourceFile for ${input.targetPath}.`);
    }
    if (input.ownerLayer !== "main" &&
        input.ownerLayer !== "renderer" &&
        input.ownerLayer !== "services" &&
        input.ownerLayer !== "tauri" &&
        input.ownerLayer !== "unknown") {
        throw new Error(`Semantic emitter model: unsupported owner layer '${input.ownerLayer}' for ${input.targetPath}.`);
    }
}
function buildSemanticEmitterModel(input) {
    const aliasHintBySourceAndSymbol = new Map();
    const targetPathSet = new Set();
    const modules = [];
    for (const module of input.ownershipResolution.model.modules) {
        const targetPath = (0, deobfuscation_report_1.toProjectRelativeTargetPath)(module.modulePath);
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(module.sourceFile);
        validateModuleShape({
            targetPath,
            sourceFile,
            ownerLayer: module.ownerLayer,
        });
        if (targetPathSet.has(targetPath)) {
            throw new Error(`Semantic emitter model: duplicate targetPath '${targetPath}'.`);
        }
        targetPathSet.add(targetPath);
        const exportByName = new Map();
        for (const symbol of module.symbols) {
            const name = sanitizeExportName(symbol.exportedName);
            if (name === "symbol_export")
                continue;
            const kind = symbol.kind;
            if (kind !== "class" && kind !== "function" && kind !== "variable")
                continue;
            const row = {
                name,
                sourceSymbol: symbol.sourceSymbol,
                kind,
                sourceLine: symbol.sourceLine,
                confidence: symbol.confidence,
                reference: symbol.reference.trim(),
                rationale: [...symbol.rationale].sort((a, b) => a.localeCompare(b)),
            };
            const current = exportByName.get(name);
            if (!current || row.confidence > current.confidence) {
                exportByName.set(name, row);
            }
            const sourceSymbol = symbol.sourceSymbol.trim();
            if (sourceSymbol.length === 0)
                continue;
            if (kind !== "class" && kind !== "function")
                continue;
            if (row.confidence < 0.95)
                continue;
            if (isGenericAliasName(name))
                continue;
            const aliasTokens = splitIdentifierTokens(name).map((token) => token.toLowerCase());
            if (aliasTokens.length === 0 || aliasTokens.length > 5)
                continue;
            if (aliasTokens.some((token) => isNoisyAliasToken(token)))
                continue;
            const quality = scoreAliasNameQuality(name);
            if (quality < 0.86)
                continue;
            const aliasScore = row.confidence * 2 + quality;
            const key = toAliasHintKey(sourceFile, sourceSymbol);
            const currentHint = aliasHintBySourceAndSymbol.get(key);
            if (!currentHint || aliasScore > currentHint.score) {
                aliasHintBySourceAndSymbol.set(key, {
                    sourceFile,
                    sourceSymbol,
                    name,
                    score: aliasScore,
                });
            }
        }
        const exports = Array.from(exportByName.values()).sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            if (a.kind !== b.kind)
                return a.kind.localeCompare(b.kind);
            return a.name.localeCompare(b.name);
        });
        modules.push({
            targetPath,
            sourceFile,
            ownerLayer: module.ownerLayer,
            confidence: module.confidence,
            symbols: exports.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
            references: [...module.references]
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
                .sort((a, b) => a.localeCompare(b)),
            rationale: [...module.rationale]
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
                .sort((a, b) => a.localeCompare(b)),
            exports,
        });
    }
    modules.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
    const aliasHints = Array.from(aliasHintBySourceAndSymbol.values()).sort((a, b) => {
        const sourceCmp = a.sourceFile.localeCompare(b.sourceFile);
        if (sourceCmp !== 0)
            return sourceCmp;
        const symbolCmp = a.sourceSymbol.localeCompare(b.sourceSymbol);
        if (symbolCmp !== 0)
            return symbolCmp;
        return b.score - a.score;
    });
    return {
        modules,
        aliasHints,
        aliasHintBySourceAndSymbol,
    };
}
function resolveSemanticAliasHint(model, input) {
    const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(input.sourceFile);
    if (sourceFile.length === 0)
        return undefined;
    const sourceSymbol = input.sourceSymbol.trim();
    if (sourceSymbol.length === 0)
        return undefined;
    return model.aliasHintBySourceAndSymbol.get(toAliasHintKey(sourceFile, sourceSymbol))?.name;
}
