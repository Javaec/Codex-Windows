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
exports.getForgeState = getForgeState;
exports.readLogTail = readLogTail;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const paths_1 = require("./paths");
const resolution_1 = require("./resolution");
const runtime_registry_1 = require("./runtime-registry");
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
function readRuntimeState(paths, config) {
    const runtimeDir = (0, paths_1.resolveForgeRuntimeDir)(paths, config);
    const metadataPath = path.join(runtimeDir, "build-metadata.json");
    const metadata = readJson(metadataPath, {});
    return {
        exists: (0, exec_1.fileExists)(runtimeDir),
        runtimeDir,
        buildMetadataPath: metadataPath,
        appVersion: typeof metadata.appVersion === "string" ? metadata.appVersion : "",
        buildNumber: typeof metadata.buildNumber === "string" ? metadata.buildNumber : "",
        patchProfileId: typeof metadata.patchProfileId === "string" ? metadata.patchProfileId : "",
        cliSource: typeof metadata.codexCliSource === "string" ? metadata.codexCliSource : "",
        rgPath: path.join(runtimeDir, "resources", "rg.exe"),
        rgExists: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "rg.exe")),
        hasModApi: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "mod-api")),
        hasModLoader: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "mod-loader")),
        hasCompatibilityHelper: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "compatibility.cjs")),
        hasVersionIdentity: (0, exec_1.fileExists)(path.join(runtimeDir, "resources", "version-identity")),
        launchers: {
            default: (0, exec_1.fileExists)(path.join(runtimeDir, "Launch-Codex.cmd")),
            noMods: (0, exec_1.fileExists)(path.join(runtimeDir, "Launch-Codex-no-mods.cmd")),
            withMods: (0, exec_1.fileExists)(path.join(runtimeDir, "Launch-Codex-with-mods.cmd")),
            minimal: (0, exec_1.fileExists)(path.join(runtimeDir, "Launch-Codex-minimal.cmd")),
            isolatedHome: (0, exec_1.fileExists)(path.join(runtimeDir, "Launch-Codex-isolated-home.cmd")),
        },
    };
}
function readLatestRuntimeLog(runtimeDir, relativeDir) {
    const targetDir = path.join(runtimeDir, relativeDir);
    if (!(0, exec_1.fileExists)(targetDir))
        return "";
    const candidates = fs
        .readdirSync(targetDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(targetDir, entry.name))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return candidates[0] || "";
}
function mapRuntimeInstall(install, currentInstallId) {
    return {
        id: install.id,
        label: install.label,
        description: install.description,
        source: install.source,
        runtimeDir: install.runtimeDir,
        appVersion: install.appVersion,
        buildNumber: install.buildNumber,
        patchProfileId: install.patchProfileId,
        cliSource: install.cliSource,
        rgExists: install.rgExists,
        hasModPlatform: install.hasModApi && install.hasModLoader && install.hasCompatibilityHelper && install.hasVersionIdentity,
        active: install.id === currentInstallId,
        capturedAtIso: install.capturedAtIso,
    };
}
function buildComponentState(runtime, installCount) {
    return [
        {
            id: "codex-forge",
            name: "Codex Forge",
            description: "Launcher shell, runtime graph, and external loader state.",
            version: "repo-dev",
            source: "workspace",
            status: "ready",
        },
        {
            id: "codex-desktop-runtime",
            name: "Codex Desktop Runtime",
            description: "Current packaged Codex runtime managed by Forge.",
            version: runtime.appVersion && runtime.buildNumber ? `${runtime.appVersion} (${runtime.buildNumber})` : runtime.appVersion || "unknown",
            source: runtime.patchProfileId || "repo-dist",
            status: runtime.exists ? "ready" : "missing",
        },
        {
            id: "codex-cli",
            name: "Codex CLI",
            description: "Bundled CLI used by the packaged runtime.",
            version: runtime.cliSource || "unknown",
            source: runtime.cliSource || "unknown",
            status: runtime.cliSource ? "ready" : "degraded",
        },
        {
            id: "ripgrep",
            name: "Ripgrep",
            description: "Fast code search tool exposed to the runtime.",
            version: runtime.rgExists ? "bundled" : "missing",
            source: runtime.rgPath,
            status: runtime.rgExists ? "ready" : "missing",
        },
        {
            id: "mod-loader-platform",
            name: "Mod Loader Platform",
            description: "Shared mod API, loader, compatibility helper, and version identity.",
            version: "v1",
            source: "shared/codex-mod-loader",
            status: runtime.hasModApi && runtime.hasModLoader && runtime.hasCompatibilityHelper && runtime.hasVersionIdentity ? "ready" : "degraded",
        },
        {
            id: "runtime-registry",
            name: "Runtime Registry",
            description: "Forge-managed list of runtime installs and the active runtime pointer.",
            version: `${installCount} install${installCount === 1 ? "" : "s"}`,
            source: "codex-forge/runtime/registry.json",
            status: installCount > 0 ? "ready" : "degraded",
        },
    ];
}
function getForgeState(paths, config) {
    const runtimeRegistryState = (0, runtime_registry_1.ensureForgeRuntimeRegistry)(paths, config);
    const effectiveConfig = runtimeRegistryState.config;
    const resolvedGraph = (0, resolution_1.resolveForgeModGraph)(paths, effectiveConfig);
    const runtime = readRuntimeState(paths, effectiveConfig);
    const runtimeModsRoot = path.join(runtime.runtimeDir, "resources", "mods");
    const runtimeInstalledIds = new Set((0, exec_1.fileExists)(runtimeModsRoot)
        ? fs.readdirSync(runtimeModsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : []);
    const mods = resolvedGraph.discoveredMods
        .map((mod) => ({
        id: mod.id,
        name: mod.name,
        description: mod.description,
        version: mod.version,
        authors: [...mod.authors],
        licenses: [...mod.licenses],
        environment: mod.environment,
        provides: [...mod.provides],
        enabled: mod.userEnabled,
        selected: mod.selected,
        enabledInManifest: mod.enabledInManifest,
        priority: mod.priority,
        entrypoints: [...mod.entrypoints],
        lane: mod.lane,
        capabilities: [...mod.capabilities],
        manifestPath: mod.manifestPath,
        rootPath: mod.rootPath,
        runtimeInstalled: runtimeInstalledIds.has(mod.id),
        disableReason: mod.disableReason,
    }))
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    return {
        name: config.name,
        mode: config.mode,
        forgeRoot: paths.forgeRoot,
        configPath: paths.configPath,
        logsDir: paths.logsDir,
        launchProfiles: effectiveConfig.launchProfiles,
        runtime,
        runtimeRegistry: {
            currentInstallId: runtimeRegistryState.registry.currentInstallId,
            installCount: runtimeRegistryState.registry.installs.length,
            installs: runtimeRegistryState.registry.installs
                .map((install) => mapRuntimeInstall(install, runtimeRegistryState.registry.currentInstallId))
                .sort((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label)),
        },
        components: buildComponentState(runtime, runtimeRegistryState.registry.installs.length),
        mods,
        modCounts: {
            total: mods.length,
            enabled: mods.filter((mod) => mod.enabled).length,
            selected: mods.filter((mod) => mod.selected).length,
            renderer: mods.filter((mod) => mod.lane === "renderer" || mod.lane === "mixed").length,
            main: mods.filter((mod) => mod.lane === "main" || mod.lane === "mixed").length,
        },
        resolution: {
            appVersion: resolvedGraph.build.appVersion,
            buildNumber: resolvedGraph.build.buildNumber,
            buildHint: resolvedGraph.build.buildHint,
            loadOrder: [...resolvedGraph.loadOrder],
            disabledByUserIds: [...resolvedGraph.disabledByUserIds],
            incompatibleMods: resolvedGraph.incompatibleMods.map((item) => ({ ...item })),
            recommendedDisabledMods: resolvedGraph.recommendedDisabledMods.map((item) => ({ ...item })),
            softIncompatibilities: resolvedGraph.softIncompatibilities.map((item) => ({ ...item })),
        },
        latestRuntimeLog: readLatestRuntimeLog(runtime.runtimeDir, path.join("runtime-logs", "with-mods")),
        latestAuthenticatedLog: readLatestRuntimeLog(runtime.runtimeDir, path.join("runtime-logs-authenticated", "with-mods")),
    };
}
function readLogTail(filePath, maxLines = 120) {
    if (!(0, exec_1.fileExists)(filePath))
        return "";
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).slice(-maxLines).join("\n");
}
