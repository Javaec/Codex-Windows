/* CODEX-MOD-LOADER:main@v1 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizePathString(value) {
  return typeof value === "string" ? value.trim().replace(/^\"+|\"+$/g, "") : "";
}

function parseModSelectionList(rawValue) {
  if (typeof rawValue !== "string") return [];
  return rawValue
    .split(",")
    .map((value) => normalizePathString(value))
    .filter((value) => value.length > 0);
}

function resolveRuntimeDirectory(leafDir, envKey, resourcesRoot) {
  const resourcesPath = normalizePathString(process.resourcesPath || "");
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, leafDir);
    if (fs.existsSync(bundled)) return bundled;
  }

  const configured = normalizePathString(process.env[envKey] || "");
  if (configured) return path.resolve(configured);

  return path.resolve(resourcesRoot, "..", leafDir);
}

function loadCapabilityRegistry(loaderRoot) {
  const registryPath = path.join(loaderRoot, "capability-registry.json");
  if (!fs.existsSync(registryPath)) {
    throw new Error(`codex-mod-loader: capability registry missing: ${registryPath}`);
  }
  const rawRegistry = fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "");
  const registry = JSON.parse(rawRegistry);
  if (!registry || typeof registry !== "object") {
    throw new Error(`codex-mod-loader: capability registry must be an object: ${registryPath}`);
  }
  if (Number(registry.schemaVersion) !== 1) {
    throw new Error(`codex-mod-loader: capability registry schemaVersion must be 1: ${registryPath}`);
  }
  const renderer = new Set(Array.isArray(registry.renderer) ? registry.renderer.map((value) => normalizePathString(value)).filter(Boolean) : []);
  const main = new Set(Array.isArray(registry.main) ? registry.main.map((value) => normalizePathString(value)).filter(Boolean) : []);
  return { renderer, main, path: registryPath };
}

function normalizeRequiredCapabilities(manifest, id, capabilityRegistry) {
  const rawValue = manifest && manifest.requiresCapabilities;
  if (rawValue === undefined) {
    return { renderer: [], main: [] };
  }
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error(`codex-mod-loader: requiresCapabilities must be an object for ${id}`);
  }

  const normalized = { renderer: [], main: [] };
  for (const lane of ["renderer", "main"]) {
    const rawList = rawValue[lane];
    if (rawList === undefined) continue;
    if (!Array.isArray(rawList)) {
      throw new Error(`codex-mod-loader: requiresCapabilities.${lane} must be an array for ${id}`);
    }
    const seen = new Set();
    for (const item of rawList) {
      const capability = normalizePathString(item);
      if (!capability) {
        throw new Error(`codex-mod-loader: empty ${lane} capability for ${id}`);
      }
      if (!capabilityRegistry[lane].has(capability)) {
        throw new Error(`codex-mod-loader: unknown ${lane} capability for ${id}: ${capability}`);
      }
      if (seen.has(capability)) {
        throw new Error(`codex-mod-loader: duplicated ${lane} capability for ${id}: ${capability}`);
      }
      seen.add(capability);
      normalized[lane].push(capability);
    }
  }
  return normalized;
}

function loadRendererApiScript(modApiRoot) {
  const rendererApiPath = path.join(modApiRoot, "renderer-api.js");
  if (!fs.existsSync(rendererApiPath)) {
    throw new Error(`codex-mod-loader: renderer API missing: ${rendererApiPath}`);
  }
  const script = fs.readFileSync(rendererApiPath, "utf8").replace(/^\uFEFF/, "");
  if (script.trim().length < 32) {
    throw new Error(`codex-mod-loader: renderer API is empty: ${rendererApiPath}`);
  }
  return script;
}

function loadOptionalUsabilityProbeScript(loaderRoot) {
  if (normalizePathString(process.env.CODEX_WINDOWS_USABILITY_SMOKE || "") !== "1") return "";
  const probePath = path.join(loaderRoot, "usability-probe.js");
  if (!fs.existsSync(probePath)) {
    throw new Error(`codex-mod-loader: usability probe missing: ${probePath}`);
  }
  const script = fs.readFileSync(probePath, "utf8").replace(/^\uFEFF/, "");
  if (script.trim().length < 32) {
    throw new Error(`codex-mod-loader: usability probe is empty: ${probePath}`);
  }
  return script;
}

function loadCreateMainModApi(modApiRoot) {
  const mainApiPath = path.join(modApiRoot, "main-api.cjs");
  if (!fs.existsSync(mainApiPath)) {
    throw new Error(`codex-mod-loader: main API missing: ${mainApiPath}`);
  }
  const exported = require(mainApiPath);
  const createMainModApi =
    typeof exported === "function"
      ? exported
      : (exported && typeof exported.createMainModApi === "function" ? exported.createMainModApi : null);
  if (typeof createMainModApi !== "function") {
    throw new Error(`codex-mod-loader: main API must export createMainModApi(): ${mainApiPath}`);
  }
  return createMainModApi;
}

function loadRuntimeMods(modsRoot, buildHint, capabilityRegistry) {
  if (!modsRoot || !fs.existsSync(modsRoot)) return [];
  if (normalizePathString(process.env.CODEX_ENABLE_RUNTIME_MODS || "") !== "1") return [];
  if (normalizePathString(process.env.CODEX_MODS_DISABLED || "") === "1") return [];

  const enabledOnlyIds = new Set(parseModSelectionList(process.env.CODEX_MODS_ONLY || ""));
  const disabledIds = new Set(parseModSelectionList(process.env.CODEX_MODS_EXCLUDE || ""));

  const mods = [];
  const entries = fs.readdirSync(modsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const modDir = path.join(modsRoot, entry.name);
    const manifestPath = path.join(modDir, "mod.json");
    if (!fs.existsSync(manifestPath)) continue;

    const rawManifest = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`codex-mod-loader: failed to parse ${manifestPath}: ${message}`);
    }

    const id = normalizePathString(manifest && manifest.id ? manifest.id : "");
    if (!id) throw new Error(`codex-mod-loader: missing id in ${manifestPath}`);
    if (id !== entry.name) {
      throw new Error(`codex-mod-loader: id mismatch for ${manifestPath} (${id} != ${entry.name})`);
    }
    if (enabledOnlyIds.size > 0 && !enabledOnlyIds.has(id)) continue;
    if (disabledIds.has(id)) continue;
    if (manifest && manifest.enabled === false) continue;

    const priority = Number(manifest && manifest.priority !== undefined ? manifest.priority : 0);
    if (!Number.isFinite(priority)) {
      throw new Error(`codex-mod-loader: invalid priority for ${id} (${manifest && manifest.priority})`);
    }

    const compat = manifest && manifest.compatibility && typeof manifest.compatibility === "object" ? manifest.compatibility : {};
    const minBuild = Number(compat.minBuild !== undefined ? compat.minBuild : 0);
    const maxBuild = Number(compat.maxBuild !== undefined ? compat.maxBuild : 0);
    if (!Number.isFinite(minBuild) || minBuild < 0) throw new Error(`codex-mod-loader: invalid minBuild for ${id}`);
    if (!Number.isFinite(maxBuild) || maxBuild < 0) throw new Error(`codex-mod-loader: invalid maxBuild for ${id}`);
    if (maxBuild > 0 && minBuild > 0 && maxBuild < minBuild) {
      throw new Error(`codex-mod-loader: invalid build range for ${id} (maxBuild < minBuild)`);
    }
    if (buildHint > 0 && minBuild > 0 && buildHint < minBuild) continue;
    if (buildHint > 0 && maxBuild > 0 && buildHint > maxBuild) continue;

    const entrypoints = manifest && manifest.entrypoints && typeof manifest.entrypoints === "object" ? manifest.entrypoints : {};
    const rendererEntry = normalizePathString(entrypoints.renderer || "");
    const mainEntry = normalizePathString(entrypoints.main || "");
    if (!rendererEntry && !mainEntry) {
      throw new Error(`codex-mod-loader: mod has no entrypoints: ${id}`);
    }
    const requiredCapabilities = normalizeRequiredCapabilities(manifest, id, capabilityRegistry);
    if (rendererEntry && requiredCapabilities.renderer.length === 0) {
      throw new Error(`codex-mod-loader: renderer mod ${id} must declare requiresCapabilities.renderer`);
    }
    if (mainEntry && requiredCapabilities.main.length === 0) {
      throw new Error(`codex-mod-loader: main mod ${id} must declare requiresCapabilities.main`);
    }

    let rendererScript = "";
    if (rendererEntry) {
      const rendererEntryPath = path.join(modDir, rendererEntry);
      if (!fs.existsSync(rendererEntryPath)) {
        throw new Error(`codex-mod-loader: missing renderer entry for ${id}: ${rendererEntryPath}`);
      }
      rendererScript = fs.readFileSync(rendererEntryPath, "utf8").replace(/^\uFEFF/, "");
      if (rendererScript.trim().length < 16) {
        throw new Error(`codex-mod-loader: renderer entry is empty for ${id}: ${rendererEntryPath}`);
      }
    }

    let mainEntryPath = "";
    if (mainEntry) {
      mainEntryPath = path.join(modDir, mainEntry);
      if (!fs.existsSync(mainEntryPath)) {
        throw new Error(`codex-mod-loader: missing main entry for ${id}: ${mainEntryPath}`);
      }
    }

    const conflicts = Array.isArray(manifest && manifest.conflicts) ? manifest.conflicts : [];
    const normalizedConflicts = conflicts.map((value) => normalizePathString(value)).filter((value) => value.length > 0);
    mods.push({ id, priority, rendererScript, mainEntryPath, conflicts: normalizedConflicts, requiredCapabilities });
  }

  mods.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return String(left.id).localeCompare(String(right.id));
  });

  const selected = new Set();
  for (const mod of mods) {
    if (selected.has(mod.id)) throw new Error(`codex-mod-loader: duplicate mod id selected: ${mod.id}`);
    selected.add(mod.id);
  }

  for (const mod of mods) {
    for (const conflictId of mod.conflicts) {
      if (!selected.has(conflictId)) continue;
      throw new Error(`codex-mod-loader: conflicting mods selected: ${mod.id} x ${conflictId}`);
    }
  }

  return mods;
}

function applyMainMods(electron, loadedMods, buildHint, createMainModApi) {
  if (!electron || !loadedMods || loadedMods.length === 0) return;
  if (globalThis.__CODEX_MOD_LOADER_MAIN_V1__) return;
  globalThis.__CODEX_MOD_LOADER_MAIN_V1__ = true;

  for (const mod of loadedMods) {
    if (!mod.mainEntryPath) continue;
    const exported = require(mod.mainEntryPath);
    const apply =
      typeof exported === "function"
        ? exported
        : (exported && typeof exported.activate === "function" ? exported.activate : null);
    if (typeof apply !== "function") {
      throw new Error(`codex-mod-loader: main entry for ${mod.id} must export a function (or {activate})`);
    }
    apply(createMainModApi({ electron, buildHint, modId: mod.id, capabilities: mod.requiredCapabilities.main }));
  }
}

function installRendererMods(electron, rendererApiScript, rendererMods, usabilityProbeScript) {
  if (!electron) return;
  const hasRendererMods = Array.isArray(rendererMods) && rendererMods.length > 0;
  const hasUsabilityProbe = typeof usabilityProbeScript === "string" && usabilityProbeScript.trim().length > 0;
  if (!hasRendererMods && !hasUsabilityProbe) return;
  if (globalThis.__CODEX_MOD_LOADER_RENDERER_V1__) return;
  globalThis.__CODEX_MOD_LOADER_RENDERER_V1__ = true;

  const injectedByWebContents = new WeakMap();

  function getInjected(contents) {
    let injected = injectedByWebContents.get(contents);
    if (!injected) {
      injected = new Set();
      injectedByWebContents.set(contents, injected);
    }
    return injected;
  }

  electron.app.on("web-contents-created", (_event, contents) => {
    if (!contents || typeof contents.executeJavaScript !== "function") return;
    const inject = async () => {
      const currentUrl = typeof contents.getURL === "function" ? String(contents.getURL() || "") : "";
      if (currentUrl.startsWith("devtools://")) return;

      const injected = getInjected(contents);
      if (!injected.has("__renderer_api_v1__")) {
        await contents.executeJavaScript(`/* CODEX-MOD-API:renderer */\n${rendererApiScript}\n`, true);
        injected.add("__renderer_api_v1__");
      }
      if (usabilityProbeScript && !injected.has("__usability_probe_v1__")) {
        await contents.executeJavaScript(`/* CODEX-MOD-LOADER:usability-probe */\n${usabilityProbeScript}\n`, true);
        injected.add("__usability_probe_v1__");
      }

      for (const mod of rendererMods || []) {
        if (injected.has(mod.id)) continue;
        await contents.executeJavaScript(`/* CODEX-MOD:${mod.id} */\n${mod.script}\n`, true);
        injected.add(mod.id);
      }
    };

    contents.on("dom-ready", () => {
      Promise.resolve()
        .then(inject)
        .catch((error) => {
          console.error("[codex-mod-loader] inject failed", error);
        });
    });
  });
}

function activateRuntimeMods(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const electron = ctx.electron;
  const buildHint = typeof ctx.buildHint === "number" ? ctx.buildHint : 0;
  const resourcesRoot = normalizePathString(ctx.resourcesRoot || "");
  const minimalPlatform = ctx.minimalPlatform === true;

  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-loader: missing electron handle");
  }
  if (!resourcesRoot) {
    throw new Error("codex-mod-loader: missing resourcesRoot");
  }

  const modLoaderRootPath = resolveRuntimeDirectory("mod-loader", "CODEX_MOD_LOADER_DIR", resourcesRoot);
  const capabilityRegistry = loadCapabilityRegistry(modLoaderRootPath);
  const modsRootPath = resolveRuntimeDirectory("mods", "CODEX_MODS_DIR", resourcesRoot);
  const modApiRootPath = resolveRuntimeDirectory("mod-api", "CODEX_MOD_API_DIR", resourcesRoot);
  const rendererApiScript = loadRendererApiScript(modApiRootPath);
  const usabilityProbeScript = loadOptionalUsabilityProbeScript(modLoaderRootPath);
  if (minimalPlatform) {
    installRendererMods(electron, rendererApiScript, [], usabilityProbeScript);
    return { modsRootPath, modApiRootPath, modLoaderRootPath, loadedModCount: 0 };
  }

  const createMainModApi = loadCreateMainModApi(modApiRootPath);
  const loadedMods = loadRuntimeMods(modsRootPath, buildHint, capabilityRegistry);
  applyMainMods(electron, loadedMods, buildHint, createMainModApi);
  const rendererMods = loadedMods.filter((mod) => mod.rendererScript).map((mod) => ({ id: mod.id, script: mod.rendererScript }));
  installRendererMods(electron, rendererApiScript, rendererMods, usabilityProbeScript);
  return { modsRootPath, modApiRootPath, modLoaderRootPath, loadedModCount: loadedMods.length };
}

module.exports = {
  activateRuntimeMods,
};
