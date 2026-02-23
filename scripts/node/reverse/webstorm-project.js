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
exports.buildWebStormTestProject = buildWebStormTestProject;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const exec_1 = require("../lib/exec");
const deobfuscation_report_1 = require("./deobfuscation-report");
const symbol_lifter_1 = require("./symbol-lifter");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function writeJson(filePath, data) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
function readUtf8(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
function normalizeSourceForPrint(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\n\/\/# sourceMappingURL=.*$/gm, "")
        .replace(/\n\/\*# sourceMappingURL=.*\*\/$/gm, "");
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
function toChunkArtifactPath(sourceFile) {
    const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}
function normalizeTargetModulePath(targetPath) {
    const normalized = toPosixPath(targetPath).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:tsx?|jsx|mjs|cjs|js)$/i, ".ts");
}
function toSafeExportIdentifier(input) {
    const normalized = input.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^\d+/, "").replace(/^_+/, "");
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized))
        return normalized;
    return "symbol_export";
}
function collectOutputPreview(stdout, stderr, maxLines) {
    const joined = `${stdout}\n${stderr}`
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => (line.length > 420 ? `${line.slice(0, 420)}...` : line));
    return joined.slice(0, maxLines);
}
function countMatches(lines, pattern) {
    let count = 0;
    for (const line of lines) {
        if (pattern.test(line))
            count += 1;
    }
    return count;
}
function countMatchesInText(text, pattern) {
    const lines = text.split(/\r?\n/g);
    return countMatches(lines, pattern);
}
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
function runShellCommandSync(input) {
    if (process.platform === "win32") {
        return (0, node_child_process_1.spawnSync)("cmd.exe", ["/d", "/s", "/c", input.command], {
            cwd: input.cwd,
            encoding: "utf8",
            timeout: input.timeoutMs,
            windowsHide: true,
        });
    }
    return (0, node_child_process_1.spawnSync)("sh", ["-lc", input.command], {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        windowsHide: true,
    });
}
function runNodeScriptSync(input) {
    return (0, node_child_process_1.spawnSync)(process.execPath, [input.scriptPath, ...input.args], {
        cwd: input.cwd,
        encoding: "utf8",
        timeout: input.timeoutMs,
        windowsHide: true,
    });
}
function asText(value) {
    if (typeof value === "string")
        return value;
    if (!value)
        return "";
    return value.toString("utf8");
}
function runGeneratedProjectChecks(projectRoot) {
    const installStart = Date.now();
    const installResult = runShellCommandSync({
        command: "npm install --no-audit --no-fund",
        cwd: projectRoot,
        timeoutMs: 300000,
    });
    const installDurationMs = Date.now() - installStart;
    const installErrorLine = installResult.error instanceof Error ? `spawn-error: ${installResult.error.message}` : "";
    const installPreview = collectOutputPreview(`${asText(installResult.stdout)}\n${installErrorLine}`, asText(installResult.stderr), 30);
    const installSuccess = installResult.status === 0;
    const checks = {
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
    const tscResult = tscBin.length > 0
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
    const eslintArgs = ["src/**/*.{js,mjs,cjs,ts,tsx}", "src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx}", "--format", "json"];
    const eslintResult = eslintBin.length > 0
        ? runNodeScriptSync({
            scriptPath: eslintBin,
            args: eslintArgs,
            cwd: projectRoot,
            timeoutMs: 240000,
        })
        : runShellCommandSync({
            command: "npm exec --yes --package eslint@9.20.0 -- eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json",
            cwd: projectRoot,
            timeoutMs: 240000,
        });
    const eslintStdout = asText(eslintResult.stdout);
    const eslintStderr = asText(eslintResult.stderr);
    const eslintPreview = collectOutputPreview(eslintStdout, eslintStderr, 40);
    let eslintErrors = 0;
    let eslintWarnings = 0;
    try {
        const parsed = JSON.parse(eslintStdout || "[]");
        for (const row of parsed) {
            eslintErrors += (row.errorCount ?? 0) + (row.fatalErrorCount ?? 0);
            eslintWarnings += row.warningCount ?? 0;
        }
    }
    catch {
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
function buildWebStormTestProject(input) {
    const projectRoot = path.join(input.outDir, "project");
    (0, exec_1.removePath)(projectRoot);
    (0, exec_1.ensureDir)(projectRoot);
    const srcRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "src"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "main"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "renderer"));
    (0, exec_1.ensureDir)(path.join(srcRoot, "services"));
    (0, exec_1.ensureDir)(path.join(projectRoot, "src-tauri-adapter"));
    const mappingRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "mapping"));
    const rawChunksRoot = (0, exec_1.ensureDir)(path.join(mappingRoot, "raw-chunks"));
    const metaRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "meta"));
    const toolsRoot = (0, exec_1.ensureDir)(path.join(projectRoot, "tools"));
    const chunkArtifactBySourceFile = new Map();
    const chunkSourceBySourceFile = new Map();
    let chunkFiles = 0;
    for (const file of input.jsFiles) {
        if (!input.shouldIncludeChunk(file.relPath))
            continue;
        const sourcePath = path.join(input.decompiledDir, file.relPath);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
            continue;
        const chunkArtifactPath = toChunkArtifactPath(file.relPath);
        const destinationPath = path.join(rawChunksRoot, chunkArtifactPath);
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
        const source = normalizeSourceForPrint(readUtf8(sourcePath));
        const normalizedSource = source.endsWith("\n") ? source : `${source}\n`;
        fs.writeFileSync(destinationPath, normalizedSource, "utf8");
        chunkArtifactBySourceFile.set(file.relPath, toPosixPath(path.posix.join("mapping", "raw-chunks", chunkArtifactPath)));
        chunkSourceBySourceFile.set(file.relPath, normalizedSource);
        chunkFiles += 1;
    }
    const byTargetPath = new Map();
    const upsertTarget = (inputRow) => {
        const targetPath = (0, deobfuscation_report_1.toProjectRelativeTargetPath)(inputRow.targetPath);
        const sourceFile = (0, deobfuscation_report_1.normalizeDeobfSourceFile)(inputRow.sourceFile);
        if (sourceFile.length === 0)
            return;
        const current = byTargetPath.get(targetPath);
        const chosenSourceFile = !current || inputRow.confidence > current.confidence ? sourceFile : current.sourceFile;
        const chosenConfidence = !current ? inputRow.confidence : Math.max(current.confidence, inputRow.confidence);
        const row = current ?? {
            targetPath,
            sourceFile: chosenSourceFile,
            confidence: chosenConfidence,
            symbols: new Set(),
            references: new Set(),
            rationale: new Set(),
            exportsByName: new Map(),
        };
        row.sourceFile = chosenSourceFile;
        row.confidence = chosenConfidence;
        if (inputRow.symbol.trim().length > 0)
            row.symbols.add(inputRow.symbol.trim());
        if (inputRow.reference.trim().length > 0)
            row.references.add(inputRow.reference.trim());
        for (const reason of inputRow.rationale) {
            const normalized = reason.trim();
            if (normalized.length === 0)
                continue;
            row.rationale.add(normalized);
        }
        if (inputRow.kind !== "file") {
            const exportName = toSafeExportIdentifier(inputRow.symbol.trim().length > 0 ? inputRow.symbol : inputRow.sourceSymbol);
            const currentExport = row.exportsByName.get(exportName);
            if (!currentExport || inputRow.confidence > currentExport.confidence) {
                row.exportsByName.set(exportName, {
                    sourceSymbol: inputRow.sourceSymbol,
                    kind: inputRow.kind,
                    sourceLine: inputRow.sourceLine,
                    confidence: inputRow.confidence,
                });
            }
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
            sourceSymbol: "",
            kind: "file",
            sourceLine: 0,
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
            sourceSymbol: entry.obfuscated,
            kind: entry.kind,
            sourceLine: parseSourceLineHint(entry.sourceFile),
        });
    }
    let reconstructedFiles = 0;
    const reconstructedMapRows = [];
    const sortedTargets = Array.from(byTargetPath.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath));
    for (const row of sortedTargets) {
        let chunkArtifactPath = chunkArtifactBySourceFile.get(row.sourceFile);
        let sourceChunk = chunkSourceBySourceFile.get(row.sourceFile);
        if (!chunkArtifactPath) {
            const sourcePath = path.join(input.decompiledDir, row.sourceFile);
            if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
                continue;
            const normalized = normalizeSourceForPrint(readUtf8(sourcePath));
            const fallbackArtifactRel = toChunkArtifactPath(row.sourceFile);
            const fallbackDestination = path.join(rawChunksRoot, fallbackArtifactRel);
            (0, exec_1.ensureDir)(path.dirname(fallbackDestination));
            const normalizedSource = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
            fs.writeFileSync(fallbackDestination, normalizedSource, "utf8");
            chunkArtifactPath = toPosixPath(path.posix.join("mapping", "raw-chunks", fallbackArtifactRel));
            chunkArtifactBySourceFile.set(row.sourceFile, chunkArtifactPath);
            chunkSourceBySourceFile.set(row.sourceFile, normalizedSource);
            sourceChunk = normalizedSource;
        }
        if (!sourceChunk) {
            throw new Error(`Missing source chunk text for reconstructed module: ${row.sourceFile}`);
        }
        const emittedPath = normalizeTargetModulePath(row.targetPath);
        const exportRows = Array.from(row.exportsByName.entries())
            .map(([name, value]) => ({ name, ...value }))
            .sort((a, b) => {
            if (a.confidence !== b.confidence)
                return b.confidence - a.confidence;
            if (a.kind !== b.kind)
                return a.kind.localeCompare(b.kind);
            return a.name.localeCompare(b.name);
        });
        const headerLines = [
            "/*",
            "  Generated by reverse/deobfuscation pipeline for WebStorm exploration.",
            "  Lift mode: ast-symbol-lifter (function/class/variable declarations + dependency closure).",
            `  Source chunk artifact: ${chunkArtifactPath}`,
            `  Source chunk: ${row.sourceFile}`,
            `  Confidence: ${row.confidence}`,
            `  Suggested symbols: ${Array.from(row.symbols).sort((a, b) => a.localeCompare(b)).join(", ") || "none"}`,
            `  References: ${Array.from(row.references).sort((a, b) => a.localeCompare(b)).join(", ") || "none"}`,
            "*/",
            "",
            "// @ts-nocheck",
            "",
        ];
        const lifted = (0, symbol_lifter_1.liftModuleSource)({
            sourceFilePath: row.sourceFile,
            sourceText: sourceChunk,
            exports: exportRows.map((item) => ({
                exportName: item.name,
                sourceSymbol: item.sourceSymbol,
                kind: item.kind,
                sourceLine: item.sourceLine,
            })),
            maxDependencyStatements: 6000,
        });
        const unresolvedRequired = lifted.unresolvedExports.filter((item) => item.kind === "class" || item.kind === "function");
        if (unresolvedRequired.length > 0) {
            for (const unresolved of unresolvedRequired) {
                row.rationale.add(`lifter-unresolved: ${unresolved.kind}:${unresolved.sourceSymbol}->${unresolved.exportName}@${unresolved.sourceLine}`);
            }
        }
        const moduleSource = `${headerLines.join("\n")}${lifted.moduleBody}`;
        const destinationPath = path.join(projectRoot, emittedPath);
        (0, exec_1.ensureDir)(path.dirname(destinationPath));
        fs.writeFileSync(destinationPath, moduleSource, "utf8");
        reconstructedFiles += 1;
        reconstructedMapRows.push({
            targetPath: row.targetPath,
            emittedPath,
            sourceFile: row.sourceFile,
            chunkArtifactPath,
            confidence: row.confidence,
            symbols: Array.from(row.symbols).sort((a, b) => a.localeCompare(b)),
            exports: exportRows.filter((item) => lifted.liftedExports.some((liftedExport) => liftedExport.exportName === item.name &&
                liftedExport.sourceSymbol === item.sourceSymbol &&
                liftedExport.kind === item.kind)),
            references: Array.from(row.references).sort((a, b) => a.localeCompare(b)),
            rationale: Array.from(row.rationale).sort((a, b) => a.localeCompare(b)),
        });
    }
    const chunkArtifactRows = Array.from(chunkArtifactBySourceFile.entries())
        .map(([sourceFile, artifactPath]) => ({ sourceFile, artifactPath }))
        .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
    const mappingArtifacts = [
        "mapping/chunk-artifacts.json",
        "mapping/raw-chunks/",
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
    writeJson(path.join(mappingRoot, "chunk-artifacts.json"), chunkArtifactRows);
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
            lint: "eslint src/**/*.{js,mjs,cjs,ts,tsx} src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx} --format json",
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
                "@main/*": ["src/main/*"],
                "@renderer/*": ["src/renderer/*"],
                "@services/*": ["src/services/*"],
                "@tauri/*": ["src-tauri-adapter/*"],
            },
        },
        include: ["src/**/*", "src-tauri-adapter/**/*", "mapping/**/*.json"],
    };
    writeJson(path.join(projectRoot, "tsconfig.json"), tsconfigJson);
    writeJson(path.join(projectRoot, "jsconfig.json"), tsconfigJson);
    const eslintConfig = [
        "module.exports = [",
        "  {",
        "    files: ['src/**/*.{js,mjs,cjs,ts,tsx}', 'src-tauri-adapter/**/*.{js,mjs,cjs,ts,tsx}'],",
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
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n.idea/\n.DS_Store\n", "utf8");
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
        "- `src/main/`, `src/renderer/`, `src/services/` TS-first reconstructed modules with lifted symbol declarations.",
        "- `src-tauri-adapter/` bridge modules for tauri/daemon-related targets.",
        "- `mapping/raw-chunks/` one raw source artifact per original chunk (`.js`) for traceability.",
        "- `mapping/` generated maps and flow reports.",
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
