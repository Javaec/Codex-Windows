import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, writeHeader, writeSuccess } from "../exec";
import {
  patchMainForWindowsEnvironment,
  patchPreload,
  patchWebviewAppSunsetGate,
  patchWebviewCwdNormalization,
  type WebviewPatchSummary,
} from "./bundle-patches";
import {
  type PatchStepId,
  type PatchStepPlan,
  resolvePatchProfile,
} from "./patch-pack";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { resolveRuntimeModCompatibility } = require(path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs")) as {
  resolveRuntimeModCompatibility: (input: {
    modsRoot: string;
    loaderRoot: string;
    snapshotLabel: string;
    appVersion: string;
    buildNumber: string;
  }) => {
    build: { buildHint: number; matchedBuild: { id: string } | null };
    selectedModIds: string[];
    loadOrder: string[];
    recommendedDisabledMods: Array<{ id: string; reason: string }>;
    incompatibleMods: Array<{ id: string; reason: string }>;
    softIncompatibilities: Array<{ left: string; right: string }>;
  };
};

type PatchStepStatus = "patched" | "already" | "skipped";
type PatchStageStatus = "pass-through" | "executed";

export type PatchModReport = {
  id: string;
  stageId: string;
  lane: string;
  priority: number;
  sourcePath: string;
};

export type PatchStageReport = {
  id: string;
  inputContract: string;
  outputContract: string;
  selectedModIds: string[];
  status: PatchStageStatus;
  stepCount: number;
  detail: string;
};

export type PatchStepReport = {
  id: PatchStepId;
  required: boolean;
  status: PatchStepStatus;
  detail: string;
  sourceModId: string;
};

export type PatchPipelineReport = {
  profileId: string;
  profileDescription: string;
  profilePath: string;
  profileSource: "forced" | "selector-rule" | "default";
  selectorPath: string;
  patchPackRootPath: string;
  stageRegistryPath: string;
  buildNumber: string;
  appVersion: string;
  snapshotLabel: string;
  snapshotBuildHint: number;
  mods: PatchModReport[];
  stages: PatchStageReport[];
  createdAtIso: string;
  steps: PatchStepReport[];
  runtimeModCompatibility: {
    buildHint: number;
    matchedBuildId: string;
    selectedModIds: string[];
    loadOrder: string[];
    recommendedDisabledMods: Array<{ id: string; reason: string }>;
    incompatibleMods: Array<{ id: string; reason: string }>;
    softIncompatibilities: Array<{ left: string; right: string }>;
  };
  reportPath: string;
};

export type PatchPipelineInput = {
  appDir: string;
  diagnosticsDir: string;
  buildNumber: string;
  buildFlavor: string;
  appVersion: string;
  snapshotLabel?: string;
  forcedProfileId?: string;
};

function summarizeWebviewPatch(summary: WebviewPatchSummary): PatchStepReport["status"] {
  if (summary.patchedFiles > 0) return "patched";
  if (summary.alreadyPatchedFiles > 0) return "already";
  return "skipped";
}

function formatWebviewDetail(summary: WebviewPatchSummary): string {
  return `patched=${summary.patchedFiles}, already=${summary.alreadyPatchedFiles}`;
}

function runPatchStep(input: PatchPipelineInput, step: PatchStepPlan): PatchStepReport {
  switch (step.id) {
    case "preload": {
      const preloadPath = path.join(input.appDir, ".vite", "build", "preload.js");
      if (!fs.existsSync(preloadPath)) {
        throw new Error(`Preload bundle missing: ${preloadPath}`);
      }
      const changed = patchPreload(input.appDir);
      return {
        id: step.id,
        required: step.required,
        status: changed ? "patched" : "already",
        detail: changed ? "preload bridge inserted" : "preload bridge already present",
        sourceModId: step.sourceModId,
      };
    }
    case "webview-sunset": {
      const summary = patchWebviewAppSunsetGate(input.appDir, { allowMissingPatchPoint: !step.required });
      return {
        id: step.id,
        required: step.required,
        status: summarizeWebviewPatch(summary),
        detail: formatWebviewDetail(summary),
        sourceModId: step.sourceModId,
      };
    }
    case "webview-cwd": {
      const summary = patchWebviewCwdNormalization(input.appDir, { allowMissingPatchPoint: !step.required });
      return {
        id: step.id,
        required: step.required,
        status: summarizeWebviewPatch(summary),
        detail: formatWebviewDetail(summary),
        sourceModId: step.sourceModId,
      };
    }
    case "main-runtime-shim": {
      patchMainForWindowsEnvironment(input.appDir, input.buildNumber, input.buildFlavor);
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

export function runCodexPatchPipeline(input: PatchPipelineInput): PatchPipelineReport {
  const snapshotLabel = input.snapshotLabel || "";
  const resolvedProfile = resolvePatchProfile({
    snapshotLabel,
    buildNumber: input.buildNumber,
    appVersion: input.appVersion,
    forcedProfileId: input.forcedProfileId || "",
  });
  const runtimeModCompatibility = resolveRuntimeModCompatibility({
    modsRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods"),
    loaderRoot: path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader"),
    snapshotLabel,
    appVersion: input.appVersion,
    buildNumber: input.buildNumber,
  });

  const report: PatchPipelineReport = {
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
    runtimeModCompatibility: {
      buildHint: runtimeModCompatibility.build.buildHint,
      matchedBuildId: runtimeModCompatibility.build.matchedBuild ? runtimeModCompatibility.build.matchedBuild.id : "",
      selectedModIds: runtimeModCompatibility.selectedModIds,
      loadOrder: runtimeModCompatibility.loadOrder,
      recommendedDisabledMods: runtimeModCompatibility.recommendedDisabledMods,
      incompatibleMods: runtimeModCompatibility.incompatibleMods,
      softIncompatibilities: runtimeModCompatibility.softIncompatibilities,
    },
    reportPath: path.join(input.diagnosticsDir, "patch-pipeline-report.json"),
  };

  writeHeader(`Applying patch pipeline (${report.profileId})`);

  for (const stage of resolvedProfile.profile.stageExecutions) {
    if (stage.id !== "mods" && stage.selectedModIds.length > 0) {
      throw new Error(`Patch stage ${stage.id} contains injector mods but runtime pipeline executes only "mods" stage`);
    }
  }
  const modsStage = resolvedProfile.profile.stageExecutions.find((stage) => stage.id === "mods");
  if (!modsStage) {
    throw new Error("Patch profile is missing required mods stage execution");
  }

  writeHeader(`Patch stage: ${modsStage.id} (${modsStage.inputContract} -> ${modsStage.outputContract})`);
  if (modsStage.selectedModIds.length > 0) {
    for (const step of resolvedProfile.profile.steps) {
      const stepLabel = `${step.id}${step.required ? " [required]" : " [optional]"}`;
      writeHeader(`Patch step: ${stepLabel}`);
      const stepResult = runPatchStep(input, step);
      report.steps.push(stepResult);
      writeSuccess(`Patch step ${step.id}: ${stepResult.status} (${stepResult.detail})`);
    }
  }
  report.stages.push({
    id: modsStage.id,
    inputContract: modsStage.inputContract,
    outputContract: modsStage.outputContract,
    selectedModIds: [...modsStage.selectedModIds],
    status: modsStage.selectedModIds.length > 0 ? "executed" : "pass-through",
    stepCount: modsStage.selectedModIds.length > 0 ? resolvedProfile.profile.steps.length : 0,
    detail: modsStage.selectedModIds.length > 0
      ? `executed ${resolvedProfile.profile.steps.length} patch steps`
      : "no injector mods selected",
  });

  ensureDir(input.diagnosticsDir);
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
