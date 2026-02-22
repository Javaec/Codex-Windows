import type { DeobfuscationTableEntry, DeobfuscationTableReport } from "./match-v2";

type DeobfuscatedSymbolKind = "class" | "function" | "file";

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function toCsvCell(value: string | number | boolean): string {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export function normalizeDeobfSourceFile(value: string): string {
  const match = value.match(/^(.*):(\d+)$/);
  if (!match) return value;
  return match[1];
}

function classifyDeobfPriority(confidence: number): "P1" | "P2" | "P3" {
  if (confidence >= 0.82) return "P1";
  if (confidence >= 0.7) return "P2";
  return "P3";
}

export function formatDeobfuscationTableMarkdown(report: DeobfuscationTableReport): string {
  const rows: string[] = [];
  rows.push("# Deobfuscation Table");
  rows.push("");
  rows.push("## Method");
  rows.push(`- ${report.strategy}`);
  rows.push(`- Calibration profile: ${report.calibration.profileId}`);
  rows.push(`- Fixed regression runs: ${report.calibration.fixedRegressionRuns.join(", ") || "none"}`);
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
  } else {
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
  } else {
    rows.push("| Kind | Obfuscated | Deobfuscated | Source | Target Path | Confidence | Reference |");
    rows.push("| --- | --- | --- | --- | --- | ---: | --- |");
    for (const entry of report.entries) {
      rows.push(
        `| ${entry.kind} | \`${entry.obfuscated}\` | \`${entry.deobfuscated}\` | \`${entry.sourceFile}\` | \`${entry.targetProjectPath}\` | ${entry.confidence} | ${entry.reference.source}:${entry.reference.symbol} |`,
      );
    }
  }
  rows.push("");
  rows.push(`_Generated at ${report.generatedAtUtc}_`);
  rows.push("");
  return rows.join("\n");
}

export function formatDeobfuscationTableCsv(report: DeobfuscationTableReport): string {
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

export function formatRenamePlanMarkdown(report: DeobfuscationTableReport): string {
  const rows: string[] = [];
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
  } else {
    rows.push("| Priority | Source File | Target Module Path | Confidence | Reference | Rationale |");
    rows.push("| --- | --- | --- | ---: | --- | --- |");
    for (const plan of report.filePlans) {
      rows.push(
        `| ${classifyDeobfPriority(plan.confidence)} | \`${plan.sourceFile}\` | \`${plan.proposedModulePath}\` | ${plan.confidence} | ${plan.referenceSource} | ${plan.rationale.join("; ")} |`,
      );
    }
  }

  const symbolCandidates = new Map<
    string,
    {
      sourceFile: string;
      kind: DeobfuscatedSymbolKind;
      obfuscated: string;
      deobfuscated: string;
      targetProjectPath: string;
      confidence: number;
      reference: DeobfuscationTableEntry["reference"];
      rationale: string[];
    }
  >();

  for (const entry of report.entries) {
    if (entry.kind === "file") continue;
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
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.obfuscated.localeCompare(b.obfuscated);
  });

  rows.push("");
  rows.push("## Step 2. Class/Function Rename");
  if (sortedSymbols.length === 0) {
    rows.push("- _none_");
  } else {
    rows.push("| Priority | Source File | Kind | Obfuscated | Deobfuscated | Target Path | Confidence | Reference | Rationale |");
    rows.push("| --- | --- | --- | --- | --- | --- | ---: | --- | --- |");
    for (const entry of sortedSymbols) {
      rows.push(
        `| ${classifyDeobfPriority(entry.confidence)} | \`${entry.sourceFile}\` | ${entry.kind} | \`${entry.obfuscated}\` | \`${entry.deobfuscated}\` | \`${entry.targetProjectPath}\` | ${entry.confidence} | ${entry.reference.source}:${entry.reference.symbol} | ${entry.rationale.join("; ")} |`,
      );
    }
  }

  rows.push("");
  rows.push("## Step 3. Re-run Reverse");
  rows.push("- re-run reverse after applying P1/P2 changes and compare `deobfuscation-table.json` diff.");
  rows.push("- keep only stable mappings that persist across multiple runtime probes.");
  rows.push("");
  return rows.join("\n");
}

export function toProjectRelativeTargetPath(targetProjectPath: string): string {
  const normalizeModuleExt = (value: string): string => value.replace(/\.(?:tsx?|jsx|mjs|cjs|js)$/i, ".ts");
  const normalized = toPosixPath(targetProjectPath).replace(/^\.?\//, "");
  const withoutReconstructed = normalized.replace(/^reconstructed\//, "");
  const sourceRelative = withoutReconstructed.startsWith("src-tauri/src/")
    ? withoutReconstructed.replace(/^src-tauri\/src\//, "tauri/")
    : withoutReconstructed.startsWith("src/")
      ? withoutReconstructed.replace(/^src\//, "")
      : withoutReconstructed;

  let compact = sourceRelative
    .replace(/^main\/lib\//, "main/")
    .replace(/^renderer\/features\/([^/]+)\/main\//, "renderer/$1/")
    .replace(/^renderer\/features\/([^/]+)\/lib\//, "renderer/$1/lib/")
    .replace(/^renderer\/features\/([^/]+)\/ui\//, "renderer/$1/ui/")
    .replace(/^renderer\/features\/([^/]+)\//, "renderer/$1/");

  if (compact.startsWith("src-tauri-adapter/")) return normalizeModuleExt(compact);
  if (compact.startsWith("tauri/")) return normalizeModuleExt(`src-tauri-adapter/${compact.slice("tauri/".length)}`);
  if (compact.startsWith("main/")) return normalizeModuleExt(`src/main/${compact.slice("main/".length)}`);
  if (compact.startsWith("renderer/")) return normalizeModuleExt(`src/renderer/${compact.slice("renderer/".length)}`);
  if (compact.startsWith("services/")) return normalizeModuleExt(`src/services/${compact.slice("services/".length)}`);
  if (compact.startsWith("features/")) return normalizeModuleExt(`src/services/features/${compact.slice("features/".length)}`);
  if (compact.startsWith("shared/")) return normalizeModuleExt(`src/services/shared/${compact.slice("shared/".length)}`);
  if (compact.startsWith("utils/")) return normalizeModuleExt(`src/services/utils/${compact.slice("utils/".length)}`);
  if (compact.length === 0) compact = "unknown/module.ts";
  return normalizeModuleExt(`src/services/${compact}`);
}
