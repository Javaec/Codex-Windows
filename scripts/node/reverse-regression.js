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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const regression_config_1 = require("./reverse/regression-config");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REGRESSION_BASELINE_SCHEMA_VERSION = 1;
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function parseArgs(argv) {
    const options = {
        appDir: path.resolve(REPO_ROOT, "work", "app"),
        outRoot: path.resolve(REPO_ROOT, "work", "reverse-regression"),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i]?.toLowerCase();
        const readValue = () => {
            const next = argv[i + 1];
            if (!next || next.startsWith("-")) {
                throw new Error(`Missing value for ${argv[i]}`);
            }
            i += 1;
            return next;
        };
        if (token === "-appdir") {
            options.appDir = path.resolve(readValue());
            continue;
        }
        if (token === "-outroot") {
            options.outRoot = path.resolve(readValue());
            continue;
        }
        throw new Error(`Unknown option: ${argv[i]}`);
    }
    return options;
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function readAppSnapshotInfo(appDir) {
    const candidatePackagePaths = [
        path.join(appDir, "package.json"),
        path.join(appDir, "resources", "app", "package.json"),
    ];
    for (const packagePath of candidatePackagePaths) {
        if (!fs.existsSync(packagePath))
            continue;
        const parsed = readJson(packagePath);
        if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
            throw new Error(`Invalid app snapshot package name in ${toPosixPath(packagePath)}`);
        }
        if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
            throw new Error(`Invalid app snapshot version in ${toPosixPath(packagePath)}`);
        }
        const appName = parsed.name.trim();
        const appVersion = parsed.version.trim();
        return {
            appName,
            appVersion,
            packageJsonPath: toPosixPath(packagePath),
            snapshotKey: `${appName}@${appVersion}`,
        };
    }
    throw new Error(`App snapshot package.json is missing in ${candidatePackagePaths.map((candidate) => toPosixPath(candidate)).join(", ")}`);
}
function resolveBaselinesPath() {
    return path.resolve(REPO_ROOT, regression_config_1.REVERSE_REGRESSION_BASELINES_FILE);
}
function loadBaselineStore(baselinesPath) {
    if (!fs.existsSync(baselinesPath)) {
        return { version: REGRESSION_BASELINE_SCHEMA_VERSION, profiles: {} };
    }
    const parsed = readJson(baselinesPath);
    if (parsed.version !== REGRESSION_BASELINE_SCHEMA_VERSION) {
        throw new Error(`Unsupported regression baseline schema in ${toPosixPath(baselinesPath)}: ${parsed.version}`);
    }
    if (typeof parsed.profiles !== "object" || parsed.profiles === null || Array.isArray(parsed.profiles)) {
        throw new Error(`Invalid regression baseline profiles in ${toPosixPath(baselinesPath)}`);
    }
    return parsed;
}
function toBaselineRunMetrics(results) {
    const runs = {};
    for (const result of results) {
        runs[result.id] = {
            mappedFiles: result.mappedFiles,
            mappedSymbols: result.mappedSymbols,
        };
    }
    return runs;
}
function validateOrCreateBaselineProfile(input) {
    const existingProfile = input.store.profiles[input.snapshot.snapshotKey];
    if (!existingProfile) {
        const profile = {
            appName: input.snapshot.appName,
            appVersion: input.snapshot.appVersion,
            calibrationProfile: regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id,
            updatedAtUtc: new Date().toISOString(),
            runs: toBaselineRunMetrics(input.results),
        };
        input.store.profiles[input.snapshot.snapshotKey] = profile;
        return {
            status: "created",
            snapshot: input.snapshot,
            failures: [],
            profile,
        };
    }
    const failures = [];
    if (existingProfile.calibrationProfile !== regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id) {
        failures.push(`baseline calibration mismatch: ${existingProfile.calibrationProfile} != ${regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id}`);
    }
    for (const fixedRun of regression_config_1.FIXED_REGRESSION_RUNS) {
        const baselineRun = existingProfile.runs[fixedRun.id];
        if (!baselineRun) {
            failures.push(`baseline is missing fixed run ${fixedRun.id}`);
            continue;
        }
        const result = input.results.find((row) => row.id === fixedRun.id);
        if (!result) {
            failures.push(`result set is missing fixed run ${fixedRun.id}`);
            continue;
        }
        if (result.mappedFiles < baselineRun.mappedFiles) {
            failures.push(`${fixedRun.id} mappedFiles regression: ${result.mappedFiles} < baseline ${baselineRun.mappedFiles}`);
        }
        if (result.mappedSymbols < baselineRun.mappedSymbols) {
            failures.push(`${fixedRun.id} mappedSymbols regression: ${result.mappedSymbols} < baseline ${baselineRun.mappedSymbols}`);
        }
    }
    return {
        status: "validated",
        snapshot: input.snapshot,
        failures,
        profile: existingProfile,
    };
}
function collectOutputPreview(stdout, stderr) {
    return `${stdout}\n${stderr}`
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 40);
}
function runRegressionCase(options, runId, label, args) {
    const outDir = path.join(options.outRoot, runId);
    const commandArgs = [
        path.join(REPO_ROOT, "scripts", "node", "reverse.js"),
        "-AppDir",
        options.appDir,
        "-OutDir",
        outDir,
        ...args,
    ];
    const run = (0, node_child_process_1.spawnSync)(process.execPath, commandArgs, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        windowsHide: true,
    });
    const success = run.status === 0;
    const summaryPath = path.join(outDir, "report", "summary.json");
    const qualityPath = path.join(outDir, "report", "quality-gates.json");
    const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : {};
    const quality = fs.existsSync(qualityPath)
        ? readJson(qualityPath)
        : {};
    const mappedFiles = summary.deobfuscation?.mappedFiles ?? 0;
    const mappedSymbols = summary.deobfuscation?.mappedSymbols ?? 0;
    const qualityPassed = quality.passed === true;
    const qualityFailures = Array.isArray(quality.failures) ? quality.failures : [];
    if (!success) {
        const previewPath = path.join(outDir, "report", "regression-run-output-preview.json");
        writeJson(previewPath, {
            runId,
            exitCode: run.status ?? -1,
            outputPreview: collectOutputPreview(run.stdout || "", run.stderr || ""),
        });
    }
    return {
        id: runId,
        label,
        outDir: toPosixPath(outDir),
        exitCode: run.status ?? -1,
        success,
        mappedFiles,
        mappedSymbols,
        qualityPassed,
        qualityFailures,
    };
}
function formatReportMarkdown(results, baseline, baselinesPath) {
    const rows = [];
    rows.push("# Reverse Regression Report");
    rows.push("");
    rows.push(`- calibration profile: ${regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id}`);
    rows.push(`- fixed runs: ${regression_config_1.MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns.join(", ")}`);
    rows.push(`- app snapshot: ${baseline.snapshot.snapshotKey}`);
    rows.push(`- app package.json: \`${baseline.snapshot.packageJsonPath}\``);
    rows.push(`- baseline profile: ${baseline.status}`);
    rows.push(`- baselines file: \`${toPosixPath(baselinesPath)}\``);
    if (baseline.failures.length > 0) {
        rows.push(`- baseline validation failures: ${baseline.failures.join("; ")}`);
    }
    rows.push("");
    rows.push("| Run | Exit | mappedFiles | mappedSymbols | qualityGate | outDir |");
    rows.push("| --- | ---: | ---: | ---: | --- | --- |");
    for (const result of results) {
        rows.push(`| ${result.id} | ${result.exitCode} | ${result.mappedFiles} | ${result.mappedSymbols} | ${result.qualityPassed ? "pass" : "fail"} | \`${result.outDir}\` |`);
        if (result.qualityFailures.length > 0) {
            rows.push(`| ${result.id}:failures |  |  |  | ${result.qualityFailures.join("; ")} |  |`);
        }
    }
    rows.push("");
    return `${rows.join("\n")}\n`;
}
function main() {
    const options = parseArgs(process.argv.slice(2));
    fs.mkdirSync(options.outRoot, { recursive: true });
    const snapshot = readAppSnapshotInfo(options.appDir);
    const results = [];
    for (const run of regression_config_1.FIXED_REGRESSION_RUNS) {
        const result = runRegressionCase(options, run.id, run.label, run.args);
        results.push(result);
        process.stdout.write(`[regression] ${run.id}: exit=${result.exitCode}, mappedFiles=${result.mappedFiles}, mappedSymbols=${result.mappedSymbols}, quality=${result.qualityPassed}\n`);
    }
    const baselinesPath = resolveBaselinesPath();
    const baselineStore = loadBaselineStore(baselinesPath);
    const baselineValidation = validateOrCreateBaselineProfile({
        store: baselineStore,
        snapshot,
        results,
    });
    if (baselineValidation.status === "created") {
        writeJson(baselinesPath, baselineStore);
        process.stdout.write(`[regression] created baseline profile for snapshot ${snapshot.snapshotKey} in ${toPosixPath(baselinesPath)}\n`);
    }
    const reportPath = path.join(options.outRoot, "regression-report.json");
    const markdownPath = path.join(options.outRoot, "regression-report.md");
    const report = {
        generatedAtUtc: new Date().toISOString(),
        calibrationProfile: regression_config_1.MATCH_V2_CALIBRATION_PROFILE,
        appSnapshot: snapshot,
        baseline: {
            status: baselineValidation.status,
            failures: baselineValidation.failures,
            baselinesFile: toPosixPath(baselinesPath),
            profile: baselineValidation.profile,
        },
        appDir: toPosixPath(options.appDir),
        outRoot: toPosixPath(options.outRoot),
        runs: results,
    };
    writeJson(reportPath, report);
    fs.writeFileSync(markdownPath, formatReportMarkdown(results, baselineValidation, baselinesPath), "utf8");
    const failed = results.some((row) => !row.success || !row.qualityPassed) ||
        baselineValidation.failures.length > 0;
    if (failed) {
        process.stderr.write(`[regression] failed, inspect ${toPosixPath(reportPath)} and ${toPosixPath(markdownPath)}\n`);
        return 1;
    }
    process.stdout.write(`[regression] success, report: ${toPosixPath(markdownPath)}\n`);
    return 0;
}
process.exit(main());
