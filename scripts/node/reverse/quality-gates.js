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
exports.enforceQualityGates = enforceQualityGates;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const regression_config_1 = require("./regression-config");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function readUtf8(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function readJson(filePath) {
    return JSON.parse(readUtf8(filePath));
}
function resolveHistoryPath(repoRoot) {
    return path.resolve(repoRoot, regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedSymbolsHistoryFile);
}
function loadMappedSymbolsHistory(historyPath) {
    if (!fs.existsSync(historyPath)) {
        return { version: 1, byApp: {} };
    }
    const parsed = readJson(historyPath);
    if (parsed.version !== 1 || typeof parsed.byApp !== "object" || Array.isArray(parsed.byApp)) {
        throw new Error(`Invalid mapped-symbols history format: ${toPosixPath(historyPath)}`);
    }
    return parsed;
}
function saveMappedSymbolsHistory(historyPath, history) {
    writeJson(historyPath, history);
}
function normalizeAppHistoryKey(appDir) {
    return toPosixPath(path.resolve(appDir)).toLowerCase();
}
function loadProjectMappingRows(projectRoot) {
    const chunkArtifactsPath = path.join(projectRoot, "mapping", "chunk-artifacts.json");
    const chunkTsBridgesPath = path.join(projectRoot, "mapping", "chunk-ts-bridges.json");
    const reconstructedMapPath = path.join(projectRoot, "mapping", "reconstructed-map.json");
    const lifterDiagnosticsPath = path.join(projectRoot, "mapping", "lifter-diagnostics.json");
    if (!fs.existsSync(chunkArtifactsPath)) {
        throw new Error(`Missing chunk artifact map: ${toPosixPath(chunkArtifactsPath)}`);
    }
    if (!fs.existsSync(chunkTsBridgesPath)) {
        throw new Error(`Missing chunk TS bridge map: ${toPosixPath(chunkTsBridgesPath)}`);
    }
    if (!fs.existsSync(reconstructedMapPath)) {
        throw new Error(`Missing reconstructed map: ${toPosixPath(reconstructedMapPath)}`);
    }
    if (!fs.existsSync(lifterDiagnosticsPath)) {
        throw new Error(`Missing lifter diagnostics: ${toPosixPath(lifterDiagnosticsPath)}`);
    }
    return {
        chunkArtifacts: readJson(chunkArtifactsPath),
        chunkTsBridges: readJson(chunkTsBridgesPath),
        reconstructed: readJson(reconstructedMapPath),
        lifterDiagnostics: readJson(lifterDiagnosticsPath),
    };
}
function isGenericNoisePath(value) {
    const normalized = toPosixPath(value).replace(/^\.?\//, "");
    const generic = new Set(regression_config_1.REVERSE_QUALITY_GATE_TARGETS.genericPathNoiseSegments.map((item) => item.toLowerCase()));
    const ext = path.posix.extname(normalized).toLowerCase();
    const stem = path.posix.basename(normalized, ext).toLowerCase();
    if (generic.has(stem))
        return true;
    const segments = normalized.split("/").map((segment) => segment.toLowerCase());
    for (const segment of segments) {
        if (generic.has(segment))
            return true;
    }
    return false;
}
function hasAllowedTargetPrefix(value) {
    const normalized = toPosixPath(value).replace(/^\.?\//, "");
    return regression_config_1.REVERSE_QUALITY_GATE_TARGETS.allowedTargetPrefixes.some((prefix) => normalized.startsWith(prefix));
}
function countLowConfidenceSymbols(report) {
    return report.entries.filter((entry) => (entry.kind === "class" || entry.kind === "function") && entry.confidence < 0.65).length;
}
function countNoisySymbolNames(report) {
    return report.entries.filter((entry) => {
        if (entry.kind !== "class" && entry.kind !== "function")
            return false;
        const name = entry.deobfuscated;
        if (/(Ref\d+$|N\d+$|Line\d+$)/i.test(name))
            return true;
        if (/(SrcMain|SrcRenderer|SrcServices|SrcTauri)/i.test(name))
            return true;
        if (/(V\d+){2,}$/i.test(name))
            return true;
        return false;
    }).length;
}
function validateChunkArtifacts(projectRoot, chunkArtifacts, chunkTsBridges, reconstructed) {
    const failures = [];
    const genericNoisePaths = [];
    const sourceSet = new Set();
    const artifactSet = new Set();
    for (const row of chunkArtifacts) {
        sourceSet.add(row.sourceFile);
        artifactSet.add(row.artifactPath);
    }
    if (sourceSet.size !== chunkArtifacts.length) {
        failures.push("chunk-artifacts contains duplicate sourceFile rows");
    }
    if (artifactSet.size !== chunkArtifacts.length) {
        failures.push("chunk-artifacts contains duplicate artifactPath rows");
    }
    const artifactBySource = new Map();
    for (const row of chunkArtifacts)
        artifactBySource.set(row.sourceFile, row.artifactPath);
    const artifactPathSet = new Set(chunkArtifacts.map((row) => toPosixPath(row.artifactPath)));
    const bridgeWrapperSet = new Set();
    for (const bridge of chunkTsBridges) {
        const wrapperPath = toPosixPath(bridge.chunkTsWrapperPath);
        if (bridgeWrapperSet.has(wrapperPath)) {
            failures.push(`chunk-ts-bridges contains duplicate wrapper path: ${wrapperPath}`);
            continue;
        }
        bridgeWrapperSet.add(wrapperPath);
        if (!artifactPathSet.has(toPosixPath(bridge.chunkArtifactPath))) {
            failures.push(`chunk-ts-bridge references unknown chunk artifact: ${bridge.chunkArtifactPath}`);
        }
        const wrapperAbsPath = path.join(projectRoot, ...wrapperPath.split("/"));
        if (!fs.existsSync(wrapperAbsPath) || !fs.statSync(wrapperAbsPath).isFile()) {
            failures.push(`missing chunk-ts wrapper file: ${toPosixPath(wrapperAbsPath)}`);
            continue;
        }
        const wrapperSource = readUtf8(wrapperAbsPath);
        if (!/\bexport\s+\*\s+from\s+["'][^"']+["']/.test(wrapperSource)) {
            failures.push(`chunk-ts wrapper missing re-export: ${wrapperPath}`);
        }
    }
    for (const row of reconstructed) {
        if (!hasAllowedTargetPrefix(row.emittedPath)) {
            failures.push(`reconstructed target outside TS-first layers: ${row.emittedPath}`);
        }
        if (isGenericNoisePath(row.emittedPath))
            genericNoisePaths.push(row.emittedPath);
        const expectedArtifact = artifactBySource.get(row.sourceFile);
        if (!expectedArtifact) {
            failures.push(`reconstructed map references unknown source chunk: ${row.sourceFile}`);
            continue;
        }
        if (toPosixPath(expectedArtifact) !== toPosixPath(row.chunkArtifactPath)) {
            failures.push(`chunk artifact mismatch for ${row.sourceFile}`);
        }
        const emittedAbsPath = path.join(projectRoot, row.emittedPath);
        if (!fs.existsSync(emittedAbsPath) || !fs.statSync(emittedAbsPath).isFile()) {
            failures.push(`missing reconstructed module file: ${toPosixPath(emittedAbsPath)}`);
            continue;
        }
        const source = readUtf8(emittedAbsPath);
        if (/\bfrom\s+["'][^"']+\.js["']/.test(source) || /\brequire\(\s*["'][^"']+\.js["']\s*\)/.test(source)) {
            failures.push(`reconstructed module still has direct .js import: ${row.emittedPath}`);
        }
        if (/\bfrom\s+["'][^"']*\/chunks\/[^"']*["']/.test(source) || /\brequire\(\s*["'][^"']*\/chunks\/[^"']*["']\s*\)/.test(source)) {
            failures.push(`reconstructed module still imports raw chunk artifacts directly: ${row.emittedPath}`);
        }
        if (source.includes("import * as chunkModule from")) {
            failures.push(`reconstructed module still uses wrapper chunk import: ${row.emittedPath}`);
        }
        if (source.includes("pickChunkSymbol(")) {
            failures.push(`reconstructed module still uses pickChunkSymbol wrapper: ${row.emittedPath}`);
        }
        if (source.includes("export default chunk;")) {
            failures.push(`reconstructed module still exports default chunk wrapper: ${row.emittedPath}`);
        }
        const hasNamedOrDefaultExport = /\bexport\s+\{/.test(source) || /\bexport\s+(?:\*|default|const|let|var|function|class)\b/.test(source);
        if (!hasNamedOrDefaultExport) {
            failures.push(`reconstructed module is missing exports: ${row.emittedPath}`);
        }
    }
    return {
        failures,
        genericNoisePaths: Array.from(new Set(genericNoisePaths)).sort((a, b) => a.localeCompare(b)),
        uniqueSource: sourceSet.size,
        uniqueArtifact: artifactSet.size,
    };
}
function enforceQualityGates(input) {
    const failures = [];
    const mappedFiles = input.deobfuscationTable.coverage.mappedFiles;
    const mappedSymbols = input.deobfuscationTable.coverage.mappedSymbols;
    const lowConfidenceSymbols = countLowConfidenceSymbols(input.deobfuscationTable);
    const noisySymbolNames = countNoisySymbolNames(input.deobfuscationTable);
    if (mappedFiles < regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin || mappedFiles > regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax) {
        failures.push(`mappedFiles out of gate range: ${mappedFiles} (expected ${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin}-${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax})`);
    }
    if (mappedSymbols < regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedSymbolsMin) {
        failures.push(`mappedSymbols below gate floor: ${mappedSymbols} (expected >= ${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedSymbolsMin})`);
    }
    if (lowConfidenceSymbols > regression_config_1.REVERSE_QUALITY_GATE_TARGETS.lowConfidenceSymbolsMax) {
        failures.push(`low-confidence symbol count above gate ceiling: ${lowConfidenceSymbols} (expected <= ${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.lowConfidenceSymbolsMax})`);
    }
    if (noisySymbolNames > regression_config_1.REVERSE_QUALITY_GATE_TARGETS.noisySymbolNamesMax) {
        failures.push(`noisy symbol-name count above gate ceiling: ${noisySymbolNames} (expected <= ${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.noisySymbolNamesMax})`);
    }
    if (!input.projectChecks.install.success) {
        failures.push("generated project gate failed: npm install is not successful");
    }
    if (input.projectChecks.tsc.errors > 0) {
        failures.push(`generated project gate failed: tsc errors=${input.projectChecks.tsc.errors}`);
    }
    if (input.projectChecks.eslint.errors > 0 || input.projectChecks.eslint.warnings > 0) {
        failures.push(`generated project gate failed: eslint errors=${input.projectChecks.eslint.errors}, warnings=${input.projectChecks.eslint.warnings}`);
    }
    const historyPath = resolveHistoryPath(input.repoRoot);
    const appKey = normalizeAppHistoryKey(input.appDir);
    const history = loadMappedSymbolsHistory(historyPath);
    const previousMappedSymbols = history.byApp[appKey]?.mappedSymbols ?? 0;
    if (previousMappedSymbols > 0 && mappedSymbols < previousMappedSymbols) {
        failures.push(`mappedSymbols regression: ${mappedSymbols} < previous ${previousMappedSymbols}`);
    }
    const mappingRows = loadProjectMappingRows(input.projectRoot);
    const placeholderModules = mappingRows.lifterDiagnostics.filter((row) => row.placeholderMode).length;
    if (placeholderModules > regression_config_1.REVERSE_QUALITY_GATE_TARGETS.placeholderModulesMax) {
        failures.push(`placeholder modules above gate ceiling: ${placeholderModules} (expected <= ${regression_config_1.REVERSE_QUALITY_GATE_TARGETS.placeholderModulesMax})`);
    }
    const artifactValidation = validateChunkArtifacts(input.projectRoot, mappingRows.chunkArtifacts, mappingRows.chunkTsBridges, mappingRows.reconstructed);
    failures.push(...artifactValidation.failures);
    if (artifactValidation.genericNoisePaths.length > 0) {
        failures.push(`generic-path noise detected in reconstructed outputs: ${artifactValidation.genericNoisePaths.join(", ")}`);
    }
    const report = {
        generatedAtUtc: new Date().toISOString(),
        profile: "reverse-quality-gates-v1",
        passed: failures.length === 0,
        metrics: {
            mappedFiles,
            mappedSymbols,
            lowConfidenceSymbols,
            noisySymbolNames,
            placeholderModules,
            previousMappedSymbols,
            genericNoisePaths: artifactValidation.genericNoisePaths,
            installSuccess: input.projectChecks.install.success,
            tscErrors: input.projectChecks.tsc.errors,
            eslintErrors: input.projectChecks.eslint.errors,
            eslintWarnings: input.projectChecks.eslint.warnings,
            chunkArtifactRows: mappingRows.chunkArtifacts.length,
            chunkArtifactUniqueSource: artifactValidation.uniqueSource,
            chunkArtifactUniqueArtifact: artifactValidation.uniqueArtifact,
            reconstructedRows: mappingRows.reconstructed.length,
        },
        targets: {
            mappedFilesMin: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMin,
            mappedFilesMax: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedFilesMax,
            mappedSymbolsMin: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.mappedSymbolsMin,
            lowConfidenceSymbolsMax: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.lowConfidenceSymbolsMax,
            noisySymbolNamesMax: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.noisySymbolNamesMax,
            placeholderModulesMax: regression_config_1.REVERSE_QUALITY_GATE_TARGETS.placeholderModulesMax,
            allowedTargetPrefixes: [...regression_config_1.REVERSE_QUALITY_GATE_TARGETS.allowedTargetPrefixes],
        },
        failures,
    };
    if (!report.passed) {
        return report;
    }
    history.byApp[appKey] = {
        mappedSymbols,
        updatedAtUtc: report.generatedAtUtc,
        outDir: toPosixPath(path.resolve(input.outDir)),
    };
    saveMappedSymbolsHistory(historyPath, history);
    return report;
}
