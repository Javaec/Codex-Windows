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
function formatReportMarkdown(results) {
    const rows = [];
    rows.push("# Reverse Regression Report");
    rows.push("");
    rows.push(`- calibration profile: ${regression_config_1.MATCH_V2_CALIBRATION_PROFILE.id}`);
    rows.push(`- fixed runs: ${regression_config_1.MATCH_V2_CALIBRATION_PROFILE.fixedRegressionRuns.join(", ")}`);
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
    const results = [];
    for (const run of regression_config_1.FIXED_REGRESSION_RUNS) {
        const result = runRegressionCase(options, run.id, run.label, run.args);
        results.push(result);
        process.stdout.write(`[regression] ${run.id}: exit=${result.exitCode}, mappedFiles=${result.mappedFiles}, mappedSymbols=${result.mappedSymbols}, quality=${result.qualityPassed}\n`);
    }
    const reportPath = path.join(options.outRoot, "regression-report.json");
    const markdownPath = path.join(options.outRoot, "regression-report.md");
    const report = {
        generatedAtUtc: new Date().toISOString(),
        calibrationProfile: regression_config_1.MATCH_V2_CALIBRATION_PROFILE,
        appDir: toPosixPath(options.appDir),
        outRoot: toPosixPath(options.outRoot),
        runs: results,
    };
    writeJson(reportPath, report);
    fs.writeFileSync(markdownPath, formatReportMarkdown(results), "utf8");
    const failed = results.some((row) => !row.success || !row.qualityPassed);
    if (failed) {
        process.stderr.write(`[regression] failed, inspect ${toPosixPath(reportPath)} and ${toPosixPath(markdownPath)}\n`);
        return 1;
    }
    process.stdout.write(`[regression] success, report: ${toPosixPath(markdownPath)}\n`);
    return 0;
}
process.exit(main());
