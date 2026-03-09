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
function defaultForgeConfig(paths) {
    return {
        version: 1,
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
    return JSON.parse(raw);
}
