"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSemanticIrFromDeobfuscationTable = buildSemanticIrFromDeobfuscationTable;
const deobfuscation_report_1 = require("./deobfuscation-report");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function toSafeExportIdentifier(input) {
    const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized))
        return normalized;
    return "symbol_export";
}
function sanitizeExportName(input) {
    const preferred = toSafeExportIdentifier(input);
    if (preferred !== "symbol_export")
        return preferred;
    return toSafeExportIdentifier(input.trim().replace(/\s+/g, "_"));
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
function normalizeTargetModulePath(targetPath) {
    const projectRelative = (0, deobfuscation_report_1.toProjectRelativeTargetPath)(targetPath);
    const normalized = toPosixPath(projectRelative).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:tsx?|jsx|mjs|cjs|js)$/i, ".ts");
}
function classifyLayerFromTargetPath(modulePath) {
    const normalized = toPosixPath(modulePath).replace(/^\.?\//, "");
    if (normalized.startsWith("src/main/"))
        return "main";
    if (normalized.startsWith("src/renderer/"))
        return "renderer";
    if (normalized.startsWith("src/services/"))
        return "services";
    if (normalized.startsWith("src-tauri-adapter/"))
        return "tauri";
    return "unknown";
}
function upsertMutableModule(index, modulePath) {
    const normalizedPath = normalizeTargetModulePath(modulePath);
    const existing = index.get(normalizedPath);
    if (existing)
        return existing;
    const created = {
        modulePath: normalizedPath,
        sourceScores: new Map(),
        confidence: 0,
        symbolsByKey: new Map(),
        references: new Set(),
        rationale: new Set(),
    };
    index.set(normalizedPath, created);
    return created;
}
function scoreSourceAssignment(sourceScores, sourceFile, confidence, rationaleBoost) {
    const current = sourceScores.get(sourceFile) ?? 0;
    const next = Math.max(current, confidence * 100 + rationaleBoost);
    sourceScores.set(sourceFile, next);
}
function pickPrimarySourceFile(sourceScores) {
    let bestSource = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [sourceFile, score] of sourceScores.entries()) {
        if (score > bestScore) {
            bestScore = score;
            bestSource = sourceFile;
        }
    }
    return bestSource;
}
function buildSemanticIrFromDeobfuscationTable(report) {
    const moduleIndex = new Map();
    for (const plan of report.filePlans) {
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(plan.sourceFile);
        if (sourceFile.length === 0)
            continue;
        const module = upsertMutableModule(moduleIndex, plan.proposedModulePath);
        scoreSourceAssignment(module.sourceScores, sourceFile, plan.confidence, 18);
        module.confidence = Math.max(module.confidence, plan.confidence);
        module.references.add(plan.referenceSource);
        for (const reason of plan.rationale) {
            const normalized = reason.trim();
            if (normalized.length === 0)
                continue;
            module.rationale.add(normalized);
        }
    }
    for (const entry of report.entries) {
        if (entry.kind === "file")
            continue;
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(entry.sourceFile);
        if (sourceFile.length === 0)
            continue;
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.obfuscated))
            continue;
        const exportName = sanitizeExportName(entry.deobfuscated);
        if (exportName === "symbol_export")
            continue;
        const module = upsertMutableModule(moduleIndex, entry.targetProjectPath);
        scoreSourceAssignment(module.sourceScores, sourceFile, entry.confidence, 10);
        module.confidence = Math.max(module.confidence, entry.confidence);
        const referenceValue = `${entry.reference.source}:${entry.reference.symbol}`.trim();
        if (referenceValue.length > 1)
            module.references.add(referenceValue);
        for (const reason of entry.rationale) {
            const normalized = reason.trim();
            if (normalized.length === 0)
                continue;
            module.rationale.add(normalized);
        }
        const symbolKey = `${entry.kind}:${entry.obfuscated}`;
        const previous = module.symbolsByKey.get(symbolKey);
        if (!previous || entry.confidence >= previous.confidence) {
            module.symbolsByKey.set(symbolKey, {
                symbolKey,
                sourceSymbol: entry.obfuscated,
                exportedName: exportName,
                kind: entry.kind,
                confidence: entry.confidence,
                sourceFile,
                sourceLine: parseSourceLineHint(entry.sourceFile),
                reference: referenceValue,
                rationale: [...entry.rationale],
            });
        }
    }
    const modules = Array.from(moduleIndex.values())
        .map((module) => {
        const sourceFile = pickPrimarySourceFile(module.sourceScores);
        const symbols = Array.from(module.symbolsByKey.values()).sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            if (a.kind !== b.kind)
                return a.kind.localeCompare(b.kind);
            return a.exportedName.localeCompare(b.exportedName);
        });
        const rationale = Array.from(module.rationale).sort((a, b) => a.localeCompare(b));
        const references = Array.from(module.references).sort((a, b) => a.localeCompare(b));
        const resolvedSource = sourceFile.length > 0 ? sourceFile : symbols[0]?.sourceFile ?? "";
        const resolvedConfidence = Math.max(module.confidence, symbols[0]?.confidence ?? 0);
        return {
            modulePath: module.modulePath,
            ownerLayer: classifyLayerFromTargetPath(module.modulePath),
            sourceFile: resolvedSource,
            confidence: resolvedConfidence,
            symbols,
            references,
            rationale,
        };
    })
        .filter((module) => module.sourceFile.length > 0)
        .sort((a, b) => a.modulePath.localeCompare(b.modulePath));
    return {
        generatedAtUtc: new Date().toISOString(),
        modules,
    };
}
