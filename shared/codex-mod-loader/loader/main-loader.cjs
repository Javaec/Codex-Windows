/* CODEX-MOD-LOADER:main@v1 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  loadCapabilityRegistry,
  loadModCatalog,
  resolveRuntimeModCompatibility,
} = require("../compatibility.cjs");

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

function loadRuntimeMods(modsRoot, loaderRoot, buildHint, appVersion) {
  if (!modsRoot || !fs.existsSync(modsRoot)) return [];
  if (normalizePathString(process.env.CODEX_ENABLE_RUNTIME_MODS || "") !== "1") return [];
  if (normalizePathString(process.env.CODEX_MODS_DISABLED || "") === "1") return [];

  const enabledOnlyIds = parseModSelectionList(process.env.CODEX_MODS_ONLY || "");
  const disabledIds = parseModSelectionList(process.env.CODEX_MODS_EXCLUDE || "");
  const resolved = resolveRuntimeModCompatibility({
    modsRoot,
    loaderRoot,
    appVersion,
    buildNumber: String(buildHint || ""),
    snapshotLabel: "",
    enabledOnlyIds,
    disabledIds,
  });
  for (const recommendation of resolved.recommendedDisabledMods) {
    console.warn(`[codex-mod-loader] recommended disable ${recommendation.id}: ${recommendation.reason}`);
  }
  const byId = new Map(loadModCatalog({ modsRoot, loaderRoot }).mods.map((mod) => [mod.id, mod]));
  return resolved.loadOrder.map((modId) => {
    const mod = byId.get(modId);
    let rendererScript = "";
    if (mod.entrypoints.renderer) {
      const rendererEntryPath = path.join(modsRoot, mod.id, mod.entrypoints.renderer);
      rendererScript = fs.readFileSync(rendererEntryPath, "utf8").replace(/^\uFEFF/, "");
    }
    return {
      id: mod.id,
      priority: mod.priority,
      rendererScript,
      mainEntryPath: mod.entrypoints.main ? path.join(modsRoot, mod.id, mod.entrypoints.main) : "",
      conflicts: mod.conflicts,
      requiredCapabilities: mod.capabilities,
    };
  });
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

  const injectionStateByWebContents = new WeakMap();

  function getInjectionState(contents) {
    let state = injectionStateByWebContents.get(contents);
    if (!state) {
      state = { generation: 0, injected: new Set(), needsAppServerRestart: false };
      injectionStateByWebContents.set(contents, state);
    }
    return state;
  }

  function resetInjectionState(contents, reason) {
    const state = getInjectionState(contents);
    state.generation += 1;
    state.injected = new Set();
    if (reason === "render-process-gone") {
      state.needsAppServerRestart = true;
      console.warn(`[codex-mod-loader] renderer injection state reset after ${reason}`);
    }
  }

  electron.app.on("web-contents-created", (_event, contents) => {
    if (!contents || typeof contents.executeJavaScript !== "function") return;
    const inject = async (expectedGeneration) => {
      const currentUrl = typeof contents.getURL === "function" ? String(contents.getURL() || "") : "";
      if (currentUrl.startsWith("devtools://")) return;

      const state = getInjectionState(contents);
      if (expectedGeneration !== state.generation) return;
      const injected = state.injected;
      if (!injected.has("__renderer_api_v1__")) {
        await contents.executeJavaScript(`/* CODEX-MOD-API:renderer */\n${rendererApiScript}\n`, true);
        if (expectedGeneration !== state.generation) return;
        injected.add("__renderer_api_v1__");
      }
      if (usabilityProbeScript && !injected.has("__usability_probe_v1__")) {
        await contents.executeJavaScript(`/* CODEX-MOD-LOADER:usability-probe */\n${usabilityProbeScript}\n`, true);
        if (expectedGeneration !== state.generation) return;
        injected.add("__usability_probe_v1__");
      }

      for (const mod of rendererMods || []) {
        if (injected.has(mod.id)) continue;
        await contents.executeJavaScript(`/* CODEX-MOD:${mod.id} */\n${mod.script}\n`, true);
        if (expectedGeneration !== state.generation) return;
        injected.add(mod.id);
      }

      if (state.needsAppServerRestart) {
        await contents.executeJavaScript(
          `(async()=>{` +
          `const bridge=window.electronBridge;` +
          `if(!bridge||typeof bridge.sendMessageFromView!=='function') return;` +
          `let hostId='local';` +
          `try{hostId=new URL(String(window.location.href||'')).searchParams.get('hostId')||'local';}catch{hostId='local';}` +
          `await bridge.sendMessageFromView({type:'codex-app-server-restart',hostId});` +
          `})()`,
          true,
        ).catch((error) => {
          console.error("[codex-mod-loader] app-server restart after renderer recovery failed", error);
        });
        if (expectedGeneration !== state.generation) return;
        state.needsAppServerRestart = false;
        console.warn("[codex-mod-loader] requested app-server restart after renderer recovery");
      }
    };

    const scheduleInject = () => {
      const state = getInjectionState(contents);
      const expectedGeneration = state.generation;
      Promise.resolve()
        .then(() => inject(expectedGeneration))
        .catch((error) => {
          console.error("[codex-mod-loader] inject failed", error);
        });
    };

    contents.on("dom-ready", () => {
      scheduleInject();
    });
    contents.on("did-finish-load", () => {
      scheduleInject();
    });
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame === true && isInPlace !== true) {
        resetInjectionState(contents, "main-frame-navigation");
      }
    });
    contents.on("render-process-gone", () => {
      resetInjectionState(contents, "render-process-gone");
    });
    contents.on("destroyed", () => {
      injectionStateByWebContents.delete(contents);
    });
  });
}

function activateRuntimeMods(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const electron = ctx.electron;
  const buildHint = typeof ctx.buildHint === "number" ? ctx.buildHint : 0;
  const appVersion = normalizePathString(ctx.appVersion || "");
  const resourcesRoot = normalizePathString(ctx.resourcesRoot || "");
  const minimalPlatform = ctx.minimalPlatform === true;

  if (!electron || typeof electron !== "object") {
    throw new Error("codex-mod-loader: missing electron handle");
  }
  if (!resourcesRoot) {
    throw new Error("codex-mod-loader: missing resourcesRoot");
  }

  const modLoaderRootPath = resolveRuntimeDirectory("mod-loader", "CODEX_MOD_LOADER_DIR", resourcesRoot);
  const modsRootPath = resolveRuntimeDirectory("mods", "CODEX_MODS_DIR", resourcesRoot);
  const modApiRootPath = resolveRuntimeDirectory("mod-api", "CODEX_MOD_API_DIR", resourcesRoot);
  const rendererApiScript = loadRendererApiScript(modApiRootPath);
  const usabilityProbeScript = loadOptionalUsabilityProbeScript(modLoaderRootPath);
  if (minimalPlatform) {
    installRendererMods(electron, rendererApiScript, [], usabilityProbeScript);
    return { modsRootPath, modApiRootPath, modLoaderRootPath, loadedModCount: 0 };
  }

  const createMainModApi = loadCreateMainModApi(modApiRootPath);
  const loadedMods = loadRuntimeMods(modsRootPath, modLoaderRootPath, buildHint, appVersion);
  applyMainMods(electron, loadedMods, buildHint, createMainModApi);
  const rendererMods = loadedMods.filter((mod) => mod.rendererScript).map((mod) => ({ id: mod.id, script: mod.rendererScript }));
  installRendererMods(electron, rendererApiScript, rendererMods, usabilityProbeScript);
  return { modsRootPath, modApiRootPath, modLoaderRootPath, loadedModCount: loadedMods.length };
}

module.exports = {
  activateRuntimeMods,
};
