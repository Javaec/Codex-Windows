"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDeobfSourceFile = normalizeDeobfSourceFile;
exports.formatDeobfuscationTableMarkdown = formatDeobfuscationTableMarkdown;
exports.formatDeobfuscationTableCsv = formatDeobfuscationTableCsv;
exports.formatRenamePlanMarkdown = formatRenamePlanMarkdown;
exports.toProjectRelativeTargetPath = toProjectRelativeTargetPath;
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function toCsvCell(value) {
    const text = String(value);
    if (!/[",\r\n]/.test(text))
        return text;
    return `"${text.replace(/"/g, "\"\"")}"`;
}
function normalizeDeobfSourceFile(value) {
    const match = value.match(/^(.*):(\d+)$/);
    if (!match)
        return value;
    return match[1];
}
function classifyDeobfPriority(confidence) {
    if (confidence >= 0.82)
        return "P1";
    if (confidence >= 0.7)
        return "P2";
    return "P3";
}
function formatDeobfuscationTableMarkdown(report) {
    const rows = [];
    rows.push("# Deobfuscation Table");
    rows.push("");
    rows.push("## Method");
    rows.push(`- ${report.strategy}`);
    rows.push(`- Reference symbols loaded: ${report.referenceInputs.loaded ? "yes" : "no"} (${report.referenceInputs.symbolCount})`);
    rows.push(`- Files scanned: ${report.coverage.filesScanned}`);
    rows.push(`- Obfuscated file candidates: ${report.coverage.obfuscatedFileCandidates}`);
    rows.push(`- Obfuscated symbol candidates: ${report.coverage.obfuscatedSymbolCandidates}`);
    rows.push(`- Mapped files: ${report.coverage.mappedFiles}`);
    rows.push(`- Mapped symbols: ${report.coverage.mappedSymbols}`);
    rows.push("");
    rows.push("## File Relocation Plan");
    if (report.filePlans.length === 0) {
        rows.push("- _none_");
    }
    else {
        rows.push("| Source File | Proposed Module Path | Confidence | Reference |");
        rows.push("| --- | --- | ---: | --- |");
        for (const plan of report.filePlans) {
            rows.push(`| \`${plan.sourceFile}\` | \`${plan.proposedModulePath}\` | ${plan.confidence} | ${plan.referenceSource} |`);
        }
    }
    rows.push("");
    rows.push("## Symbol Mapping");
    if (report.entries.length === 0) {
        rows.push("- _none_");
    }
    else {
        rows.push("| Kind | Obfuscated | Deobfuscated | Source | Target Path | Confidence | Reference |");
        rows.push("| --- | --- | --- | --- | --- | ---: | --- |");
        for (const entry of report.entries) {
            rows.push(`| ${entry.kind} | \`${entry.obfuscated}\` | \`${entry.deobfuscated}\` | \`${entry.sourceFile}\` | \`${entry.targetProjectPath}\` | ${entry.confidence} | ${entry.reference.source}:${entry.reference.symbol} |`);
        }
    }
    rows.push("");
    rows.push(`_Generated at ${report.generatedAtUtc}_`);
    rows.push("");
    return rows.join("\n");
}
function formatDeobfuscationTableCsv(report) {
    const header = [
        "id",
        "kind",
        "priority",
        "source_file",
        "obfuscated",
        "deobfuscated",
        "target_project_path",
        "confidence",
        "reference_source",
        "reference_symbol",
        "reference_file",
        "reference_kind",
        "reference_score",
        "rationale",
    ];
    const lines = [header.map((cell) => toCsvCell(cell)).join(",")];
    for (const entry of report.entries) {
        const row = [
            entry.id,
            entry.kind,
            classifyDeobfPriority(entry.confidence),
            normalizeDeobfSourceFile(entry.sourceFile),
            entry.obfuscated,
            entry.deobfuscated,
            entry.targetProjectPath,
            entry.confidence,
            entry.reference.source,
            entry.reference.symbol,
            entry.reference.file,
            entry.reference.kind,
            entry.reference.score,
            entry.rationale.join(" | "),
        ];
        lines.push(row.map((cell) => toCsvCell(cell)).join(","));
    }
    return `${lines.join("\n")}\n`;
}
function formatRenamePlanMarkdown(report) {
    const rows = [];
    rows.push("# Rename Plan");
    rows.push("");
    rows.push("## Scope");
    rows.push(`- source strategy: ${report.strategy}`);
    rows.push(`- generated at: ${report.generatedAtUtc}`);
    rows.push(`- file relocation candidates: ${report.filePlans.length}`);
    rows.push(`- symbol rename candidates: ${report.entries.filter((entry) => entry.kind !== "file").length}`);
    rows.push("");
    rows.push("## Step 1. File Relocation");
    if (report.filePlans.length === 0) {
        rows.push("- _none_");
    }
    else {
        rows.push("| Priority | Source File | Target Module Path | Confidence | Reference | Rationale |");
        rows.push("| --- | --- | --- | ---: | --- | --- |");
        for (const plan of report.filePlans) {
            rows.push(`| ${classifyDeobfPriority(plan.confidence)} | \`${plan.sourceFile}\` | \`${plan.proposedModulePath}\` | ${plan.confidence} | ${plan.referenceSource} | ${plan.rationale.join("; ")} |`);
        }
    }
    const symbolCandidates = new Map();
    for (const entry of report.entries) {
        if (entry.kind === "file")
            continue;
        const sourceFile = normalizeDeobfSourceFile(entry.sourceFile);
        const key = `${sourceFile}|${entry.kind}|${entry.deobfuscated}|${entry.targetProjectPath}`;
        const existing = symbolCandidates.get(key);
        if (!existing || entry.confidence > existing.confidence) {
            symbolCandidates.set(key, {
                sourceFile,
                kind: entry.kind,
                obfuscated: entry.obfuscated,
                deobfuscated: entry.deobfuscated,
                targetProjectPath: entry.targetProjectPath,
                confidence: entry.confidence,
                reference: entry.reference,
                rationale: entry.rationale,
            });
        }
    }
    const sortedSymbols = Array.from(symbolCandidates.values()).sort((a, b) => {
        if (a.confidence !== b.confidence)
            return b.confidence - a.confidence;
        if (a.sourceFile !== b.sourceFile)
            return a.sourceFile.localeCompare(b.sourceFile);
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        return a.obfuscated.localeCompare(b.obfuscated);
    });
    rows.push("");
    rows.push("## Step 2. Class/Function Rename");
    if (sortedSymbols.length === 0) {
        rows.push("- _none_");
    }
    else {
        rows.push("| Priority | Source File | Kind | Obfuscated | Deobfuscated | Target Path | Confidence | Reference | Rationale |");
        rows.push("| --- | --- | --- | --- | --- | --- | ---: | --- | --- |");
        for (const entry of sortedSymbols) {
            rows.push(`| ${classifyDeobfPriority(entry.confidence)} | \`${entry.sourceFile}\` | ${entry.kind} | \`${entry.obfuscated}\` | \`${entry.deobfuscated}\` | \`${entry.targetProjectPath}\` | ${entry.confidence} | ${entry.reference.source}:${entry.reference.symbol} | ${entry.rationale.join("; ")} |`);
        }
    }
    rows.push("");
    rows.push("## Step 3. Re-run Reverse");
    rows.push("- re-run reverse after applying P1/P2 changes and compare `deobfuscation-table.json` diff.");
    rows.push("- keep only stable mappings that persist across multiple runtime probes.");
    rows.push("");
    return rows.join("\n");
}
function toProjectRelativeTargetPath(targetProjectPath) {
    const normalized = toPosixPath(targetProjectPath).replace(/^\.?\//, "");
    const withoutReconstructed = normalized.replace(/^reconstructed\//, "");
    const sourceRelative = withoutReconstructed.startsWith("src-tauri/src/")
        ? withoutReconstructed.replace(/^src-tauri\/src\//, "tauri/")
        : withoutReconstructed.startsWith("src/")
            ? withoutReconstructed.replace(/^src\//, "")
            : withoutReconstructed;
    let compact = sourceRelative;
    compact = compact.replace(/^main\/lib\//, "main/");
    compact = compact.replace(/^renderer\/features\/([^/]+)\/main\//, "renderer/$1/");
    compact = compact.replace(/^renderer\/features\/([^/]+)\/lib\//, "renderer/$1/lib/");
    compact = compact.replace(/^renderer\/features\/([^/]+)\/ui\//, "renderer/$1/ui/");
    compact = compact.replace(/^renderer\/features\/([^/]+)\//, "renderer/$1/");
    return compact.length > 0 ? compact : "unknown/module.js";
}
