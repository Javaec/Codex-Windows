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
exports.resolveForgePaths = resolveForgePaths;
exports.ensureForgeWorkspace = ensureForgeWorkspace;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const context_1 = require("../runner/context");
const DEFAULT_FORGE_ROOT_NAME = "codex-forge";
function defaultLaunchProfiles() {
    return [
        {
            id: "default",
            label: "Safe Default",
            description: "Launch the current runtime without runtime mods.",
        },
        {
            id: "with-mods",
            label: "With Mods",
            description: "Launch the current runtime with the active Forge mod graph.",
        },
        {
            id: "no-mods",
            label: "No Mods",
            description: "Launch a clean lane with dedicated user data and cache.",
        },
        {
            id: "minimal",
            label: "Minimal",
            description: "Launch the reduced Windows minimal lane for runtime diagnostics.",
        },
        {
            id: "isolated-home",
            label: "Isolated Home",
            description: "Launch with an isolated CODEX_HOME inside the portable runtime.",
        },
    ];
}
function defaultForgeConfig(paths) {
    return {
        version: 2,
        name: "Codex Forge",
        mode: "repo-backed-dev",
        runtime: {
            source: "repo-dist",
            currentDir: paths.repoDistRuntimeDir,
        },
        mods: {
            sourceDir: paths.sourceModsRoot,
        },
        logs: {
            rootDir: paths.logsDir,
        },
        modState: {},
        launchProfiles: defaultLaunchProfiles(),
    };
}
function normalizePathString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeModState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const out = {};
    for (const [modId, rawState] of Object.entries(value)) {
        if (!modId || !rawState || typeof rawState !== "object" || Array.isArray(rawState))
            continue;
        const enabled = rawState.enabled;
        if (typeof enabled !== "boolean")
            continue;
        out[modId] = { enabled };
    }
    return out;
}
function normalizeLaunchProfileId(value) {
    switch (value) {
        case "default":
        case "with-mods":
        case "no-mods":
        case "minimal":
        case "isolated-home":
            return value;
        default:
            return null;
    }
}
function normalizeLaunchProfiles(value) {
    if (!Array.isArray(value))
        return defaultLaunchProfiles();
    const out = [];
    const seen = new Set();
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item))
            continue;
        const id = normalizeLaunchProfileId(item.id);
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push({
            id,
            label: normalizePathString(item.label) || defaultLaunchProfiles().find((profile) => profile.id === id).label,
            description: normalizePathString(item.description) ||
                defaultLaunchProfiles().find((profile) => profile.id === id).description,
        });
    }
    if (out.length < 1)
        return defaultLaunchProfiles();
    return out;
}
function normalizeForgeConfig(paths, rawValue) {
    const defaults = defaultForgeConfig(paths);
    const parsed = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
    return {
        version: typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : defaults.version,
        name: normalizePathString(parsed.name) || defaults.name,
        mode: parsed.mode === "repo-backed-dev" ? parsed.mode : defaults.mode,
        runtime: {
            source: parsed.runtime && parsed.runtime.source === "repo-dist" ? parsed.runtime.source : defaults.runtime.source,
            currentDir: normalizePathString(parsed.runtime?.currentDir) || defaults.runtime.currentDir,
        },
        mods: {
            sourceDir: normalizePathString(parsed.mods?.sourceDir) || defaults.mods.sourceDir,
        },
        logs: {
            rootDir: normalizePathString(parsed.logs?.rootDir) || defaults.logs.rootDir,
        },
        modState: normalizeModState(parsed.modState),
        launchProfiles: normalizeLaunchProfiles(parsed.launchProfiles),
    };
}
function resolveForgePaths() {
    const forgeRoot = path.join(context_1.REPO_ROOT, DEFAULT_FORGE_ROOT_NAME);
    return {
        repoRoot: context_1.REPO_ROOT,
        forgeRoot,
        launcherUiDir: path.join(forgeRoot, "launcher"),
        configPath: path.join(forgeRoot, "forge.json"),
        logsDir: path.join(forgeRoot, "logs"),
        cacheDir: path.join(forgeRoot, "cache"),
        runtimeRoot: path.join(forgeRoot, "runtime"),
        runtimeDownloadsDir: path.join(forgeRoot, "downloads"),
        runtimeCurrentDir: path.join(forgeRoot, "runtime", "current"),
        distDir: path.join(context_1.REPO_ROOT, "dist"),
        repoDistRuntimeDir: path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64"),
        sourceModsRoot: path.join(context_1.REPO_ROOT, "shared", "codex-mod-loader", "mods"),
        sourceModApiRoot: path.join(context_1.REPO_ROOT, "shared", "codex-mod-loader", "api"),
        sourceModLoaderRoot: path.join(context_1.REPO_ROOT, "shared", "codex-mod-loader", "loader"),
        sourceCompatibilityPath: path.join(context_1.REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs"),
        sourceVersionIdentityRoot: path.join(context_1.REPO_ROOT, "shared", "version-identity"),
        runtimeForgeStateDir: path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64", "resources", "codex-forge"),
        runtimeForgeLoaderStatePath: path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64", "resources", "codex-forge", "loader-state.json"),
        runtimeForgeResolvedGraphPath: path.join(context_1.REPO_ROOT, "dist", "Codex-win32-x64", "resources", "codex-forge", "resolved-mod-graph.json"),
        forgeResolvedGraphPath: path.join(forgeRoot, "cache", "resolved-mod-graph.json"),
    };
}
function ensureForgeWorkspace(paths) {
    (0, exec_1.ensureDir)(paths.forgeRoot);
    (0, exec_1.ensureDir)(paths.logsDir);
    (0, exec_1.ensureDir)(paths.cacheDir);
    (0, exec_1.ensureDir)(paths.runtimeRoot);
    (0, exec_1.ensureDir)(paths.runtimeDownloadsDir);
    (0, exec_1.ensureDir)(paths.runtimeCurrentDir);
    if (!(0, exec_1.fileExists)(paths.configPath)) {
        fs.writeFileSync(paths.configPath, `${JSON.stringify(defaultForgeConfig(paths), null, 2)}\n`, "utf8");
    }
    const raw = fs.readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, "");
    const normalized = normalizeForgeConfig(paths, JSON.parse(raw));
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    if (raw !== serialized) {
        fs.writeFileSync(paths.configPath, serialized, "utf8");
    }
    return normalized;
}
