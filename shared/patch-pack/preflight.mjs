import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REQUIRED_STAGE_IDS = ["extract", "deobf", "mods", "runtime-pack"];
const require = createRequire(import.meta.url);
const { parseBuildHint } = require("../version-identity/index.cjs");

function parseArgs(argv) {
  let snapshotLabel = "";
  let appVersion = "";
  let buildNumber = "";
  let forcedProfile = "";
  let includeTestProfiles = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot-label": {
        const value = argv[index + 1];
        if (!value) throw new Error("patch-pack preflight: missing value for --snapshot-label");
        snapshotLabel = value;
        index += 1;
        break;
      }
      case "--app-version": {
        const value = argv[index + 1];
        if (!value) throw new Error("patch-pack preflight: missing value for --app-version");
        appVersion = value;
        index += 1;
        break;
      }
      case "--build-number": {
        const value = argv[index + 1];
        if (!value) throw new Error("patch-pack preflight: missing value for --build-number");
        buildNumber = value;
        index += 1;
        break;
      }
      case "--patch-profile": {
        const value = argv[index + 1];
        if (!value) throw new Error("patch-pack preflight: missing value for --patch-profile");
        forcedProfile = value;
        index += 1;
        break;
      }
      case "--include-test-profiles": {
        includeTestProfiles = true;
        break;
      }
      default:
        throw new Error(`patch-pack preflight: unknown option: ${token}`);
    }
  }

  return {
    snapshotLabel,
    appVersion,
    buildNumber,
    forcedProfile,
    includeTestProfiles,
  };
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`patch-pack preflight: missing ${label}: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`patch-pack preflight: failed to parse ${label}: ${message}`);
  }
}

function readCapabilityRegistry(loaderRoot) {
  const registryPath = path.join(loaderRoot, "capability-registry.json");
  const registry = readJson(registryPath, "mod capability registry");
  if (!registry || typeof registry !== "object") {
    throw new Error(`patch-pack preflight: capability registry must be an object: ${registryPath}`);
  }
  if (Number(registry.schemaVersion) !== 1) {
    throw new Error(`patch-pack preflight: capability registry schemaVersion must be 1: ${registryPath}`);
  }
  return {
    path: registryPath,
    renderer: new Set(Array.isArray(registry.renderer) ? registry.renderer.map((value) => String(value || "").trim()).filter(Boolean) : []),
    main: new Set(Array.isArray(registry.main) ? registry.main.map((value) => String(value || "").trim()).filter(Boolean) : []),
  };
}

function validateRuntimeModpack(modpackRoot, capabilityRegistry) {
  if (!fs.existsSync(modpackRoot)) {
    throw new Error(`patch-pack preflight: missing runtime modpack: ${modpackRoot}`);
  }

  const entries = fs
    .readdirSync(modpackRoot, { withFileTypes: true })
    .filter((entry) => entry && entry.isDirectory())
    .map((entry) => String(entry.name || "").trim())
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b));

  if (entries.length === 0) {
    throw new Error(`patch-pack preflight: runtime modpack is empty: ${modpackRoot}`);
  }

  const seen = new Set();
  let rendererModCount = 0;
  let mainModCount = 0;
  for (const dirName of entries) {
    const modDir = path.join(modpackRoot, dirName);
    const manifestPath = path.join(modDir, "mod.json");
    const manifest = readJson(manifestPath, `runtime mod ${dirName}`);
    if (!manifest || typeof manifest !== "object") {
      throw new Error(`patch-pack preflight: runtime mod ${dirName} manifest must be an object`);
    }
    if (Number(manifest.schemaVersion) !== 1) {
      throw new Error(`patch-pack preflight: runtime mod ${dirName} schemaVersion must be 1`);
    }
    const id = String(manifest.id || "").trim();
    if (!id) throw new Error(`patch-pack preflight: runtime mod ${dirName} is missing id`);
    if (id !== dirName) {
      throw new Error(`patch-pack preflight: runtime mod id mismatch (${id} != ${dirName})`);
    }
    if (seen.has(id)) throw new Error(`patch-pack preflight: runtime mod duplicated id: ${id}`);
    seen.add(id);

    if (manifest.enabled === false) continue;

    const entrypoints = manifest.entrypoints;
    if (!entrypoints || typeof entrypoints !== "object") {
      throw new Error(`patch-pack preflight: runtime mod ${id} is missing entrypoints`);
    }

    const hasRenderer = Boolean(entrypoints.renderer);
    const hasMain = Boolean(entrypoints.main);
    if (!hasRenderer && !hasMain) {
      throw new Error(`patch-pack preflight: runtime mod ${id} has no entrypoints`);
    }
    const requiresCapabilities = manifest.requiresCapabilities;
    if (!requiresCapabilities || typeof requiresCapabilities !== "object" || Array.isArray(requiresCapabilities)) {
      throw new Error(`patch-pack preflight: runtime mod ${id} must declare requiresCapabilities object`);
    }

    if (entrypoints.renderer) {
      const rendererEntry = String(entrypoints.renderer || "").trim();
      if (!rendererEntry) throw new Error(`patch-pack preflight: runtime mod ${id} has empty renderer entry`);
      const rendererPath = path.join(modDir, rendererEntry);
      if (!fs.existsSync(rendererPath)) {
        throw new Error(`patch-pack preflight: runtime mod ${id} missing renderer entry: ${rendererPath}`);
      }
      const size = fs.statSync(rendererPath).size;
      if (size < 16) throw new Error(`patch-pack preflight: runtime mod ${id} renderer entry is empty`);
      const rendererCapabilities = requiresCapabilities.renderer;
      if (!Array.isArray(rendererCapabilities) || rendererCapabilities.length === 0) {
        throw new Error(`patch-pack preflight: runtime mod ${id} must declare requiresCapabilities.renderer`);
      }
      for (const capability of rendererCapabilities) {
        const name = String(capability || "").trim();
        if (!name) throw new Error(`patch-pack preflight: runtime mod ${id} has empty renderer capability`);
        if (!capabilityRegistry.renderer.has(name)) {
          throw new Error(`patch-pack preflight: runtime mod ${id} has unknown renderer capability: ${name}`);
        }
      }
      rendererModCount += 1;
    }

    const compatibility = manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
    if (typeof compatibility.appVersionRegex === "string" && compatibility.appVersionRegex.trim().length > 0) {
      try {
        new RegExp(compatibility.appVersionRegex, "i");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`patch-pack preflight: runtime mod ${id} has invalid compatibility.appVersionRegex: ${message}`);
      }
    }

    if (entrypoints.main) {
      const mainEntry = String(entrypoints.main || "").trim();
      if (!mainEntry) throw new Error(`patch-pack preflight: runtime mod ${id} has empty main entry`);
      const mainPath = path.join(modDir, mainEntry);
      if (!fs.existsSync(mainPath)) {
        throw new Error(`patch-pack preflight: runtime mod ${id} missing main entry: ${mainPath}`);
      }
      const size = fs.statSync(mainPath).size;
      if (size < 16) throw new Error(`patch-pack preflight: runtime mod ${id} main entry is empty`);
      const mainCapabilities = requiresCapabilities.main;
      if (!Array.isArray(mainCapabilities) || mainCapabilities.length === 0) {
        throw new Error(`patch-pack preflight: runtime mod ${id} must declare requiresCapabilities.main`);
      }
      for (const capability of mainCapabilities) {
        const name = String(capability || "").trim();
        if (!name) throw new Error(`patch-pack preflight: runtime mod ${id} has empty main capability`);
        if (!capabilityRegistry.main.has(name)) {
          throw new Error(`patch-pack preflight: runtime mod ${id} has unknown main capability: ${name}`);
        }
      }
      mainModCount += 1;
    }
  }

  return {
    modCount: entries.length,
    rendererModCount,
    mainModCount,
    root: modpackRoot,
  };
}

function parseBuildLimit(rawValue, label) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return 0;
  }
  if (!Number.isFinite(rawValue)) {
    throw new Error(`patch-pack preflight: invalid ${label}`);
  }
  const numericValue = Number(rawValue);
  if (numericValue < 0) {
    throw new Error(`patch-pack preflight: invalid ${label}`);
  }
  return numericValue;
}

function validateSelector(selector) {
  if (!selector || typeof selector !== "object") {
    throw new Error("patch-pack preflight: selector must be an object");
  }
  if (typeof selector.defaultProfileId !== "string" || selector.defaultProfileId.length === 0) {
    throw new Error("patch-pack preflight: selector defaultProfileId is required");
  }
  if (!Array.isArray(selector.rules)) {
    throw new Error("patch-pack preflight: selector rules must be an array");
  }
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("patch-pack preflight: catalog must be an object");
  }
  if (!Array.isArray(catalog.stepOrder) || catalog.stepOrder.length === 0) {
    throw new Error("patch-pack preflight: catalog stepOrder must be non-empty");
  }
  if (!catalog.steps || typeof catalog.steps !== "object") {
    throw new Error("patch-pack preflight: catalog steps must be an object");
  }
  for (const stepId of catalog.stepOrder) {
    const normalizedStepId = String(stepId || "").trim();
    if (!normalizedStepId) {
      throw new Error("patch-pack preflight: catalog stepOrder contains empty step id");
    }
    if (!Object.prototype.hasOwnProperty.call(catalog.steps, normalizedStepId)) {
      throw new Error(`patch-pack preflight: stepOrder references missing step '${normalizedStepId}'`);
    }
  }
}

function loadStageRegistry(stageRegistryPath) {
  const registry = readJson(stageRegistryPath, "stage registry");
  if (!registry || typeof registry !== "object") {
    throw new Error("patch-pack preflight: stage registry must be an object");
  }
  if (!Array.isArray(registry.stageOrder) || registry.stageOrder.length === 0) {
    throw new Error("patch-pack preflight: stage registry stageOrder must be non-empty");
  }
  if (!registry.stages || typeof registry.stages !== "object") {
    throw new Error("patch-pack preflight: stage registry stages must be an object");
  }
  const stageOrder = registry.stageOrder.map((stageId) => String(stageId || "").trim());
  for (const requiredStageId of REQUIRED_STAGE_IDS) {
    if (!stageOrder.includes(requiredStageId)) {
      throw new Error(`patch-pack preflight: stage registry missing required stage '${requiredStageId}'`);
    }
  }

  const stageMap = new Map();
  for (let index = 0; index < stageOrder.length; index += 1) {
    const stageId = stageOrder[index];
    if (!stageId) {
      throw new Error("patch-pack preflight: stage registry contains empty stage id");
    }
    const stage = registry.stages[stageId];
    if (!stage || typeof stage !== "object") {
      throw new Error(`patch-pack preflight: stage '${stageId}' is missing in stages map`);
    }
    const inputContract = String(stage.inputContract || "").trim();
    const outputContract = String(stage.outputContract || "").trim();
    if (!inputContract || !outputContract) {
      throw new Error(`patch-pack preflight: stage '${stageId}' contracts are required`);
    }
    const minBuild = parseBuildLimit(stage.minBuild, `stages.${stageId}.minBuild`);
    const maxBuild = parseBuildLimit(stage.maxBuild, `stages.${stageId}.maxBuild`);
    if (maxBuild > 0 && minBuild > 0 && maxBuild < minBuild) {
      throw new Error(`patch-pack preflight: stage '${stageId}' has maxBuild < minBuild`);
    }
    stageMap.set(stageId, {
      id: stageId,
      order: index,
      description: String(stage.description || ""),
      inputContract,
      outputContract,
      minBuild,
      maxBuild,
    });
  }

  const modInjectors = registry.modInjectors;
  if (!modInjectors || typeof modInjectors !== "object") {
    throw new Error("patch-pack preflight: stage registry modInjectors must be an object");
  }
  const defaultStageId = String(modInjectors.defaultStageId || "").trim();
  const allowedStageIdsRaw = Array.isArray(modInjectors.allowedStageIds) ? modInjectors.allowedStageIds : [];
  const allowedStageIds = new Set(
    allowedStageIdsRaw
      .map((stageId) => String(stageId || "").trim())
      .filter((stageId) => stageId.length > 0),
  );
  if (!defaultStageId) {
    throw new Error("patch-pack preflight: stage registry modInjectors.defaultStageId is required");
  }
  if (!allowedStageIds.has(defaultStageId)) {
    throw new Error("patch-pack preflight: stage registry defaultStageId must be in allowedStageIds");
  }
  for (const stageId of allowedStageIds) {
    if (!stageMap.has(stageId)) {
      throw new Error(`patch-pack preflight: mod injector stage '${stageId}' is not present in stage registry`);
    }
  }

  return {
    path: stageRegistryPath,
    stageOrder,
    stageMap,
    allowedModStageIds: allowedStageIds,
    defaultModStageId: defaultStageId,
  };
}

function loadMod(modsDir, modId, catalog, stageRegistry) {
  const modPath = path.join(modsDir, `${modId}.json`);
  const mod = readJson(modPath, `mod ${modId}`);
  if (!mod || typeof mod !== "object") {
    throw new Error(`patch-pack preflight: mod ${modId} must be an object`);
  }
  if (mod.id !== modId) {
    throw new Error(`patch-pack preflight: mod id mismatch (${mod.id} != ${modId})`);
  }
  if (!Array.isArray(mod.steps) || mod.steps.length === 0) {
    throw new Error(`patch-pack preflight: mod ${modId} has empty steps`);
  }

  const lane = String(mod.lane || "").trim();
  if (!lane) {
    throw new Error(`patch-pack preflight: mod ${modId} is missing lane`);
  }

  const injector = mod.injector;
  if (!injector || typeof injector !== "object") {
    throw new Error(`patch-pack preflight: mod ${modId} is missing injector contract`);
  }
  const stageId = String(injector.stageId || "").trim();
  if (!stageId) {
    throw new Error(`patch-pack preflight: mod ${modId} injector.stageId is required`);
  }
  if (!stageRegistry.allowedModStageIds.has(stageId)) {
    throw new Error(`patch-pack preflight: mod ${modId} stage '${stageId}' is not allowed for injectors`);
  }
  const stage = stageRegistry.stageMap.get(stageId);
  if (!stage) {
    throw new Error(`patch-pack preflight: mod ${modId} references unknown stage '${stageId}'`);
  }
  const injectorInputContract = String(injector.inputContract || "").trim();
  const injectorOutputContract = String(injector.outputContract || "").trim();
  if (!injectorInputContract || !injectorOutputContract) {
    throw new Error(`patch-pack preflight: mod ${modId} injector contracts are required`);
  }
  if (injectorInputContract !== stage.inputContract || injectorOutputContract !== stage.outputContract) {
    throw new Error(
      `patch-pack preflight: mod ${modId} injector contract ${injectorInputContract} -> ${injectorOutputContract} ` +
      `does not match stage ${stageId} contract ${stage.inputContract} -> ${stage.outputContract}`,
    );
  }

  const normalizedSteps = mod.steps.map((step) => {
    const id = String(step && typeof step === "object" ? step.id : "").trim();
    if (!id) {
      throw new Error(`patch-pack preflight: mod ${modId} has empty step id`);
    }
    if (!Object.prototype.hasOwnProperty.call(catalog.steps, id)) {
      throw new Error(`patch-pack preflight: mod ${modId} references unknown catalog step '${id}'`);
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
    lane,
    stageId,
    priority: Number.isFinite(mod.priority) ? Number(mod.priority) : 1000,
    sourcePath: modPath,
    conflicts: Array.isArray(mod.conflicts)
      ? mod.conflicts.map((entry) => String(entry)).filter((entry) => entry.length > 0)
      : [],
    compatibility: {
      snapshotRegex: String(compatibility.snapshotRegex || ""),
      appVersionRegex: String(compatibility.appVersionRegex || ""),
      minBuild: parseBuildLimit(compatibility.minBuild, `mods.${modId}.compatibility.minBuild`),
      maxBuild: parseBuildLimit(compatibility.maxBuild, `mods.${modId}.compatibility.maxBuild`),
    },
    injectorInputContract,
    injectorOutputContract,
    stageMinBuild: stage.minBuild,
    stageMaxBuild: stage.maxBuild,
    steps: normalizedSteps,
  };
}

function matchesCompatibility(mod, snapshotLabel, appVersion, buildHint) {
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

function assertNoConflicts(mods, label) {
  const selected = new Set(mods.map((mod) => mod.id));
  const conflicts = [];
  for (const mod of mods) {
    for (const conflict of mod.conflicts) {
      if (selected.has(conflict)) {
        conflicts.push(`${mod.id} x ${conflict}`);
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = [...new Set(conflicts)].sort().join(", ");
    throw new Error(`patch-pack preflight: profile ${label} has conflicting mods: ${detail}`);
  }
}

function mergeStepsByOrder(stepOrder, mods) {
  const map = new Map();
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

  const ordered = [];
  for (const stepId of stepOrder) {
    const selected = map.get(stepId);
    if (selected) ordered.push(selected);
  }
  if (ordered.length === 0) {
    throw new Error("patch-pack preflight: merged step list is empty");
  }
  return ordered;
}

function resolveModOrder(mods, stageRegistry) {
  return [...mods].sort((left, right) => {
    const leftStage = stageRegistry.stageMap.get(left.stageId);
    const rightStage = stageRegistry.stageMap.get(right.stageId);
    if (!leftStage || !rightStage) {
      throw new Error("patch-pack preflight: cannot sort mods due to missing stage in stage registry");
    }
    const rankDiff = leftStage.order - rightStage.order;
    if (rankDiff !== 0) return rankDiff;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.id.localeCompare(right.id);
  });
}

function buildStageExecutions(stageRegistry, mods) {
  return stageRegistry.stageOrder.map((stageId) => {
    const stage = stageRegistry.stageMap.get(stageId);
    if (!stage) {
      throw new Error(`patch-pack preflight: stage '${stageId}' missing in stage map`);
    }
    return {
      id: stage.id,
      inputContract: stage.inputContract,
      outputContract: stage.outputContract,
      selectedModIds: mods.filter((mod) => mod.stageId === stage.id).map((mod) => mod.id),
    };
  });
}

function matchesRule(rule, snapshotLabel, appVersion, buildHint) {
  const hasInternalRule =
    (typeof rule.appVersionRegex === "string" && rule.appVersionRegex.length > 0) ||
    (typeof rule.minBuild === "number" && Number.isFinite(rule.minBuild)) ||
    (typeof rule.maxBuild === "number" && Number.isFinite(rule.maxBuild));

  if (hasInternalRule) {
    if (typeof rule.appVersionRegex === "string" && rule.appVersionRegex.length > 0) {
      if (!new RegExp(rule.appVersionRegex, "i").test(appVersion)) return false;
    }
    if (typeof rule.minBuild === "number" && Number.isFinite(rule.minBuild) && buildHint < rule.minBuild) return false;
    if (typeof rule.maxBuild === "number" && Number.isFinite(rule.maxBuild) && (buildHint <= 0 || buildHint > rule.maxBuild)) return false;
    return true;
  }

  if (typeof rule.snapshotRegex === "string" && rule.snapshotRegex.length > 0) {
    return new RegExp(rule.snapshotRegex, "i").test(snapshotLabel);
  }
  return false;
}

function resolveProfileId({ forcedProfile, selector, snapshotLabel, appVersion, buildHint }) {
  const forced = String(forcedProfile || "").trim().toLowerCase();
  if (forced.length > 0) {
    return {
      profileId: forced,
      source: "forced",
    };
  }

  for (const rule of selector.rules) {
    const profileId = typeof rule.profileId === "string" ? rule.profileId : "";
    if (!profileId) {
      throw new Error("patch-pack preflight: selector rule has invalid profileId");
    }
    if (!matchesRule(rule, snapshotLabel, appVersion, buildHint)) continue;
    return {
      profileId,
      source: "selector-rule",
    };
  }

  return {
    profileId: selector.defaultProfileId,
    source: "default",
  };
}

function loadAllProfiles(profilesDir, includeTestProfiles) {
  if (!fs.existsSync(profilesDir)) {
    throw new Error(`patch-pack preflight: missing profiles dir: ${profilesDir}`);
  }
  const entries = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const lowerName = entry.name.toLowerCase();
      if (!lowerName.endsWith(".json")) return false;
      if (!includeTestProfiles && lowerName.startsWith("test-")) return false;
      return true;
    })
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    throw new Error("patch-pack preflight: no profile files found");
  }

  return entries.map((fileName) => {
    const filePath = path.join(profilesDir, fileName);
    const profile = readJson(filePath, `profile ${fileName}`);
    if (!profile || typeof profile !== "object") {
      throw new Error(`patch-pack preflight: profile ${fileName} must be object`);
    }
    if (typeof profile.profileId !== "string" || profile.profileId.length === 0) {
      throw new Error(`patch-pack preflight: profile ${fileName} has invalid profileId`);
    }
    if (!Array.isArray(profile.mods) || profile.mods.length === 0) {
      throw new Error(`patch-pack preflight: profile ${profile.profileId} has empty mods`);
    }
    return {
      fileName,
      filePath,
      profileId: profile.profileId,
      description: String(profile.description || ""),
      mods: profile.mods.map((modId) => String(modId || "").trim()),
    };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const patchPackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const repoRoot = path.resolve(patchPackRoot, "..", "..");
  const selectorPath = path.join(patchPackRoot, "profile-selector.json");
  const catalogPath = path.join(patchPackRoot, "patch-catalog.json");
  const stageRegistryPath = path.join(patchPackRoot, "stage-registry.json");
  const profilesDir = path.join(patchPackRoot, "profiles");
  const modsDir = path.join(patchPackRoot, "mods");
  const runtimeModpackRoot = path.join(repoRoot, "shared", "codex-mod-loader", "mods");
  const runtimeLoaderRoot = path.join(repoRoot, "shared", "codex-mod-loader", "loader");

  const selector = readJson(selectorPath, "selector");
  validateSelector(selector);
  const catalog = readJson(catalogPath, "catalog");
  validateCatalog(catalog);
  const stageRegistry = loadStageRegistry(stageRegistryPath);
  const profiles = loadAllProfiles(profilesDir, args.includeTestProfiles);

  const profileModels = [];
  for (const profile of profiles) {
    const uniqueModIds = new Set();
    const loadedMods = [];
    for (const modId of profile.mods) {
      if (!modId) {
        throw new Error(`patch-pack preflight: profile ${profile.profileId} has empty mod id`);
      }
      if (uniqueModIds.has(modId)) {
        throw new Error(`patch-pack preflight: duplicate mod id ${modId} in profile ${profile.profileId}`);
      }
      uniqueModIds.add(modId);
      loadedMods.push(loadMod(modsDir, modId, catalog, stageRegistry));
    }

    const orderedMods = resolveModOrder(loadedMods, stageRegistry);
    assertNoConflicts(orderedMods, profile.profileId);

    const mergedSteps = mergeStepsByOrder(catalog.stepOrder, orderedMods);
    profileModels.push({
      profileId: profile.profileId,
      description: profile.description,
      filePath: profile.filePath,
      mods: orderedMods,
      steps: mergedSteps,
      stageExecutions: buildStageExecutions(stageRegistry, orderedMods),
    });
  }

  const buildHint = parseBuildHint(args.buildNumber, args.appVersion, args.snapshotLabel);
  const selected = resolveProfileId({
    forcedProfile: args.forcedProfile,
    selector,
    snapshotLabel: args.snapshotLabel,
    appVersion: args.appVersion,
    buildHint,
  });

  const selectedProfile = profileModels.find((profile) => profile.profileId === selected.profileId);
  if (!selectedProfile) {
    throw new Error(`patch-pack preflight: selector resolved missing profile '${selected.profileId}'`);
  }

  const hasCompatibilityContext =
    args.snapshotLabel.length > 0 ||
    args.appVersion.length > 0 ||
    args.buildNumber.length > 0 ||
    args.forcedProfile.length > 0;

  const compatibilityFailures = [];
  if (hasCompatibilityContext) {
    for (const mod of selectedProfile.mods) {
      if (!matchesCompatibility(mod, args.snapshotLabel, args.appVersion, buildHint)) {
        compatibilityFailures.push(mod.id);
      }
    }
    if (compatibilityFailures.length > 0) {
      throw new Error(
        `patch-pack preflight: selected profile ${selectedProfile.profileId} has incompatible mods for current input: ${compatibilityFailures.join(
          ", ",
        )}`,
      );
    }
  }

  const capabilityRegistry = readCapabilityRegistry(runtimeLoaderRoot);
  const runtimeModpack = validateRuntimeModpack(runtimeModpackRoot, capabilityRegistry);

  const summary = {
    version: 2,
    generatedAtIso: new Date().toISOString(),
    patchPackRoot,
    runtimeModpack,
    selectorPath,
    catalogPath,
    stageRegistryPath,
    profileCount: profileModels.length,
    selected: {
      profileId: selectedProfile.profileId,
      source: selected.source,
      snapshotLabel: args.snapshotLabel,
      appVersion: args.appVersion,
      buildNumber: args.buildNumber,
      buildHint,
      compatibilityChecked: hasCompatibilityContext,
      includeTestProfiles: args.includeTestProfiles,
      modCount: selectedProfile.mods.length,
      stepCount: selectedProfile.steps.length,
      stageExecutionCount: selectedProfile.stageExecutions.length,
    },
    profiles: profileModels.map((profile) => ({
      profileId: profile.profileId,
      modCount: profile.mods.length,
      stepCount: profile.steps.length,
      stageExecutionCount: profile.stageExecutions.length,
    })),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
