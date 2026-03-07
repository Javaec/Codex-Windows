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
exports.runSmoke = runSmoke;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const smoke_1 = require("../runtime-pack/smoke");
const context_1 = require("./context");
const pipeline_1 = require("./pipeline");
function moveRuntimeLogs(outputDir, stageLabel) {
    const sourceDir = path.join(outputDir, "runtime-logs");
    const targetDir = path.join(outputDir, `runtime-logs-${stageLabel}`);
    (0, exec_1.removePath)(targetDir);
    if (fs.existsSync(sourceDir)) {
        fs.renameSync(sourceDir, targetDir);
    }
    return targetDir;
}
function buildStageReport(stage, smokeResult, runtimeLogsDir) {
    return {
        stage,
        success: smokeResult.success,
        failures: [...smokeResult.failures],
        laneCount: smokeResult.lanes.length,
        runtimeLogsDir,
        summaryPath: path.join(runtimeLogsDir, "lane-summary.txt"),
        summaryJsonPath: path.join(runtimeLogsDir, "lane-summary.json"),
    };
}
async function runSmoke(options) {
    (0, exec_1.writeHeader)("Smoke build");
    const smokeWorkDir = path.resolve(options.workDir || path.join(context_1.REPO_ROOT, "work", "runner-smoke"));
    const smokeDistDir = path.resolve(options.distDir || path.join(smokeWorkDir, "dist"));
    const pipelineResult = await (0, pipeline_1.runPipelineDetailed)({
        ...options,
        workDir: smokeWorkDir,
        distDir: smokeDistDir,
        buildPortable: true,
        noLaunch: true,
        buildSingleExe: false,
    });
    if (pipelineResult.exitCode !== 0) {
        return pipelineResult.exitCode;
    }
    if (!pipelineResult.portableOutputDir) {
        throw new Error("Smoke mode requires a portable output directory");
    }
    (0, exec_1.writeSuccess)(`Smoke portable output: ${pipelineResult.portableOutputDir}`);
    const launchabilityResult = await (0, smoke_1.runPortableSmoke)({
        outputDir: pipelineResult.portableOutputDir,
        smokeSeconds: options.smokeSeconds,
        rawLanes: options.smokeLanes,
    });
    let launchabilityLogsDir = path.join(pipelineResult.portableOutputDir, "runtime-logs");
    let authenticatedStage = null;
    if (options.smokeAuthStage) {
        if (!options.smokeUserDataSeedPath || !options.smokeCodexHomeSeedPath) {
            throw new Error("Smoke auth stage requires both -SmokeUserDataSeed and -SmokeCodexHomeSeed");
        }
        launchabilityLogsDir = moveRuntimeLogs(pipelineResult.portableOutputDir, "launchability");
        const authResult = await (0, smoke_1.runPortableSmoke)({
            outputDir: pipelineResult.portableOutputDir,
            smokeSeconds: options.smokeSeconds,
            rawLanes: options.smokeAuthLanes || "with-mods",
            userDataSeedPath: options.smokeUserDataSeedPath,
            codexHomeSeedPath: options.smokeCodexHomeSeedPath,
        });
        const authenticatedLogsDir = moveRuntimeLogs(pipelineResult.portableOutputDir, "authenticated");
        authenticatedStage = buildStageReport("authenticated", authResult, authenticatedLogsDir);
    }
    const launchabilityStage = buildStageReport("launchability", launchabilityResult, launchabilityLogsDir);
    const report = {
        version: 1,
        generatedAtIso: new Date().toISOString(),
        outputDir: pipelineResult.portableOutputDir,
        smokeSeconds: options.smokeSeconds,
        launchability: launchabilityStage,
        authenticated: authenticatedStage,
        success: launchabilityStage.success && (authenticatedStage ? authenticatedStage.success : true),
    };
    const reportPath = path.join(pipelineResult.portableOutputDir, "smoke-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    (0, exec_1.writeSuccess)(`Smoke report: ${reportPath}`);
    return report.success ? 0 : 1;
}
