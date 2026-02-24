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
exports.runReversePipelineCli = runReversePipelineCli;
const fs = __importStar(require("node:fs"));
const exec_1 = require("../lib/exec");
const reverse_engine_1 = require("../reverse-engine");
const output_discipline_1 = require("./output-discipline");
class StageFailureError extends Error {
    stage;
    cause;
    constructor(stage, cause) {
        const message = cause instanceof Error ? cause.message : `Stage '${stage}' failed with non-error cause: ${String(cause)}`;
        super(`Stage '${stage}' failed: ${message}`);
        this.stage = stage;
        this.cause = cause;
    }
}
async function runStage(name, action) {
    try {
        return await action();
    }
    catch (error) {
        throw new StageFailureError(name, error);
    }
}
function ensureAppDirExists(appDir) {
    if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
        throw new Error(`App directory not found: ${appDir}`);
    }
}
async function runExtractStage(envelope) {
    ensureAppDirExists(envelope.options.appDir);
    return {
        stage: "extract",
        envelope,
        appDir: envelope.options.appDir,
        outDir: envelope.options.outDir,
    };
}
async function runParseLiftStage(extractStage) {
    return {
        stage: "parse-lift",
        envelope: extractStage.envelope,
        appDir: extractStage.appDir,
        outDir: extractStage.outDir,
        noPretty: extractStage.envelope.options.noPretty,
    };
}
async function runMatchStage(parseLiftStage) {
    return {
        stage: "match",
        envelope: parseLiftStage.envelope,
        appDir: parseLiftStage.appDir,
        outDir: parseLiftStage.outDir,
        referenceMapPath: parseLiftStage.envelope.options.referenceMapPath,
    };
}
async function runSemanticIrStage(matchStage) {
    return {
        stage: "semantic-ir",
        envelope: matchStage.envelope,
        appDir: matchStage.appDir,
        outDir: matchStage.outDir,
        semanticIrSource: "deobfuscation-table",
    };
}
async function runEmitStage(semanticIrStage) {
    const exitCode = await (0, reverse_engine_1.runReverseStrictPath)(semanticIrStage.envelope.options);
    return {
        stage: "emit",
        envelope: semanticIrStage.envelope,
        options: semanticIrStage.envelope.options,
        exitCode,
    };
}
async function runQualityPassStage(emitStage) {
    const passed = emitStage.exitCode === 0;
    if (!passed) {
        throw new Error(`Emit stage produced non-zero exit code: ${emitStage.exitCode}`);
    }
    return {
        stage: "quality-pass",
        envelope: emitStage.envelope,
        exitCode: emitStage.exitCode,
        passed,
    };
}
async function runPipelineStrict(envelope) {
    const extractStage = await runStage("extract", () => runExtractStage(envelope));
    const parseLiftStage = await runStage("parse-lift", () => runParseLiftStage(extractStage));
    const matchStage = await runStage("match", () => runMatchStage(parseLiftStage));
    const semanticIrStage = await runStage("semantic-ir", () => runSemanticIrStage(matchStage));
    const emitStage = await runStage("emit", () => runEmitStage(semanticIrStage));
    await runStage("quality-pass", () => runQualityPassStage(emitStage));
    return emitStage.exitCode;
}
async function runPipelineWithRecovery(options) {
    const strictEnvelope = { options, mode: "strict" };
    try {
        return await runPipelineStrict(strictEnvelope);
    }
    catch (error) {
        if (options.noPretty ||
            !(error instanceof StageFailureError) ||
            (error.stage !== "parse-lift" && error.stage !== "emit")) {
            throw error;
        }
        (0, exec_1.writeWarn)(`[RECOVERY] strict pipeline failed at stage '${error.stage}'. Retrying once with -NoPretty.`);
        const recoveredOptions = {
            ...options,
            noPretty: true,
            noClean: false,
        };
        const recoveryEnvelope = {
            options: recoveredOptions,
            mode: "recovery",
        };
        return runPipelineStrict(recoveryEnvelope);
    }
}
async function runReversePipelineCli(argv = process.argv.slice(2)) {
    const parsed = (0, reverse_engine_1.parseArgs)(argv);
    if (parsed.showHelp) {
        (0, reverse_engine_1.printUsage)();
        return 0;
    }
    const options = parsed.options;
    const latestMode = !options.noLatestSync &&
        (0, output_discipline_1.normalizePathForComparison)(options.outDir) === (0, output_discipline_1.normalizePathForComparison)(output_discipline_1.DEFAULT_REVERSE_LATEST_DIR);
    if (!latestMode) {
        return runPipelineWithRecovery(options);
    }
    const stableRun = (0, output_discipline_1.prepareStableRunPaths)({
        latestDir: options.outDir,
        runsRoot: options.runsRoot,
        keepLastRuns: options.keepLastRuns,
        runId: options.runId,
    });
    const runOptions = {
        ...options,
        outDir: stableRun.runDir,
        noClean: false,
    };
    let resultCode = 0;
    let runError;
    try {
        resultCode = await runPipelineWithRecovery(runOptions);
    }
    catch (error) {
        runError = error;
    }
    const publishResult = (0, output_discipline_1.publishStableRun)(stableRun);
    (0, exec_1.writeInfo)(`Stable latest synced: ${stableRun.latestDir.replace(/\\/g, "/")} (run=${stableRun.runId})`);
    if (publishResult.removedRuns.length > 0) {
        (0, exec_1.writeInfo)(`Stable run cleanup: removed ${publishResult.removedRuns.length} archived runs`);
    }
    if (runError)
        throw runError;
    return resultCode;
}
