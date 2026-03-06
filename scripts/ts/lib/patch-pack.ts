import * as fs from "node:fs";
import * as path from "node:path";

export type PatchStepId =
  | "preload"
  | "webview-sunset"
  | "webview-cwd"
  | "main-runtime-shim";
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

interface PatchCatalogStep {
  description: string;
  stage: string;
}

interface PatchCatalogFile {
  schemaVersion: number;
  stepOrder: string[];
  steps: Record<string, PatchCatalogStep>;
}

interface PatchSelectorRule {
  profileId: string;
  snapshotRegex?: string;
  minBuild?: number;
  maxBuild?: number;
  appVersionRegex?: string;
}

interface PatchSelectorFile {
  schemaVersion: number;
  defaultProfileId: string;
  rules: PatchSelectorRule[];
}

interface PatchProfileFile {
  schemaVersion: number;
  profileId: string;
  description: string;
  mods: string[];
}

interface PatchModFile {
  schemaVersion: number;
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

interface PatchStageRegistryFile {
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
  snapshotLabel: string;
  buildNumber: string;
  appVersion: string;
  forcedProfileId: string;
}

const REQUIRED_STAGE_IDS = ["extract", "deobf", "mods", "runtime-pack"];
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PATCH_PACK_ROOT = path.join(REPO_ROOT, "shared", "patch-pack");
const PROFILES_DIR = path.join(PATCH_PACK_ROOT, "profiles");
const MODS_DIR = path.join(PATCH_PACK_ROOT, "mods");
const SELECTOR_PATH = path.join(PATCH_PACK_ROOT, "profile-selector.json");
const CATALOG_PATH = path.join(PATCH_PACK_ROOT, "patch-catalog.json");
const STAGE_REGISTRY_PATH = path.join(PATCH_PACK_ROOT, "stage-registry.json");

function readJsonFileStrict(filePath: string, label: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new Error(`patch-pack: missing ${label}: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`patch-pack: failed to parse ${label}: ${message}`);
  }
}

function ensureStepId(value: string): PatchStepId {
  if (
    value === "preload" ||
    value === "webview-sunset" ||
    value === "webview-cwd" ||
    value === "main-runtime-shim"
  ) {
    return value;
  }
  throw new Error(`patch-pack: unsupported patch step id: ${value}`);
}

function parseBuildHint(buildNumber: string, appVersion: string, snapshotLabel: string): number {
  let best = 0;
  const fromBuild = Number.parseInt(buildNumber, 10);
  if (Number.isFinite(fromBuild) && fromBuild > best) best = fromBuild;

  const normalizedAppVersion = appVersion.trim();
  const explicitAppVersionHints: Array<{ regex: RegExp; buildHint: number }> = [
    { regex: /^26\.305\.950$/, buildHint: 11012 },
    { regex: /^26\.303\.1606$/, buildHint: 10711 },
  ];
  for (const hint of explicitAppVersionHints) {
    if (hint.regex.test(normalizedAppVersion) && hint.buildHint > best) {
      best = hint.buildHint;
    }
  }

  const combined = `${appVersion} ${snapshotLabel}`;
  const codexMatch = combined.toLowerCase().match(/codex[-_]?(\d{3,6})/);
  if (codexMatch && codexMatch[1]) {
    const parsed = Number.parseInt(codexMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > best) best = parsed;
  }

  const numericTokens = combined.match(/\d{4,6}/g);
  if (numericTokens) {
    for (const token of numericTokens) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isFinite(parsed) && parsed > best) best = parsed;
    }
  }
  return best;
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

function parsePatchCatalog(): PatchCatalogFile {
  const parsed = readJsonFileStrict(CATALOG_PATH, "patch catalog") as PatchCatalogFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("patch-pack: patch catalog must be an object");
  }
  if (!Array.isArray(parsed.stepOrder) || parsed.stepOrder.length === 0) {
    throw new Error("patch-pack: patch catalog stepOrder must be a non-empty array");
  }
  if (!parsed.steps || typeof parsed.steps !== "object") {
    throw new Error("patch-pack: patch catalog steps must be an object");
  }
  for (const stepId of parsed.stepOrder) {
    const normalizedStepId = ensureStepId(String(stepId));
    if (!Object.prototype.hasOwnProperty.call(parsed.steps, normalizedStepId)) {
      throw new Error(`patch-pack: stepOrder references unknown step ${normalizedStepId}`);
    }
  }
  return parsed;
}

function parseSelector(): PatchSelectorFile {
  const parsed = readJsonFileStrict(SELECTOR_PATH, "selector") as PatchSelectorFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("patch-pack: selector must be an object");
  }
  if (!parsed.defaultProfileId || typeof parsed.defaultProfileId !== "string") {
    throw new Error("patch-pack: selector defaultProfileId is required");
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Error("patch-pack: selector rules must be an array");
  }
  return parsed;
}

function parseStageRegistry(): StageRegistryModel {
  const parsed = readJsonFileStrict(STAGE_REGISTRY_PATH, "stage registry") as PatchStageRegistryFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("patch-pack: stage registry must be an object");
  }
  if (!Array.isArray(parsed.stageOrder) || parsed.stageOrder.length === 0) {
    throw new Error("patch-pack: stage registry stageOrder must be non-empty");
  }
  if (!parsed.stages || typeof parsed.stages !== "object") {
    throw new Error("patch-pack: stage registry stages must be an object");
  }

  const stageOrder = parsed.stageOrder.map((stageId) => String(stageId || "").trim());
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
    const stageNode = parsed.stages[stageId];
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

  const modInjectors = parsed.modInjectors;
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
    path: STAGE_REGISTRY_PATH,
    stageOrder,
    stages,
    stageMap,
    allowedModStageIds,
  };
}

function parsePatchProfileFile(profileId: string): PatchProfileFile {
  const profilePath = path.join(PROFILES_DIR, `${profileId}.json`);
  const parsed = readJsonFileStrict(profilePath, `profile ${profileId}`) as PatchProfileFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`patch-pack: profile ${profileId} must be an object`);
  }
  if (parsed.profileId !== profileId) {
    throw new Error(`patch-pack: profile id mismatch (${parsed.profileId} != ${profileId})`);
  }
  if (!Array.isArray(parsed.mods) || parsed.mods.length === 0) {
    throw new Error(`patch-pack: profile ${profileId} mods must be a non-empty array`);
  }
  return parsed;
}

function parseModFile(modId: string, catalog: PatchCatalogFile, stageRegistry: StageRegistryModel): PatchModPlan {
  const modPath = path.join(MODS_DIR, `${modId}.json`);
  const parsed = readJsonFileStrict(modPath, `mod ${modId}`) as PatchModFile;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`patch-pack: mod ${modId} must be an object`);
  }
  if (parsed.id !== modId) {
    throw new Error(`patch-pack: mod id mismatch (${parsed.id} != ${modId})`);
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`patch-pack: mod ${modId} steps must be non-empty`);
  }

  const lane = String(parsed.lane || "").trim();
  if (!lane) {
    throw new Error(`patch-pack: mod ${modId} lane is required`);
  }

  const injector = parsed.injector;
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

  const steps = parsed.steps.map((step) => {
    const id = ensureStepId(String(step.id));
    if (!Object.prototype.hasOwnProperty.call(catalog.steps, id)) {
      throw new Error(`patch-pack: mod ${modId} references unknown catalog step ${id}`);
    }
    return {
      id,
      required: Boolean(step.required),
      sourceModId: modId,
    };
  });

  const compatibility = parsed.compatibility || {};
  return {
    id: modId,
    description: String(parsed.description || ""),
    stageId,
    lane,
    priority: Number.isFinite(parsed.priority) ? Number(parsed.priority) : 1000,
    sourcePath: modPath,
    conflicts: Array.isArray(parsed.conflicts)
      ? parsed.conflicts.map((entry) => String(entry)).filter((entry) => entry.length > 0)
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
  if (mod.compatibility.snapshotRegex.length > 0) {
    const matcher = new RegExp(mod.compatibility.snapshotRegex, "i");
    if (!matcher.test(snapshotLabel)) return false;
  }
  if (mod.compatibility.appVersionRegex.length > 0) {
    const matcher = new RegExp(mod.compatibility.appVersionRegex, "i");
    if (!matcher.test(appVersion)) return false;
  }
  if (mod.compatibility.minBuild > 0 && buildHint < mod.compatibility.minBuild) return false;
  if (mod.compatibility.maxBuild > 0 && buildHint > mod.compatibility.maxBuild) return false;
  if (mod.stageMinBuild > 0 && buildHint < mod.stageMinBuild) return false;
  if (mod.stageMaxBuild > 0 && buildHint > mod.stageMaxBuild) return false;
  return true;
}

function matchesRule(rule: PatchSelectorRule, snapshotLabel: string, appVersion: string, buildHint: number): boolean {
  if (rule.snapshotRegex && rule.snapshotRegex.length > 0) {
    const matcher = new RegExp(rule.snapshotRegex, "i");
    if (matcher.test(snapshotLabel)) return true;
  }
  if (rule.appVersionRegex && rule.appVersionRegex.length > 0) {
    const matcher = new RegExp(rule.appVersionRegex, "i");
    if (matcher.test(appVersion)) return true;
  }
  if (typeof rule.minBuild === "number" && Number.isFinite(rule.minBuild) && buildHint >= rule.minBuild) {
    return true;
  }
  if (typeof rule.maxBuild === "number" && Number.isFinite(rule.maxBuild) && buildHint <= rule.maxBuild && buildHint > 0) {
    return true;
  }
  return false;
}

function resolveProfileId(input: ResolvePatchProfileInput, selector: PatchSelectorFile, buildHint: number): {
  profileId: string;
  source: PatchProfileSource;
} {
  const forced = input.forcedProfileId.trim().toLowerCase();
  if (forced.length > 0) {
    return { profileId: forced, source: "forced" };
  }
  const snapshotLabel = input.snapshotLabel.trim().toLowerCase();
  const appVersion = input.appVersion.trim();
  for (const rule of selector.rules) {
    if (!rule || typeof rule.profileId !== "string" || rule.profileId.length === 0) {
      throw new Error("patch-pack: selector rule has invalid profileId");
    }
    if (!matchesRule(rule, snapshotLabel, appVersion, buildHint)) continue;
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

function assertNoConflicts(mods: PatchModPlan[]): void {
  const selected = new Set<string>(mods.map((mod) => mod.id));
  const conflicts: string[] = [];
  for (const mod of mods) {
    for (const conflictId of mod.conflicts) {
      if (selected.has(conflictId)) {
        conflicts.push(`${mod.id} x ${conflictId}`);
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = [...new Set(conflicts)].sort().join(", ");
    throw new Error(`patch-pack: conflicting mods selected: ${detail}`);
  }
}

function mergeStepsByCatalogOrder(catalog: PatchCatalogFile, mods: PatchModPlan[]): PatchStepPlan[] {
  const byStep = new Map<PatchStepId, PatchStepPlan>();
  for (const mod of mods) {
    for (const step of mod.steps) {
      const current = byStep.get(step.id);
      if (!current) {
        byStep.set(step.id, { ...step });
        continue;
      }
      current.required = current.required || step.required;
    }
  }

  const ordered: PatchStepPlan[] = [];
  for (const entry of catalog.stepOrder) {
    const id = ensureStepId(String(entry));
    const step = byStep.get(id);
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

export function resolvePatchProfile(input: ResolvePatchProfileInput): ResolvedPatchProfile {
  const selector = parseSelector();
  const catalog = parsePatchCatalog();
  const stageRegistry = parseStageRegistry();
  const snapshotLabel = input.snapshotLabel.length > 0 ? input.snapshotLabel : "";
  const buildHint = parseBuildHint(input.buildNumber, input.appVersion, snapshotLabel);
  const selected = resolveProfileId(input, selector, buildHint);
  const profileFile = parsePatchProfileFile(selected.profileId);

  const uniqueModIds = new Set<string>();
  const compatibleMods: PatchModPlan[] = [];
  for (const modIdRaw of profileFile.mods) {
    const modId = String(modIdRaw || "").trim();
    if (!modId) {
      throw new Error(`patch-pack: empty mod id in profile ${profileFile.profileId}`);
    }
    if (uniqueModIds.has(modId)) {
      throw new Error(`patch-pack: duplicate mod id ${modId} in profile ${profileFile.profileId}`);
    }
    uniqueModIds.add(modId);

    const mod = parseModFile(modId, catalog, stageRegistry);
    if (!matchesCompatibility(mod, snapshotLabel, input.appVersion, buildHint)) {
      throw new Error(
        `patch-pack: mod ${mod.id} is incompatible with snapshot=${snapshotLabel} buildHint=${buildHint} appVersion=${input.appVersion}`,
      );
    }
    compatibleMods.push(mod);
  }

  const orderedMods = resolveModOrder(compatibleMods, stageRegistry);
  assertNoConflicts(orderedMods);
  const mergedSteps = mergeStepsByCatalogOrder(catalog, orderedMods);

  const profilePath = path.join(PROFILES_DIR, `${profileFile.profileId}.json`);
  return {
    profile: {
      profileId: profileFile.profileId,
      description: String(profileFile.description || ""),
      profilePath,
      stageRegistryPath: stageRegistry.path,
      mods: orderedMods,
      steps: mergedSteps,
      stages: stageRegistry.stages,
      stageExecutions: buildStageExecutions(stageRegistry.stages, orderedMods),
    },
    source: selected.source,
    selectorPath: SELECTOR_PATH,
    patchPackRootPath: PATCH_PACK_ROOT,
    snapshotLabel,
    buildHint,
  };
}

export function getPatchPackRootPath(): string {
  return PATCH_PACK_ROOT;
}
