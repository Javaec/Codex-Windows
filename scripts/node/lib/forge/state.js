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
const { loadModCatalog } = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs"));
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
function detectLane(entrypoints) {
    if (entrypoints.renderer && entrypoints.main)
        return "mixed";
    if (entrypoints.main)
        return "main";
    return "renderer";
}
function collectEntrypoints(entrypoints) {
    const out = [];
    if (entrypoints.main)
        out.push("main");
    if (entrypoints.renderer)
        out.push("renderer");
    return out;
}
function readRuntimeState(paths) {
    const runtimeDir = paths.repoDistRuntimeDir;
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
function readLatestRuntimeLog(paths, relativeDir) {
    const targetDir = path.join(paths.repoDistRuntimeDir, relativeDir);
    if (!(0, exec_1.fileExists)(targetDir))
        return "";
    const candidates = fs
        .readdirSync(targetDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(targetDir, entry.name))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return candidates[0] || "";
}
function getForgeState(paths, config) {
    const catalog = loadModCatalog({ modsRoot: paths.sourceModsRoot, loaderRoot: paths.sourceModLoaderRoot });
    const runtime = readRuntimeState(paths);
    const runtimeModsRoot = path.join(runtime.runtimeDir, "resources", "mods");
    const runtimeInstalledIds = new Set((0, exec_1.fileExists)(runtimeModsRoot)
        ? fs.readdirSync(runtimeModsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : []);
    const mods = catalog.mods
        .map((mod) => ({
        id: mod.id,
        name: mod.name,
        description: mod.description,
        enabled: mod.enabled,
        priority: mod.priority,
        entrypoints: collectEntrypoints(mod.entrypoints),
        lane: detectLane(mod.entrypoints),
        capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
        manifestPath: mod.manifestPath,
        runtimeInstalled: runtimeInstalledIds.has(mod.id),
    }))
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    return {
        name: config.name,
        mode: config.mode,
        forgeRoot: paths.forgeRoot,
        configPath: paths.configPath,
        logsDir: paths.logsDir,
        runtime,
        mods,
        modCounts: {
            total: mods.length,
            enabled: mods.filter((mod) => mod.enabled).length,
            renderer: mods.filter((mod) => mod.lane === "renderer" || mod.lane === "mixed").length,
            main: mods.filter((mod) => mod.lane === "main" || mod.lane === "mixed").length,
        },
        latestRuntimeLog: readLatestRuntimeLog(paths, path.join("runtime-logs", "with-mods")),
        latestAuthenticatedLog: readLatestRuntimeLog(paths, path.join("runtime-logs-authenticated", "with-mods")),
    };
}
function readLogTail(filePath, maxLines = 120) {
    if (!(0, exec_1.fileExists)(filePath))
        return "";
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).slice(-maxLines).join("\n");
}
