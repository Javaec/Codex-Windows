"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadVersionIdentity() {
  const candidatePaths = [
    path.join(__dirname, "..", "version-identity", "index.cjs"),
    path.join(__dirname, "version-identity", "index.cjs"),
  ];
  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return require(candidatePath);
    }
  }
  throw new Error(`codex-mod-compatibility: version identity helper is missing near ${__dirname}`);
}

const { parseBuildHint, readKnownBuilds } = loadVersionIdentity();

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^\"+|\"+$/g, "") : "";
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`codex-mod-compatibility: missing ${label}: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`codex-mod-compatibility: failed to parse ${label}: ${message}`);
  }
}

function normalizeStringList(rawValue, label) {
  if (rawValue === undefined) return [];
  if (!Array.isArray(rawValue)) {
    throw new Error(`codex-mod-compatibility: ${label} must be an array`);
  }
  const out = [];
  const seen = new Set();
  for (const item of rawValue) {
    const value = normalizePathString(item);
    if (!value) {
      throw new Error(`codex-mod-compatibility: ${label} contains empty entry`);
    }
    if (seen.has(value)) {
      throw new Error(`codex-mod-compatibility: ${label} contains duplicate entry '${value}'`);
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeFlexibleStringList(rawValue, label) {
  if (rawValue === undefined) return [];
  if (typeof rawValue === "string") {
    return normalizeStringList([rawValue], label);
  }
  return normalizeStringList(rawValue, label);
}

function normalizeContactObject(rawValue, label) {
  if (rawValue === undefined) return {};
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error(`codex-mod-compatibility: ${label} must be an object`);
  }
  const out = {};
  for (const [key, item] of Object.entries(rawValue)) {
    const normalizedKey = normalizePathString(key);
    const normalizedValue = normalizePathString(item);
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
}

function loadCapabilityRegistry(loaderRoot) {
  const registryPath = path.join(loaderRoot, "capability-registry.json");
  const registry = readJson(registryPath, "capability registry");
  if (!registry || typeof registry !== "object" || Number(registry.schemaVersion) !== 1) {
    throw new Error(`codex-mod-compatibility: invalid capability registry: ${registryPath}`);
  }
  return {
    path: registryPath,
    renderer: new Set(Array.isArray(registry.renderer) ? registry.renderer.map((value) => normalizePathString(value)).filter(Boolean) : []),
    main: new Set(Array.isArray(registry.main) ? registry.main.map((value) => normalizePathString(value)).filter(Boolean) : []),
  };
}

function normalizeCapabilities(manifest, id, capabilityRegistry) {
  const rawValue = manifest && manifest.requiresCapabilities;
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error(`codex-mod-compatibility: ${id} requiresCapabilities must be an object`);
  }
  const normalized = { renderer: [], main: [] };
  for (const lane of ["renderer", "main"]) {
    const list = normalizeStringList(rawValue[lane], `${id}.requiresCapabilities.${lane}`);
    for (const capability of list) {
      if (!capabilityRegistry[lane].has(capability)) {
        throw new Error(`codex-mod-compatibility: ${id} references unknown ${lane} capability '${capability}'`);
      }
    }
    normalized[lane] = list;
  }
  return normalized;
}

function normalizeCompatibility(manifest, id) {
  const raw = manifest && manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
  const minBuild = Number(raw.minBuild !== undefined ? raw.minBuild : 0);
  const maxBuild = Number(raw.maxBuild !== undefined ? raw.maxBuild : 0);
  const appVersionRegex = normalizePathString(raw.appVersionRegex || "");
  if (!Number.isFinite(minBuild) || minBuild < 0) {
    throw new Error(`codex-mod-compatibility: ${id} has invalid minBuild`);
  }
  if (!Number.isFinite(maxBuild) || maxBuild < 0) {
    throw new Error(`codex-mod-compatibility: ${id} has invalid maxBuild`);
  }
  if (maxBuild > 0 && minBuild > 0 && maxBuild < minBuild) {
    throw new Error(`codex-mod-compatibility: ${id} has maxBuild < minBuild`);
  }
  if (appVersionRegex) {
    try {
      new RegExp(appVersionRegex, "i");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`codex-mod-compatibility: ${id} has invalid appVersionRegex: ${message}`);
    }
  }
  return {
    appVersionRegex,
    minBuild,
    maxBuild,
  };
}

function normalizePriority(rawValue, id) {
  if (rawValue === undefined) return 0;
  const priority = Number(rawValue);
  if (!Number.isFinite(priority)) {
    throw new Error(`codex-mod-compatibility: ${id} has invalid priority`);
  }
  return priority;
}

function normalizeEntrypointList(rawValue, label) {
  if (rawValue === undefined) return [];
  return normalizeStringList(rawValue, label);
}

function validateEntrypoint(modDir, id, lane, entry) {
  const entryPath = path.resolve(modDir, entry);
  const relativePath = path.relative(modDir, entryPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`codex-mod-compatibility: ${id} ${lane} entry must stay inside the mod directory`);
  }
  if (!fs.existsSync(entryPath)) {
    throw new Error(`codex-mod-compatibility: missing ${lane} entry for ${id}: ${entryPath}`);
  }
  const contents = fs.readFileSync(entryPath, "utf8").replace(/^\uFEFF/, "");
  if (contents.trim().length < 16) {
    throw new Error(`codex-mod-compatibility: ${lane} entry is empty for ${id}: ${entryPath}`);
  }
}

function normalizeEntrypoints(manifest, id, modDir) {
  const entrypoints = manifest.entrypoints && typeof manifest.entrypoints === "object" ? manifest.entrypoints : {};
  const normalized = {
    renderer: normalizeEntrypointList(entrypoints.renderer, `${id}.entrypoints.renderer`),
    main: normalizeEntrypointList(entrypoints.main, `${id}.entrypoints.main`),
  };
  if (normalized.renderer.length < 1 && normalized.main.length < 1) {
    throw new Error(`codex-mod-compatibility: ${id} has no entrypoints`);
  }
  for (const entry of normalized.renderer) {
    validateEntrypoint(modDir, id, "renderer", entry);
  }
  for (const entry of normalized.main) {
    validateEntrypoint(modDir, id, "main", entry);
  }
  return normalized;
}

function registerModToken(aliasToId, token, modId, sourceLabel) {
  const normalizedToken = normalizePathString(token);
  if (!normalizedToken) return;
  const previous = aliasToId.get(normalizedToken);
  if (previous && previous !== modId) {
    throw new Error(`codex-mod-compatibility: ${sourceLabel} '${normalizedToken}' collides with mod '${previous}'`);
  }
  aliasToId.set(normalizedToken, modId);
}

function canonicalizeReferenceList(mod, listName, values, aliasToId) {
  const out = [];
  const seen = new Set();
  for (const referencedToken of values) {
    const canonicalId = aliasToId.get(referencedToken);
    if (!canonicalId) {
      throw new Error(`codex-mod-compatibility: ${mod.id}.${listName} references unknown mod '${referencedToken}'`);
    }
    if (canonicalId === mod.id) {
      throw new Error(`codex-mod-compatibility: ${mod.id}.${listName} must not reference itself`);
    }
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    out.push(canonicalId);
  }
  return out;
}

function loadModCatalog(options) {
  const modsRoot = path.resolve(options.modsRoot);
  const loaderRoot = path.resolve(options.loaderRoot);
  const capabilityRegistry = loadCapabilityRegistry(loaderRoot);
  if (!fs.existsSync(modsRoot)) {
    throw new Error(`codex-mod-compatibility: missing mods root: ${modsRoot}`);
  }

  const entries = fs
    .readdirSync(modsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const mods = [];
  const modIds = new Set();
  for (const dirName of entries) {
    const modDir = path.join(modsRoot, dirName);
    const manifestPath = path.join(modDir, "mod.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath, `mod ${dirName}`);
    if (!manifest || typeof manifest !== "object" || Number(manifest.schemaVersion) !== 1) {
      throw new Error(`codex-mod-compatibility: invalid manifest for ${dirName}`);
    }
    const id = normalizePathString(manifest.id || "");
    if (!id) throw new Error(`codex-mod-compatibility: missing id in ${manifestPath}`);
    if (id !== dirName) {
      throw new Error(`codex-mod-compatibility: id mismatch (${id} != ${dirName})`);
    }
    if (modIds.has(id)) {
      throw new Error(`codex-mod-compatibility: duplicate mod id '${id}'`);
    }
    modIds.add(id);

    const entrypoints = normalizeEntrypoints(manifest, id, modDir);

    const capabilities = normalizeCapabilities(manifest, id, capabilityRegistry);
    if (entrypoints.renderer.length > 0 && capabilities.renderer.length < 1) {
      throw new Error(`codex-mod-compatibility: ${id} renderer entry requires renderer capabilities`);
    }
    if (entrypoints.main.length > 0 && capabilities.main.length < 1) {
      throw new Error(`codex-mod-compatibility: ${id} main entry requires main capabilities`);
    }

    const mod = {
      id,
      name: normalizePathString(manifest.name || ""),
      description: normalizePathString(manifest.description || ""),
      version: normalizePathString(manifest.version || ""),
      authors: normalizeFlexibleStringList(manifest.authors, `${id}.authors`),
      contact: normalizeContactObject(manifest.contact, `${id}.contact`),
      licenses: normalizeFlexibleStringList(manifest.license, `${id}.license`),
      environment: normalizePathString(manifest.environment || "*") || "*",
      iconPath: normalizePathString(manifest.icon || ""),
      provides: normalizeFlexibleStringList(manifest.provides, `${id}.provides`),
      enabled: manifest.enabled !== false,
      priority: normalizePriority(manifest.priority, id),
      entrypoints,
      rootPath: modDir,
      manifestPath,
      compatibility: normalizeCompatibility(manifest, id),
      capabilities,
      conflicts: normalizeStringList(manifest.conflicts, `${id}.conflicts`),
      dependencies: normalizeStringList(manifest.dependencies, `${id}.dependencies`),
      softIncompatibilities: normalizeStringList(manifest.softIncompatibilities, `${id}.softIncompatibilities`),
      loadAfter: normalizeStringList(manifest.loadAfter, `${id}.loadAfter`),
      loadBefore: normalizeStringList(manifest.loadBefore, `${id}.loadBefore`),
    };
    mods.push(mod);
  }

  const aliasToId = new Map();
  for (const mod of mods) {
    registerModToken(aliasToId, mod.id, mod.id, "mod id");
  }
  for (const mod of mods) {
    for (const providedId of mod.provides) {
      registerModToken(aliasToId, providedId, mod.id, `${mod.id}.provides`);
    }
  }
  for (const mod of mods) {
    for (const listName of ["conflicts", "dependencies", "softIncompatibilities", "loadAfter", "loadBefore"]) {
      mod[listName] = canonicalizeReferenceList(mod, listName, mod[listName], aliasToId);
    }
  }

  return {
    modsRoot,
    loaderRoot,
    capabilityRegistry,
    aliasToId,
    mods,
  };
}

function resolveBuildContext(input) {
  const snapshotLabel = normalizePathString(input.snapshotLabel || "");
  const appVersion = normalizePathString(input.appVersion || "");
  const buildNumber = normalizePathString(input.buildNumber || "");
  const buildHint = parseBuildHint(buildNumber, appVersion, snapshotLabel);
  const knownBuilds = readKnownBuilds();
  const matchedBuild =
    knownBuilds.find((build) => build.appVersion === appVersion && build.buildNumber === buildNumber) ||
    knownBuilds.find((build) => build.appVersion === appVersion) ||
    knownBuilds.find((build) => build.buildHint === buildHint) ||
    null;
  return {
    snapshotLabel,
    appVersion,
    buildNumber,
    buildHint,
    matchedBuild,
    knownBuilds,
  };
}

function matchesBuild(mod, buildContext) {
  const compatibility = mod.compatibility;
  if (compatibility.appVersionRegex) {
    const matcher = new RegExp(compatibility.appVersionRegex, "i");
    if (buildContext.appVersion && !matcher.test(buildContext.appVersion)) {
      return { compatible: false, reason: `appVersion !~ /${compatibility.appVersionRegex}/` };
    }
  }
  if (compatibility.minBuild > 0 && buildContext.buildHint < compatibility.minBuild) {
    return { compatible: false, reason: `buildHint<minBuild(${compatibility.minBuild})` };
  }
  if (compatibility.maxBuild > 0 && buildContext.buildHint > compatibility.maxBuild) {
    return { compatible: false, reason: `buildHint>maxBuild(${compatibility.maxBuild})` };
  }
  return { compatible: true, reason: "" };
}

function resolveRecommendedDisabled(selectedMods, softPairs) {
  const byId = new Map(selectedMods.map((mod) => [mod.id, mod]));
  const recommended = new Map();
  for (const pair of softPairs) {
    const left = byId.get(pair.left);
    const right = byId.get(pair.right);
    if (!left || !right) continue;
    const disable =
      left.priority !== right.priority
        ? (left.priority > right.priority ? left : right)
        : (left.id.localeCompare(right.id) > 0 ? left : right);
    recommended.set(disable.id, {
      id: disable.id,
      reason: `soft-incompatible with ${disable.id === left.id ? right.id : left.id}`,
    });
  }
  return [...recommended.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function topoSort(selectedMods) {
  const byId = new Map(selectedMods.map((mod) => [mod.id, mod]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const mod of selectedMods) {
    incoming.set(mod.id, new Set());
    outgoing.set(mod.id, new Set());
  }
  for (const mod of selectedMods) {
    for (const afterId of mod.loadAfter) {
      if (!byId.has(afterId)) continue;
      outgoing.get(afterId).add(mod.id);
      incoming.get(mod.id).add(afterId);
    }
    for (const beforeId of mod.loadBefore) {
      if (!byId.has(beforeId)) continue;
      outgoing.get(mod.id).add(beforeId);
      incoming.get(beforeId).add(mod.id);
    }
  }

  const ready = selectedMods
    .filter((mod) => incoming.get(mod.id).size === 0)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const ordered = [];
  while (ready.length > 0) {
    const current = ready.shift();
    ordered.push(current);
    for (const nextId of outgoing.get(current.id)) {
      const incomingSet = incoming.get(nextId);
      incomingSet.delete(current.id);
      if (incomingSet.size === 0) {
        ready.push(byId.get(nextId));
        ready.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
      }
    }
  }
  if (ordered.length !== selectedMods.length) {
    const unresolved = selectedMods.filter((mod) => !ordered.find((entry) => entry.id === mod.id)).map((mod) => mod.id).sort();
    throw new Error(`codex-mod-compatibility: load order cycle detected: ${unresolved.join(", ")}`);
  }
  return ordered;
}

function resolveRuntimeModCompatibility(input) {
  const catalog = loadModCatalog({
    modsRoot: input.modsRoot,
    loaderRoot: input.loaderRoot,
  });
  const buildContext = resolveBuildContext(input);
  const enabledOnlyIds = new Set(
    Array.isArray(input.enabledOnlyIds)
      ? input.enabledOnlyIds.map((value) => normalizePathString(value)).filter(Boolean).map((value) => catalog.aliasToId.get(value) || value)
      : [],
  );
  const disabledIds = new Set(
    Array.isArray(input.disabledIds)
      ? input.disabledIds.map((value) => normalizePathString(value)).filter(Boolean).map((value) => catalog.aliasToId.get(value) || value)
      : [],
  );

  const compatibleMods = [];
  const incompatibleMods = new Map();
  function markIncompatible(id, reason) {
    incompatibleMods.set(id, { id, reason });
  }
  for (const mod of catalog.mods) {
    if (enabledOnlyIds.size > 0 && !enabledOnlyIds.has(mod.id)) continue;
    if (disabledIds.has(mod.id)) continue;
    if (!mod.enabled) continue;
    const verdict = matchesBuild(mod, buildContext);
    if (verdict.compatible) {
      compatibleMods.push(mod);
    } else {
      markIncompatible(mod.id, verdict.reason);
    }
  }

  let selected = compatibleMods;
  let changed = true;
  while (changed) {
    changed = false;
    const selectedIds = new Set(selected.map((mod) => mod.id));
    const nextSelected = [];
    for (const mod of selected) {
      const missing = mod.dependencies.filter((dependencyId) => !selectedIds.has(dependencyId));
      if (missing.length > 0) {
        markIncompatible(mod.id, `missing dependencies: ${missing.join(", ")}`);
        changed = true;
        continue;
      }
      nextSelected.push(mod);
    }
    selected = nextSelected;
  }

  const selectedIds = new Set(selected.map((mod) => mod.id));
  const conflicts = [];
  const conflictPairs = new Set();
  const softPairs = [];
  for (const mod of selected) {
    for (const conflictId of mod.conflicts) {
      if (selectedIds.has(conflictId)) {
        const pairKey = [mod.id, conflictId].sort().join("::");
        if (!conflictPairs.has(pairKey)) {
          conflictPairs.add(pairKey);
          conflicts.push({ left: mod.id, right: conflictId });
        }
      }
    }
    for (const softId of mod.softIncompatibilities) {
      if (selectedIds.has(softId)) {
        const pairKey = [mod.id, softId].sort().join("::");
        if (!softPairs.find((item) => [item.left, item.right].sort().join("::") === pairKey)) {
          softPairs.push({ left: mod.id, right: softId });
        }
      }
    }
  }
  if (conflicts.length > 0) {
    const detail = conflicts.map((item) => `${item.left} x ${item.right}`).sort().join(", ");
    throw new Error(`codex-mod-compatibility: conflicting selected mods: ${detail}`);
  }

  const loadOrder = topoSort(selected).map((mod) => mod.id);
  return {
    build: buildContext,
    mods: catalog.mods,
    selectedMods: selected,
    selectedModIds: selected.map((mod) => mod.id),
    incompatibleMods: [...incompatibleMods.values()].sort((left, right) => left.id.localeCompare(right.id)),
    loadOrder,
    softIncompatibilities: softPairs,
    recommendedDisabledMods: resolveRecommendedDisabled(selected, softPairs),
  };
}

module.exports = {
  loadCapabilityRegistry,
  loadModCatalog,
  readKnownBuilds,
  resolveBuildContext,
  resolveRuntimeModCompatibility,
};
