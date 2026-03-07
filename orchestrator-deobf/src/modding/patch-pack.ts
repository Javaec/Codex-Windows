import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile } from "../utils/fs-json";

export type PatchStepId = "preload" | "webview-sunset" | "webview-cwd" | "main-runtime-shim";
export type PatchProfileSource = "forced" | "selector-rule" | "default";

export interface PatchStepPlan {
  id: PatchStepId;
  required: boolean;
  sourceModId: string;
}

export interface PatchModCompatibility {
  snapshotRegex: string;
  appVersionRegex: string;
  minBuild: number;
  maxBuild: number;
}

export interface PatchStagePlan {
  id: string;
  description: string;
  order: number;
  inputContract: string;
  outputContract: string;
  minBuild: number;
  maxBuild: number;
}

export interface PatchStageExecutionPlan extends PatchStagePlan {
  selectedModIds: string[];
}

export interface PatchModPlan {
  id: string;
  description: string;
  stageId: string;
  lane: string;
  priority: number;
  sourcePath: string;
  conflicts: string[];
  compatibility: PatchModCompatibility;
  injectorInputContract: string;
  injectorOutputContract: string;
  stageMinBuild: number;
  stageMaxBuild: number;
  steps: PatchStepPlan[];
}

export interface PatchProfilePlan {
  profileId: string;
  description: string;
  profilePath: string;
  stageRegistryPath: string;
  mods: PatchModPlan[];
  steps: PatchStepPlan[];
  stages: PatchStagePlan[];
  stageExecutions: PatchStageExecutionPlan[];
}

export interface ResolvedPatchProfile {
  profile: PatchProfilePlan;
  source: PatchProfileSource;
  selectorPath: string;
  patchPackRootPath: string;
  snapshotLabel: string;
  buildHint: number;
}

interface SnapshotIdentity {
  appVersion: string;
  buildNumber: string;
}

function loadSharedVersionIdentity(projectRoot: string): {
  parseBuildHint: (buildNumber: string, appVersion: string, snapshotLabel: string) => number;
  resolveSnapshotVersionIdentity: (input: {
    snapshotPath: string;
    snapshotLabel?: string;
    appVersion?: string;
    buildNumber?: string;
  }) => SnapshotIdentity & {
    snapshotLabel: string;
    buildHint: number;
    source: string;
    sourcePath: string;
  };
} {
  return require(path.join(projectRoot, "..", "shared", "version-identity", "index.cjs"));
}

interface SelectorRule {
  profileId: string;
  snapshotRegex?: string;
  appVersionRegex?: string;
  minBuild?: number;
  maxBuild?: number;
}

interface SelectorModel {
  defaultProfileId: string;
  rules: SelectorRule[];
}

interface PatchProfileFileModel {
  profileId: string;
  description: string;
  mods: string[];
}

interface PatchCatalogModel {
  stepOrder: string[];
  steps: Record<string, unknown>;
}

interface PatchModFileModel {
  id: string;
  description: string;
  lane: string;
  priority: number;
  conflicts?: string[];
  injector?: {
    stageId?: string;
    inputContract?: string;
    outputContract?: string;
  };
  compatibility?: {
    snapshotRegex?: string;
    appVersionRegex?: string;
    minBuild?: number;
    maxBuild?: number;
  };
  steps: Array<{
    id: string;
    required: boolean;
  }>;
}

interface PatchStageRegistryFileModel {
  schemaVersion: number;
  stageOrder: string[];
  stages: Record<string, {
    description?: string;
    inputContract?: string;
    outputContract?: string;
    minBuild?: number;
    maxBuild?: number;
  }>;
  modInjectors?: {
    defaultStageId?: string;
    allowedStageIds?: string[];
  };
}

interface StageRegistryModel {
  path: string;
  stageOrder: string[];
  stages: PatchStagePlan[];
  stageMap: Map<string, PatchStagePlan>;
  allowedModStageIds: Set<string>;
}

export interface ResolvePatchProfileInput {
  projectRoot: string;
  snapshotPath: string;
  snapshotLabel: string;
  buildNumber: string;
  appVersion: string;
  forcedProfileId: string;
}

const REQUIRED_STAGE_IDS = ["extract", "deobf", "mods", "runtime-pack"];

function ensureStepId(value: string): PatchStepId {
  if (value === "preload" || value === "webview-sunset" || value === "webview-cwd" || value === "main-runtime-shim") {
    return value;
  }
  throw new Error(`patch-pack: unsupported step id ${value}`);
}

function parseBuildLimit(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  if (!Number.isFinite(value)) {
    throw new Error(`patch-pack: invalid ${label}`);
  }
  const numeric = Number(value);
  if (numeric < 0) {
    throw new Error(`patch-pack: invalid ${label}`);
  }
  return numeric;
}

function resolvePatchPackRootPath(projectRoot: string): string {
  return path.join(projectRoot, "..", "shared", "patch-pack");
}

async function readCatalog(patchPackRootPath: string): Promise<PatchCatalogModel> {
  const catalogPath = path.join(patchPackRootPath, "patch-catalog.json");
  const catalog = await readJsonFile<PatchCatalogModel>(catalogPath);
  if (!catalog || !Array.isArray(catalog.stepOrder) || typeof catalog.steps !== "object") {
    throw new Error(`patch-pack: invalid patch-catalog.json at ${catalogPath}`);
  }
  for (const stepId of catalog.stepOrder) {
    const normalizedStepId = ensureStepId(String(stepId));
    if (!Object.prototype.hasOwnProperty.call(catalog.steps, normalizedStepId)) {
      throw new Error(`patch-pack: stepOrder references unknown step ${normalizedStepId}`);
    }
  }
  return catalog;
}

async function readSelector(patchPackRootPath: string): Promise<{ path: string; model: SelectorModel }> {
  const selectorPath = path.join(patchPackRootPath, "profile-selector.json");
  const selector = await readJsonFile<SelectorModel>(selectorPath);
  if (!selector || typeof selector.defaultProfileId !== "string" || !Array.isArray(selector.rules)) {
    throw new Error(`patch-pack: invalid profile-selector.json at ${selectorPath}`);
  }
  return { path: selectorPath, model: selector };
}

async function readStageRegistry(patchPackRootPath: string): Promise<StageRegistryModel> {
  const stageRegistryPath = path.join(patchPackRootPath, "stage-registry.json");
  const registry = await readJsonFile<PatchStageRegistryFileModel>(stageRegistryPath);
  if (!registry || !Array.isArray(registry.stageOrder) || typeof registry.stages !== "object") {
    throw new Error(`patch-pack: invalid stage-registry.json at ${stageRegistryPath}`);
  }

  const stageOrder = registry.stageOrder.map((stageId) => String(stageId || "").trim());
  for (const requiredStageId of REQUIRED_STAGE_IDS) {
    if (!stageOrder.includes(requiredStageId)) {
      throw new Error(`patch-pack: stage registry missing required stage ${requiredStageId}`);
    }
  }

  const stages: PatchStagePlan[] = [];
  const stageMap = new Map<string, PatchStagePlan>();
  for (let index = 0; index < stageOrder.length; index += 1) {
    const stageId = stageOrder[index];
    if (!stageId) {
      throw new Error("patch-pack: stage registry contains empty stage id");
    }
    const stageNode = registry.stages[stageId];
    if (!stageNode || typeof stageNode !== "object") {
      throw new Error(`patch-pack: stage registry missing node for stage ${stageId}`);
    }
    const inputContract = String(stageNode.inputContract || "").trim();
    const outputContract = String(stageNode.outputContract || "").trim();
    if (!inputContract || !outputContract) {
      throw new Error(`patch-pack: stage ${stageId} must define inputContract and outputContract`);
    }
    const minBuild = parseBuildLimit(stageNode.minBuild, `stage ${stageId} minBuild`);
    const maxBuild = parseBuildLimit(stageNode.maxBuild, `stage ${stageId} maxBuild`);
    if (maxBuild > 0 && minBuild > 0 && maxBuild < minBuild) {
      throw new Error(`patch-pack: stage ${stageId} has maxBuild < minBuild`);
    }
    const stagePlan: PatchStagePlan = {
      id: stageId,
      description: String(stageNode.description || ""),
      order: index,
      inputContract,
      outputContract,
      minBuild,
      maxBuild,
    };
    stages.push(stagePlan);
    stageMap.set(stageId, stagePlan);
  }

  const modInjectors = registry.modInjectors;
  if (!modInjectors || typeof modInjectors !== "object") {
    throw new Error("patch-pack: stage registry modInjectors must be an object");
  }
  const defaultModStageId = String(modInjectors.defaultStageId || "").trim();
  const allowedModStageIds = new Set(
    (Array.isArray(modInjectors.allowedStageIds) ? modInjectors.allowedStageIds : [])
      .map((stageId) => String(stageId || "").trim())
      .filter((stageId) => stageId.length > 0),
  );
  if (!defaultModStageId) {
    throw new Error("patch-pack: stage registry modInjectors.defaultStageId is required");
  }
  if (!allowedModStageIds.has(defaultModStageId)) {
    throw new Error("patch-pack: stage registry defaultModStageId must be listed in allowedModStageIds");
  }
  for (const stageId of allowedModStageIds) {
    if (!stageMap.has(stageId)) {
      throw new Error(`patch-pack: stage registry allowed mod stage is unknown: ${stageId}`);
    }
  }

  return {
    path: stageRegistryPath,
    stageOrder,
    stages,
    stageMap,
    allowedModStageIds,
  };
}

async function readProfileFile(patchPackRootPath: string, profileId: string): Promise<PatchProfileFileModel> {
  const profilePath = path.join(patchPackRootPath, "profiles", `${profileId}.json`);
  const profile = await readJsonFile<PatchProfileFileModel>(profilePath);
  if (!profile || profile.profileId !== profileId || !Array.isArray(profile.mods) || profile.mods.length === 0) {
    throw new Error(`patch-pack: invalid profile ${profileId} at ${profilePath}`);
  }
  return profile;
}

async function readModFile(
  patchPackRootPath: string,
  modId: string,
  catalog: PatchCatalogModel,
  stageRegistry: StageRegistryModel,
): Promise<PatchModPlan> {
  const modPath = path.join(patchPackRootPath, "mods", `${modId}.json`);
  const mod = await readJsonFile<PatchModFileModel>(modPath);
  if (!mod || mod.id !== modId || !Array.isArray(mod.steps) || mod.steps.length === 0) {
    throw new Error(`patch-pack: invalid mod ${modId} at ${modPath}`);
  }

  const lane = String(mod.lane || "").trim();
  if (!lane) {
    throw new Error(`patch-pack: mod ${modId} lane is required`);
  }

  const injector = mod.injector;
  if (!injector || typeof injector !== "object") {
    throw new Error(`patch-pack: mod ${modId} injector contract is required`);
  }
  const stageId = String(injector.stageId || "").trim();
  if (!stageId) {
    throw new Error(`patch-pack: mod ${modId} injector.stageId is required`);
  }
  if (!stageRegistry.allowedModStageIds.has(stageId)) {
    throw new Error(`patch-pack: mod ${modId} uses unsupported injector stage ${stageId}`);
  }
  const stagePlan = stageRegistry.stageMap.get(stageId);
  if (!stagePlan) {
    throw new Error(`patch-pack: mod ${modId} references unknown stage ${stageId}`);
  }

  const injectorInputContract = String(injector.inputContract || "").trim();
  const injectorOutputContract = String(injector.outputContract || "").trim();
  if (!injectorInputContract || !injectorOutputContract) {
    throw new Error(`patch-pack: mod ${modId} injector contracts are required`);
  }
  if (injectorInputContract !== stagePlan.inputContract || injectorOutputContract !== stagePlan.outputContract) {
    throw new Error(
      `patch-pack: mod ${modId} injector contract ${injectorInputContract} -> ${injectorOutputContract} ` +
      `does not match stage ${stageId} contract ${stagePlan.inputContract} -> ${stagePlan.outputContract}`,
    );
  }

  const steps = mod.steps.map((step) => {
    const id = ensureStepId(String(step.id));
    if (!Object.prototype.hasOwnProperty.call(catalog.steps, id)) {
      throw new Error(`patch-pack: mod ${modId} references unknown step ${id}`);
    }
    return {
      id,
      required: Boolean(step.required),
      sourceModId: modId,
    };
  });

  const compatibility = mod.compatibility || {};
  return {
    id: modId,
    description: String(mod.description || ""),
    stageId,
    lane,
    priority: Number.isFinite(mod.priority) ? Number(mod.priority) : 1000,
    sourcePath: modPath,
    conflicts: Array.isArray(mod.conflicts)
      ? mod.conflicts.map((entry) => String(entry)).filter((entry) => entry.length > 0)
      : [],
    compatibility: {
      snapshotRegex: String(compatibility.snapshotRegex || ""),
      appVersionRegex: String(compatibility.appVersionRegex || ""),
      minBuild: parseBuildLimit(compatibility.minBuild, `mod ${modId} minBuild`),
      maxBuild: parseBuildLimit(compatibility.maxBuild, `mod ${modId} maxBuild`),
    },
    injectorInputContract,
    injectorOutputContract,
    stageMinBuild: stagePlan.minBuild,
    stageMaxBuild: stagePlan.maxBuild,
    steps,
  };
}

function matchesCompatibility(mod: PatchModPlan, snapshotLabel: string, appVersion: string, buildHint: number): boolean {
  const unknownSnapshotContext = buildHint <= 0 && appVersion.trim().length < 1 && /app\.asar$/iu.test(snapshotLabel);
  if (unknownSnapshotContext) {
    return true;
  }
  if (mod.compatibility.snapshotRegex.length > 0) {
    const regex = new RegExp(mod.compatibility.snapshotRegex, "i");
    if (!regex.test(snapshotLabel)) return false;
  }
  if (mod.compatibility.appVersionRegex.length > 0) {
    const regex = new RegExp(mod.compatibility.appVersionRegex, "i");
    if (!regex.test(appVersion)) return false;
  }
  if (mod.compatibility.minBuild > 0 && buildHint < mod.compatibility.minBuild) return false;
  if (mod.compatibility.maxBuild > 0 && buildHint > mod.compatibility.maxBuild) return false;
  if (mod.stageMinBuild > 0 && buildHint < mod.stageMinBuild) return false;
  if (mod.stageMaxBuild > 0 && buildHint > mod.stageMaxBuild) return false;
  return true;
}

function ruleMatches(rule: SelectorRule, snapshotLabel: string, appVersion: string, buildHint: number): boolean {
  const hasInternalRule =
    (rule.appVersionRegex && rule.appVersionRegex.length > 0) ||
    (typeof rule.minBuild === "number" && Number.isFinite(rule.minBuild)) ||
    (typeof rule.maxBuild === "number" && Number.isFinite(rule.maxBuild));

  if (hasInternalRule) {
    if (rule.appVersionRegex && rule.appVersionRegex.length > 0) {
      const regex = new RegExp(rule.appVersionRegex, "i");
      if (!regex.test(appVersion)) return false;
    }
    if (typeof rule.minBuild === "number" && Number.isFinite(rule.minBuild) && buildHint < rule.minBuild) {
      return false;
    }
    if (typeof rule.maxBuild === "number" && Number.isFinite(rule.maxBuild) && (buildHint <= 0 || buildHint > rule.maxBuild)) {
      return false;
    }
    return true;
  }

  if (rule.snapshotRegex && rule.snapshotRegex.length > 0) {
    const regex = new RegExp(rule.snapshotRegex, "i");
    return regex.test(snapshotLabel);
  }
  return false;
}

function resolveProfileCandidate(
  forcedProfileId: string,
  selector: SelectorModel,
  snapshotLabel: string,
  appVersion: string,
  buildHint: number,
): { profileId: string; source: PatchProfileSource } {
  if (forcedProfileId.length > 0) {
    return { profileId: forcedProfileId, source: "forced" };
  }

  for (const rule of selector.rules) {
    if (!rule || typeof rule.profileId !== "string" || rule.profileId.length === 0) {
      throw new Error("patch-pack: invalid selector rule profileId");
    }
    if (!ruleMatches(rule, snapshotLabel, appVersion, buildHint)) continue;
    return { profileId: rule.profileId, source: "selector-rule" };
  }

  return { profileId: selector.defaultProfileId, source: "default" };
}

function resolveModOrder(mods: PatchModPlan[], stageRegistry: StageRegistryModel): PatchModPlan[] {
  return [...mods].sort((left, right) => {
    const leftStage = stageRegistry.stageMap.get(left.stageId);
    const rightStage = stageRegistry.stageMap.get(right.stageId);
    if (!leftStage || !rightStage) {
      throw new Error("patch-pack: cannot resolve mod order due to unknown stage");
    }
    const rankDiff = leftStage.order - rightStage.order;
    if (rankDiff !== 0) return rankDiff;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.id.localeCompare(right.id);
  });
}

function assertNoModConflicts(mods: PatchModPlan[]): void {
  const selected = new Set<string>(mods.map((mod) => mod.id));
  const conflicts: string[] = [];
  for (const mod of mods) {
    for (const conflict of mod.conflicts) {
      if (selected.has(conflict)) {
        conflicts.push(`${mod.id} x ${conflict}`);
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = [...new Set(conflicts)].sort().join(", ");
    throw new Error(`patch-pack: conflicting mods selected: ${detail}`);
  }
}

function mergeStepsByCatalogOrder(catalog: PatchCatalogModel, mods: PatchModPlan[]): PatchStepPlan[] {
  const map = new Map<PatchStepId, PatchStepPlan>();
  for (const mod of mods) {
    for (const step of mod.steps) {
      const current = map.get(step.id);
      if (!current) {
        map.set(step.id, { ...step });
        continue;
      }
      current.required = current.required || step.required;
    }
  }

  const ordered: PatchStepPlan[] = [];
  for (const entry of catalog.stepOrder) {
    const id = ensureStepId(String(entry));
    const step = map.get(id);
    if (step) ordered.push(step);
  }
  if (ordered.length === 0) {
    throw new Error("patch-pack: merged profile produced zero executable steps");
  }
  return ordered;
}

function buildStageExecutions(stages: PatchStagePlan[], mods: PatchModPlan[]): PatchStageExecutionPlan[] {
  return stages.map((stage) => ({
    ...stage,
    selectedModIds: mods.filter((mod) => mod.stageId === stage.id).map((mod) => mod.id),
  }));
}

export async function resolvePatchProfile(input: ResolvePatchProfileInput): Promise<ResolvedPatchProfile> {
  const snapshotLabel = input.snapshotLabel.length > 0
    ? input.snapshotLabel
    : path.basename(input.snapshotPath);
  const sharedVersionIdentity = loadSharedVersionIdentity(input.projectRoot);
  const snapshotIdentity = sharedVersionIdentity.resolveSnapshotVersionIdentity({
    snapshotPath: input.snapshotPath,
    snapshotLabel,
    appVersion: input.appVersion,
    buildNumber: input.buildNumber,
  });
  const patchPackRootPath = resolvePatchPackRootPath(input.projectRoot);
  const selectorModel = await readSelector(patchPackRootPath);
  const catalog = await readCatalog(patchPackRootPath);
  const stageRegistry = await readStageRegistry(patchPackRootPath);
  const buildHint = snapshotIdentity.buildHint;
  const forcedProfileId = input.forcedProfileId.trim().toLowerCase();
  const hasStrongSnapshotContext = buildHint > 0 || snapshotIdentity.appVersion.trim().length > 0 || !/app\.asar$/iu.test(snapshotLabel);
  const effectiveForcedProfileId = forcedProfileId.length > 0
    ? forcedProfileId
    : (hasStrongSnapshotContext ? "" : "generic");

  const candidate = resolveProfileCandidate(
    effectiveForcedProfileId,
    selectorModel.model,
    snapshotLabel,
    snapshotIdentity.appVersion,
    buildHint,
  );

  const profileFile = await readProfileFile(patchPackRootPath, candidate.profileId);
  const uniqueModIds = new Set<string>();
  const loadedMods: PatchModPlan[] = [];

  for (const modIdRaw of profileFile.mods) {
    const modId = String(modIdRaw || "").trim();
    if (!modId) {
      throw new Error(`patch-pack: empty mod id in profile ${profileFile.profileId}`);
    }
    if (uniqueModIds.has(modId)) {
      throw new Error(`patch-pack: duplicate mod id ${modId} in profile ${profileFile.profileId}`);
    }
    uniqueModIds.add(modId);

    const mod = await readModFile(patchPackRootPath, modId, catalog, stageRegistry);
    if (!matchesCompatibility(mod, snapshotLabel, snapshotIdentity.appVersion, buildHint)) {
      throw new Error(
        `patch-pack: mod ${mod.id} is incompatible with snapshot=${snapshotLabel} buildHint=${buildHint} appVersion=${snapshotIdentity.appVersion}`,
      );
    }
    loadedMods.push(mod);
  }

  const orderedMods = resolveModOrder(loadedMods, stageRegistry);
  assertNoModConflicts(orderedMods);
  const mergedSteps = mergeStepsByCatalogOrder(catalog, orderedMods);

  return {
    profile: {
      profileId: profileFile.profileId,
      description: String(profileFile.description || ""),
      profilePath: path.join(patchPackRootPath, "profiles", `${profileFile.profileId}.json`),
      stageRegistryPath: stageRegistry.path,
      mods: orderedMods,
      steps: mergedSteps,
      stages: stageRegistry.stages,
      stageExecutions: buildStageExecutions(stageRegistry.stages, orderedMods),
    },
    source: candidate.source,
    selectorPath: selectorModel.path,
    patchPackRootPath,
    snapshotLabel,
    buildHint,
  };
}
