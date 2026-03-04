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
exports.runCodexPatchPipeline = runCodexPatchPipeline;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const launch_1 = require("./launch");
const patch_pack_1 = require("./patch-pack");
function summarizeWebviewPatch(summary) {
    if (summary.patchedFiles > 0)
        return "patched";
    if (summary.alreadyPatchedFiles > 0)
        return "already";
    return "skipped";
}
function formatWebviewDetail(summary) {
    return `patched=${summary.patchedFiles}, already=${summary.alreadyPatchedFiles}`;
}
function runPatchStep(input, step) {
    switch (step.id) {
        case "preload": {
            const preloadPath = path.join(input.appDir, ".vite", "build", "preload.js");
            if (!fs.existsSync(preloadPath)) {
                throw new Error(`Preload bundle missing: ${preloadPath}`);
            }
            const changed = (0, launch_1.patchPreload)(input.appDir);
            return {
                id: step.id,
                required: step.required,
                status: changed ? "patched" : "already",
                detail: changed ? "preload bridge inserted" : "preload bridge already present",
                sourceModId: step.sourceModId,
            };
        }
        case "webview-sunset": {
            const summary = (0, launch_1.patchWebviewAppSunsetGate)(input.appDir, { allowMissingPatchPoint: !step.required });
            return {
                id: step.id,
                required: step.required,
                status: summarizeWebviewPatch(summary),
                detail: formatWebviewDetail(summary),
                sourceModId: step.sourceModId,
            };
        }
        case "webview-cwd": {
            const summary = (0, launch_1.patchWebviewCwdNormalization)(input.appDir, { allowMissingPatchPoint: !step.required });
            return {
                id: step.id,
                required: step.required,
                status: summarizeWebviewPatch(summary),
                detail: formatWebviewDetail(summary),
                sourceModId: step.sourceModId,
            };
        }
        case "main-runtime-shim": {
            (0, launch_1.patchMainForWindowsEnvironment)(input.appDir, input.buildNumber, input.buildFlavor);
            return {
                id: step.id,
                required: step.required,
                status: "patched",
                detail: "main runtime shim applied",
                sourceModId: step.sourceModId,
            };
        }
        default: {
            throw new Error(`Unknown patch step: ${String(step.id)}`);
        }
    }
}
function runCodexPatchPipeline(input) {
    const snapshotLabel = input.snapshotLabel || "";
    const resolvedProfile = (0, patch_pack_1.resolvePatchProfile)({
        snapshotLabel,
        buildNumber: input.buildNumber,
        appVersion: input.appVersion,
        forcedProfileId: input.forcedProfileId || "",
    });
    const report = {
        profileId: resolvedProfile.profile.profileId,
        profileDescription: resolvedProfile.profile.description,
        profilePath: resolvedProfile.profile.profilePath,
        profileSource: resolvedProfile.source,
        selectorPath: resolvedProfile.selectorPath,
        patchPackRootPath: resolvedProfile.patchPackRootPath,
        stageRegistryPath: resolvedProfile.profile.stageRegistryPath,
        buildNumber: input.buildNumber,
        appVersion: input.appVersion,
        snapshotLabel,
        snapshotBuildHint: resolvedProfile.buildHint,
        mods: resolvedProfile.profile.mods.map((mod) => ({
            id: mod.id,
            stageId: mod.stageId,
            lane: mod.lane,
            priority: mod.priority,
            sourcePath: mod.sourcePath,
        })),
        stages: [],
        createdAtIso: new Date().toISOString(),
        steps: [],
        reportPath: path.join(input.diagnosticsDir, "patch-pipeline-report.json"),
    };
    (0, exec_1.writeHeader)(`Applying patch pipeline (${report.profileId})`);
    for (const stage of resolvedProfile.profile.stageExecutions) {
        const hasInjectors = stage.selectedModIds.length > 0;
        (0, exec_1.writeHeader)(`Patch stage: ${stage.id} (${stage.inputContract} -> ${stage.outputContract})`);
        if (!hasInjectors) {
            report.stages.push({
                id: stage.id,
                inputContract: stage.inputContract,
                outputContract: stage.outputContract,
                selectedModIds: [],
                status: "pass-through",
                stepCount: 0,
                detail: "no injector mods selected",
            });
            (0, exec_1.writeSuccess)(`Patch stage ${stage.id}: pass-through (no injector mods selected)`);
            continue;
        }
        if (stage.id !== "mods") {
            throw new Error(`Patch stage ${stage.id} contains injector mods but is not executable by runtime patch pipeline`);
        }
        for (const step of resolvedProfile.profile.steps) {
            const stepLabel = `${step.id}${step.required ? " [required]" : " [optional]"}`;
            (0, exec_1.writeHeader)(`Patch step: ${stepLabel}`);
            const stepResult = runPatchStep(input, step);
            report.steps.push(stepResult);
            (0, exec_1.writeSuccess)(`Patch step ${step.id}: ${stepResult.status} (${stepResult.detail})`);
        }
        report.stages.push({
            id: stage.id,
            inputContract: stage.inputContract,
            outputContract: stage.outputContract,
            selectedModIds: [...stage.selectedModIds],
            status: "executed",
            stepCount: resolvedProfile.profile.steps.length,
            detail: `executed ${resolvedProfile.profile.steps.length} patch steps`,
        });
    }
    (0, exec_1.ensureDir)(input.diagnosticsDir);
    fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
}
