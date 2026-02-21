import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { ensureDir, removePath } from "../lib/exec";
import { normalizeDeobfSourceFile, toProjectRelativeTargetPath } from "./deobfuscation-report";
import type { DeobfuscationTableReport } from "./match-v2";

export interface WebStormTestProjectReport {
  rootPath: string;
  chunkFiles: number;
  reconstructedFiles: number;
  mappedTargets: number;
  mappingArtifacts: string[];
  checks: {
    install: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      durationMs: number;
      outputPreview: string[];
    };
    tsc: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      errors: number;
      warnings: number;
      outputPreview: string[];
    };
    eslint: {
      attempted: boolean;
      success: boolean;
      exitCode: number;
      errors: number;
      warnings: number;
      outputPreview: string[];
      skippedReason: string;
    };
  };
}

export interface BuildWebStormTestProjectInput {
  outDir: string;
  appDir: string;
  decompiledDir: string;
  jsFiles: Array<{ relPath: string }>;
  shouldIncludeChunk: (relPath: string) => boolean;
  sourcePackage: { name?: string; version?: string; main?: string };
  deobfuscationTable: DeobfuscationTableReport;
  deobfuscationMarkdown: string;
  deobfuscationCsv: string;
  renamePlanMarkdown: string;
  componentBoundaries: unknown;
  sessionFlow: unknown;
  sessionFlowMarkdown: string;
  routeBoundaryGraph: unknown;
  referenceParityGaps: unknown;
  runtimeProbe: unknown;
  referenceModel: unknown;
  referenceSignals: unknown;
  referenceSymbols: unknown;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSourceForPrint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
}

function collectOutputPreview(stdout: string, stderr: string, maxLines: number): string[] {
  const joined = `${stdout}\n${stderr}`
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 420 ? `${line.slice(0, 420)}...` : line));
  return joined.slice(0, maxLines);
}

function countMatches(lines: string[], pattern: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (pattern.test(line)) count += 1;
  }
  return count;
}

function countMatchesInText(text: string, pattern: RegExp): number {
  const lines = text.split(/\r?\n/g);
  return countMatches(lines, pattern);
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function runShellCommandSync(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): ReturnType<typeof spawnSync> {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", input.command], {
      cwd: input.cwd,
      encoding: "utf8",
      timeout: input.timeoutMs,
      windowsHide: true,
    });
  }
  return spawnSync("sh", ["-lc", input.command], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: input.timeoutMs,
    windowsHide: true,
  });
}

function runNodeScriptSync(input: {
  scriptPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [input.scriptPath, ...input.args], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: input.timeoutMs,
    windowsHide: true,
  });
}

function asText(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  return value.toString("utf8");
}

function runGeneratedProjectChecks(projectRoot: string): WebStormTestProjectReport["checks"] {
  const installStart = Date.now();
  const installResult = runShellCommandSync({
    command: "npm install --no-audit --no-fund",
    cwd: projectRoot,
    timeoutMs: 300000,
  });
  const installDurationMs = Date.now() - installStart;
  const installErrorLine =
    installResult.error instanceof Error ? `spawn-error: ${installResult.error.message}` : "";
  const installPreview = collectOutputPreview(
    `${asText(installResult.stdout)}\n${installErrorLine}`,
    asText(installResult.stderr),
    30,
  );
  const installSuccess = installResult.status === 0;

  const checks: WebStormTestProjectReport["checks"] = {
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
  const tscResult =
    tscBin.length > 0
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
  const eslintArgs = ["src/**/*.{js,mjs,cjs,ts,tsx}", "--format", "json"];
  const eslintResult =
    eslintBin.length > 0
      ? runNodeScriptSync({
          scriptPath: eslintBin,
          args: eslintArgs,
          cwd: projectRoot,
          timeoutMs: 240000,
        })
      : runShellCommandSync({
          command: "npm exec --yes --package eslint@9.20.0 -- eslint src/**/*.{js,mjs,cjs,ts,tsx} --format json",
          cwd: projectRoot,
          timeoutMs: 240000,
        });
  const eslintStdout = asText(eslintResult.stdout);
  const eslintStderr = asText(eslintResult.stderr);
  const eslintPreview = collectOutputPreview(eslintStdout, eslintStderr, 40);

  let eslintErrors = 0;
  let eslintWarnings = 0;
  try {
    const parsed = JSON.parse(eslintStdout || "[]") as Array<{
      errorCount?: number;
      warningCount?: number;
      fatalErrorCount?: number;
    }>;
    for (const row of parsed) {
      eslintErrors += (row.errorCount ?? 0) + (row.fatalErrorCount ?? 0);
      eslintWarnings += row.warningCount ?? 0;
    }
  } catch {
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

export function buildWebStormTestProject(input: BuildWebStormTestProjectInput): WebStormTestProjectReport {
  const projectRoot = path.join(input.outDir, "project");
  removePath(projectRoot);
  ensureDir(projectRoot);

  const srcRoot = ensureDir(path.join(projectRoot, "src"));
  const chunksRoot = ensureDir(path.join(srcRoot, "chunks"));
  const reconstructedRoot = ensureDir(path.join(srcRoot, "reconstructed"));
  const mappingRoot = ensureDir(path.join(projectRoot, "mapping"));
  const metaRoot = ensureDir(path.join(projectRoot, "meta"));
  const toolsRoot = ensureDir(path.join(projectRoot, "tools"));

  let chunkFiles = 0;
  for (const file of input.jsFiles) {
    if (!input.shouldIncludeChunk(file.relPath)) continue;
    const sourcePath = path.join(input.decompiledDir, file.relPath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    const destinationPath = path.join(chunksRoot, file.relPath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
    chunkFiles += 1;
  }

  type ReconstructedTargetRow = {
    targetPath: string;
    sourceFile: string;
    confidence: number;
    symbols: Set<string>;
    references: Set<string>;
    rationale: Set<string>;
  };
  const byTargetPath = new Map<string, ReconstructedTargetRow>();

  const upsertTarget = (inputRow: {
    targetPath: string;
    sourceFile: string;
    confidence: number;
    symbol: string;
    reference: string;
    rationale: string[];
  }): void => {
    const targetPath = toProjectRelativeTargetPath(inputRow.targetPath);
    const sourceFile = normalizeDeobfSourceFile(inputRow.sourceFile);
    if (sourceFile.length === 0) return;
    const current = byTargetPath.get(targetPath);
    const chosenSourceFile =
      !current || inputRow.confidence > current.confidence ? sourceFile : current.sourceFile;
    const chosenConfidence = !current ? inputRow.confidence : Math.max(current.confidence, inputRow.confidence);
    const row: ReconstructedTargetRow = current ?? {
      targetPath,
      sourceFile: chosenSourceFile,
      confidence: chosenConfidence,
      symbols: new Set<string>(),
      references: new Set<string>(),
      rationale: new Set<string>(),
    };
    row.sourceFile = chosenSourceFile;
    row.confidence = chosenConfidence;
    if (inputRow.symbol.trim().length > 0) row.symbols.add(inputRow.symbol.trim());
    if (inputRow.reference.trim().length > 0) row.references.add(inputRow.reference.trim());
    for (const reason of inputRow.rationale) {
      const normalized = reason.trim();
      if (normalized.length === 0) continue;
      row.rationale.add(normalized);
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
    });
  }

  let reconstructedFiles = 0;
  const reconstructedMapRows: Array<{
    targetPath: string;
    emittedPath: string;
    sourceFile: string;
    confidence: number;
    symbols: string[];
    references: string[];
    rationale: string[];
  }> = [];

  const sortedTargets = Array.from(byTargetPath.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  for (const row of sortedTargets) {
    const sourcePath = path.join(input.decompiledDir, row.sourceFile);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    const source = normalizeSourceForPrint(readUtf8(sourcePath));
    const headerLines = [
      "/*",
      "  Generated by reverse/deobfuscation pipeline for WebStorm exploration.",
      `  Source chunk: ${row.sourceFile}`,
      `  Confidence: ${row.confidence}`,
      `  Suggested symbols: ${Array.from(row.symbols).sort((a, b) => a.localeCompare(b)).join(", ") || "none"}`,
      `  References: ${Array.from(row.references).sort((a, b) => a.localeCompare(b)).join(", ") || "none"}`,
      "*/",
      "",
    ];
    const emittedPath = row.targetPath.replace(/\.(?:tsx?|jsx|mjs|cjs)$/i, ".js");
    const destinationPath = path.join(reconstructedRoot, emittedPath);
    ensureDir(path.dirname(destinationPath));
    fs.writeFileSync(destinationPath, `${headerLines.join("\n")}${source.endsWith("\n") ? source : `${source}\n`}`, "utf8");
    reconstructedFiles += 1;

    reconstructedMapRows.push({
      targetPath: row.targetPath,
      emittedPath,
      sourceFile: row.sourceFile,
      confidence: row.confidence,
      symbols: Array.from(row.symbols).sort((a, b) => a.localeCompare(b)),
      references: Array.from(row.references).sort((a, b) => a.localeCompare(b)),
      rationale: Array.from(row.rationale).sort((a, b) => a.localeCompare(b)),
    });
  }

  const mappingArtifacts = [
    "mapping/deobfuscation-table.json",
    "mapping/deobfuscation-table.md",
    "mapping/deobfuscation-table.csv",
    "mapping/rename-plan.md",
    "mapping/reconstructed-map.json",
    "mapping/component-boundaries.json",
    "mapping/session-flow.json",
    "mapping/session-flow.md",
    "mapping/route-boundary-graph.json",
    "mapping/reference-parity-gaps.json",
    "mapping/runtime-probe.json",
    "mapping/reference-model.json",
    "mapping/reference-signals.json",
    "mapping/reference-symbols.json",
  ];

  writeJson(path.join(mappingRoot, "deobfuscation-table.json"), input.deobfuscationTable);
  fs.writeFileSync(path.join(mappingRoot, "deobfuscation-table.md"), input.deobfuscationMarkdown, "utf8");
  fs.writeFileSync(path.join(mappingRoot, "deobfuscation-table.csv"), input.deobfuscationCsv, "utf8");
  fs.writeFileSync(path.join(mappingRoot, "rename-plan.md"), input.renamePlanMarkdown, "utf8");
  writeJson(path.join(mappingRoot, "reconstructed-map.json"), reconstructedMapRows);
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
      lint: "eslint src/**/*.{js,mjs,cjs,ts,tsx} --format json",
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
        "@chunks/*": ["src/chunks/*"],
        "@reconstructed/*": ["src/reconstructed/*"],
      },
    },
    include: ["src/**/*", "mapping/**/*.json"],
  };
  writeJson(path.join(projectRoot, "tsconfig.json"), tsconfigJson);
  writeJson(path.join(projectRoot, "jsconfig.json"), tsconfigJson);

  const eslintConfig = [
    "module.exports = [",
    "  {",
    "    files: ['src/**/*.{js,mjs,cjs,ts,tsx}'],",
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

  fs.writeFileSync(
    path.join(projectRoot, ".gitignore"),
    "node_modules/\n.idea/\n.DS_Store\n",
    "utf8",
  );

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
    "- `src/chunks/` original decompiled JS chunks (core/deobf candidates).",
    "- `src/reconstructed/` files placed by deobfuscation target paths with source headers.",
    "- `mapping/` all generated maps and flow reports.",
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
