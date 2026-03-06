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
exports.ensureGitOnPath = ensureGitOnPath;
exports.startCodexDirectLaunch = startCodexDirectLaunch;
exports.startPortableDirectLaunch = startPortableDirectLaunch;
const path = __importStar(require("node:path"));
const args_1 = require("../args");
const exec_1 = require("../exec");
function ensureGitOnPath() {
    const candidates = [];
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"));
        candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "git.exe"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe"));
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "git.exe"));
    }
    const gitExe = candidates.find((candidate) => (0, exec_1.fileExists)(candidate));
    if (!gitExe)
        return;
    const gitDir = path.dirname(gitExe);
    const current = (process.env.PATH || "").split(";").map((entry) => entry.trim().toLowerCase());
    if (!current.includes(gitDir.toLowerCase())) {
        process.env.PATH = `${gitDir};${process.env.PATH || ""}`;
        process.env.Path = process.env.PATH;
    }
}
function startCodexDirectLaunch(electronExe, appDir, userDataDir, cacheDir, codexCliPath, buildNumber, buildFlavor, gitCapabilityCachePath) {
    if (!(0, exec_1.fileExists)(electronExe))
        throw new Error(`electron.exe not found: ${electronExe}`);
    const rendererPath = path.join(appDir, "webview", "index.html");
    const rendererUrl = `file:///${rendererPath.replace(/\\/g, "/")}`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_RENDERER_URL = rendererUrl;
    env.ELECTRON_FORCE_IS_PACKAGED = "1";
    env.CODEX_BUILD_NUMBER = buildNumber;
    env.CODEX_BUILD_FLAVOR = buildFlavor;
    env.BUILD_FLAVOR = buildFlavor;
    env.NODE_ENV = "production";
    env.CODEX_CLI_PATH = codexCliPath;
    env.PWD = appDir;
    if (gitCapabilityCachePath)
        env.CODEX_GIT_CAPABILITY_CACHE = gitCapabilityCachePath;
    if (!env.CODEX_MODS_DIR) {
        const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
        const modsDir = path.join(repoRoot, "shared", "codex-mod-loader", "mods");
        if (!(0, exec_1.fileExists)(modsDir)) {
            throw new Error(`Codex mods directory missing: ${modsDir}`);
        }
        env.CODEX_MODS_DIR = modsDir;
    }
    if (!env.CODEX_MOD_API_DIR) {
        const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
        const modApiDir = path.join(repoRoot, "shared", "codex-mod-loader", "api");
        if (!(0, exec_1.fileExists)(modApiDir)) {
            throw new Error(`Codex mod API directory missing: ${modApiDir}`);
        }
        env.CODEX_MOD_API_DIR = modApiDir;
    }
    if (!env.CODEX_MOD_LOADER_DIR) {
        const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
        const modLoaderDir = path.join(repoRoot, "shared", "codex-mod-loader", "loader");
        if (!(0, exec_1.fileExists)(modLoaderDir)) {
            throw new Error(`Codex mod loader directory missing: ${modLoaderDir}`);
        }
        env.CODEX_MOD_LOADER_DIR = modLoaderDir;
    }
    (0, exec_1.ensureDir)(userDataDir);
    (0, exec_1.ensureDir)(cacheDir);
    const result = (0, exec_1.runCommand)(electronExe, [appDir, "--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`], { cwd: appDir, env, capture: false, allowNonZero: true });
    if (result.status !== 0) {
        throw new Error(`Codex process exited with code ${result.status}.`);
    }
}
function composePortablePath(basePath, outputDir) {
    const entries = basePath.split(";").filter(Boolean);
    const seen = new Set();
    const include = (value) => {
        const normalized = value.trim().replace(/^"+|"+$/g, "");
        if (!normalized)
            return;
        if (!(0, exec_1.fileExists)(normalized))
            return;
        const key = normalized.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        entries.unshift(normalized);
    };
    const winRoot = process.env.SystemRoot || "C:\\Windows";
    include(path.join(outputDir, "resources", "path"));
    include(path.join(outputDir, "resources"));
    include(outputDir);
    include(path.join(winRoot, "System32"));
    include(winRoot);
    include(path.join(winRoot, "System32", "Wbem"));
    include(path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"));
    if (process.env.ProgramFiles)
        include(path.join(process.env.ProgramFiles, "PowerShell", "7"));
    if (process.env.ProgramFiles)
        include(path.join(process.env.ProgramFiles, "nodejs"));
    if (process.env["ProgramFiles(x86)"])
        include(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
    if (process.env.APPDATA)
        include(path.join(process.env.APPDATA, "npm"));
    return entries.join(";");
}
function startPortableDirectLaunch(outputDir, profileName) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = profile === "default";
    const userDataDir = path.join(outputDir, isDefault ? "userdata" : `userdata-${profile}`);
    const cacheDir = path.join(outputDir, isDefault ? "cache" : `cache-${profile}`);
    const exePath = path.join(outputDir, "Codex.exe");
    if (!(0, exec_1.fileExists)(exePath))
        throw new Error(`Portable executable not found: ${exePath}`);
    (0, exec_1.ensureDir)(userDataDir);
    (0, exec_1.ensureDir)(cacheDir);
    const env = { ...process.env };
    const normalizedPath = composePortablePath(process.env.PATH || process.env.Path || "", outputDir);
    env.PATH = normalizedPath;
    env.Path = normalizedPath;
    env.PATHEXT = env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
    env.CODEX_WINDOWS_PROFILE = profile;
    env.CODEX_GIT_CAPABILITY_CACHE = path.join(outputDir, "resources", "git-capability-cache.json");
    env.ELECTRON_FORCE_IS_PACKAGED = "1";
    env.NODE_ENV = "production";
    delete env.ELECTRON_RENDERER_URL;
    const codexCliPath = path.join(outputDir, "resources", "codex.exe");
    if (!(0, exec_1.fileExists)(codexCliPath))
        throw new Error(`Portable Codex CLI is missing: ${codexCliPath}`);
    const modsDir = path.join(outputDir, "resources", "mods");
    if (!(0, exec_1.fileExists)(modsDir))
        throw new Error(`Portable modpack is missing: ${modsDir}`);
    const modApiDir = path.join(outputDir, "resources", "mod-api");
    if (!(0, exec_1.fileExists)(modApiDir))
        throw new Error(`Portable mod API is missing: ${modApiDir}`);
    const modLoaderDir = path.join(outputDir, "resources", "mod-loader");
    if (!(0, exec_1.fileExists)(modLoaderDir))
        throw new Error(`Portable mod loader is missing: ${modLoaderDir}`);
    env.CODEX_CLI_PATH = codexCliPath;
    env.CODEX_MODS_DIR = modsDir;
    env.CODEX_MOD_API_DIR = modApiDir;
    env.CODEX_MOD_LOADER_DIR = modLoaderDir;
    const cliProbe = (0, exec_1.runCommand)(codexCliPath, ["--version"], { capture: true, allowNonZero: true });
    if (cliProbe.status !== 0) {
        throw new Error(`Portable Codex CLI failed preflight (exit=${cliProbe.status}): ${(cliProbe.stdout || cliProbe.stderr || "").trim()}`);
    }
    return (0, exec_1.runCommand)(exePath, ["--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`], { cwd: outputDir, env, capture: false, allowNonZero: true }).status;
}
