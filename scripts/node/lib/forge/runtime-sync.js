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
exports.syncForgeRuntimeLayer = syncForgeRuntimeLayer;
exports.setForgeModEnabled = setForgeModEnabled;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const launchers_1 = require("../runtime-pack/launchers");
const paths_1 = require("./paths");
const discovery_1 = require("./discovery");
const resolution_1 = require("./resolution");
function syncPath(sourcePath, destinationPath) {
    if (!(0, exec_1.fileExists)(sourcePath))
        return;
    (0, exec_1.removePath)(destinationPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
        (0, exec_1.copyDirectory)(sourcePath, destinationPath);
        return;
    }
    (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
}
function writeJson(filePath, payload) {
    (0, exec_1.ensureDir)(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
function syncForgeRuntimeLayer(paths, config) {
    const targetRuntimeDir = (0, paths_1.resolveForgeRuntimeDir)(paths, config);
    const runtimeArtifactPaths = (0, paths_1.resolveForgeRuntimeArtifactPaths)(targetRuntimeDir);
    const syncedPaths = [];
    const targets = [
        { source: paths.sourceModApiRoot, destination: path.join(targetRuntimeDir, "resources", "mod-api") },
        { source: paths.sourceModLoaderRoot, destination: path.join(targetRuntimeDir, "resources", "mod-loader") },
        { source: paths.sourceCompatibilityPath, destination: path.join(targetRuntimeDir, "resources", "compatibility.cjs") },
        { source: paths.sourceVersionIdentityRoot, destination: path.join(targetRuntimeDir, "resources", "version-identity") },
        { source: paths.sourceModsRoot, destination: path.join(targetRuntimeDir, "resources", "mods") },
    ];
    for (const target of targets) {
        if (!(0, exec_1.fileExists)(target.source))
            continue;
        syncPath(target.source, target.destination);
        syncedPaths.push(target.destination);
    }
    const resolvedGraph = (0, resolution_1.resolveForgeModGraph)(paths, config);
    const discoveredMods = (0, discovery_1.discoverForgeMods)(paths);
    const loaderState = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: "Codex Forge",
        build: resolvedGraph.build,
        disabledIds: resolvedGraph.disabledByUserIds,
        selectedModIds: resolvedGraph.selectedModIds,
        loadOrder: resolvedGraph.loadOrder,
        incompatibleMods: resolvedGraph.incompatibleMods,
        recommendedDisabledMods: resolvedGraph.recommendedDisabledMods,
        softIncompatibilities: resolvedGraph.softIncompatibilities,
        modState: config.modState || {},
    };
    writeJson(runtimeArtifactPaths.runtimeForgeLoaderStatePath, loaderState);
    writeJson(runtimeArtifactPaths.runtimeForgeResolvedGraphPath, resolvedGraph);
    writeJson(runtimeArtifactPaths.runtimeForgeDiscoveredModsPath, discoveredMods);
    writeJson(paths.forgeResolvedGraphPath, resolvedGraph);
    writeJson(paths.forgeDiscoveredModsPath, discoveredMods);
    syncedPaths.push(runtimeArtifactPaths.runtimeForgeLoaderStatePath, runtimeArtifactPaths.runtimeForgeResolvedGraphPath, runtimeArtifactPaths.runtimeForgeDiscoveredModsPath, paths.forgeResolvedGraphPath, paths.forgeDiscoveredModsPath);
    if ((0, exec_1.fileExists)(targetRuntimeDir) && path.resolve(targetRuntimeDir) === path.resolve(paths.repoDistRuntimeDir)) {
        (0, launchers_1.writeLatestPortableLaunchers)(paths.distDir, targetRuntimeDir);
        syncedPaths.push(path.join(paths.distDir, "Launch-Codex-latest.cmd"));
    }
    return {
        syncedPaths,
        targetRuntimeDir,
        loaderStatePath: runtimeArtifactPaths.runtimeForgeLoaderStatePath,
        resolvedGraphPath: runtimeArtifactPaths.runtimeForgeResolvedGraphPath,
        discoveredModsPath: runtimeArtifactPaths.runtimeForgeDiscoveredModsPath,
    };
}
function setForgeModEnabled(paths, config, modId, enabled) {
    const manifestPath = path.join(paths.sourceModsRoot, modId, "mod.json");
    if (!(0, exec_1.fileExists)(manifestPath)) {
        throw new Error(`Forge mod manifest not found: ${manifestPath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    const defaultEnabled = manifest.enabled !== false;
    config.modState = config.modState || {};
    if (enabled === defaultEnabled) {
        delete config.modState[modId];
    }
    else {
        config.modState[modId] = { enabled };
    }
    (0, paths_1.saveForgeConfig)(paths, config);
    syncForgeRuntimeLayer(paths, config);
}
