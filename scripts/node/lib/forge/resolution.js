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
exports.getForgeUserDisabledModIds = getForgeUserDisabledModIds;
exports.resolveForgeModGraph = resolveForgeModGraph;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs"));
function readJson(filePath, fallback) {
    if (!(0, exec_1.fileExists)(filePath))
        return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return fallback;
    }
}
function collectEntrypoints(entrypoints) {
    const out = [];
    if (entrypoints.main)
        out.push("main");
    if (entrypoints.renderer)
        out.push("renderer");
    return out;
}
function detectLane(entrypoints) {
    if (entrypoints.renderer && entrypoints.main)
        return "mixed";
    if (entrypoints.main)
        return "main";
    return "renderer";
}
function readRuntimeBuildContext(paths, config) {
    const runtimeDir = config.runtime.currentDir || paths.repoDistRuntimeDir;
    const metadata = readJson(path.join(runtimeDir, "build-metadata.json"), {});
    return {
        appVersion: typeof metadata.appVersion === "string" ? metadata.appVersion : "",
        buildNumber: typeof metadata.buildNumber === "string" ? metadata.buildNumber : "",
    };
}
function getForgeUserDisabledModIds(config) {
    return Object.entries(config.modState || {})
        .filter(([, state]) => state && state.enabled === false)
        .map(([modId]) => modId)
        .sort((left, right) => left.localeCompare(right));
}
function resolveForgeModGraph(paths, config) {
    const catalog = compatibility.loadModCatalog({
        modsRoot: paths.sourceModsRoot,
        loaderRoot: paths.sourceModLoaderRoot,
    });
    const disabledByUserIds = getForgeUserDisabledModIds(config);
    const buildContext = readRuntimeBuildContext(paths, config);
    const resolved = compatibility.resolveRuntimeModCompatibility({
        modsRoot: paths.sourceModsRoot,
        loaderRoot: paths.sourceModLoaderRoot,
        appVersion: buildContext.appVersion,
        buildNumber: buildContext.buildNumber,
        snapshotLabel: "",
        disabledIds: disabledByUserIds,
    });
    const selectedIds = new Set(resolved.selectedModIds);
    const incompatibleReasons = new Map(resolved.incompatibleMods.map((item) => [item.id, item.reason]));
    const discoveredMods = catalog.mods
        .map((mod) => {
        const override = config.modState && config.modState[mod.id];
        const userEnabled = typeof override?.enabled === "boolean" ? override.enabled : mod.enabled;
        const disableReason = !userEnabled
            ? "disabled in Codex Forge"
            : incompatibleReasons.get(mod.id) || "";
        return {
            id: mod.id,
            name: mod.name,
            description: mod.description,
            priority: mod.priority,
            entrypoints: collectEntrypoints(mod.entrypoints),
            lane: detectLane(mod.entrypoints),
            capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
            manifestPath: mod.manifestPath,
            enabledInManifest: mod.enabled,
            userEnabled,
            selected: selectedIds.has(mod.id),
            disableReason,
        };
    })
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    return {
        build: {
            appVersion: resolved.build.appVersion || buildContext.appVersion,
            buildNumber: resolved.build.buildNumber || buildContext.buildNumber,
            buildHint: typeof resolved.build.buildHint === "number" ? resolved.build.buildHint : 0,
            snapshotLabel: resolved.build.snapshotLabel || "",
            matchedBuildHint: resolved.build.matchedBuild && typeof resolved.build.matchedBuild.buildHint === "number"
                ? String(resolved.build.matchedBuild.buildHint)
                : "",
        },
        discoveredMods,
        selectedModIds: [...resolved.selectedModIds],
        loadOrder: [...resolved.loadOrder],
        disabledByUserIds,
        incompatibleMods: resolved.incompatibleMods.map((item) => ({ ...item })),
        recommendedDisabledMods: resolved.recommendedDisabledMods.map((item) => ({ ...item })),
        softIncompatibilities: resolved.softIncompatibilities.map((item) => ({ ...item })),
    };
}
