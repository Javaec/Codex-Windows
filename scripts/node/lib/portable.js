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
exports.startPortableDirectLaunch = startPortableDirectLaunch;
exports.invokePortableBuild = invokePortableBuild;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const branding_1 = require("./branding");
const args_1 = require("./args");
const launch_1 = require("./launch");
function composePortablePath(basePath, outputDir) {
    const entries = basePath.split(";").filter(Boolean);
    const seen = new Set();
    const include = (value) => {
        const normalized = value.trim().replace(/^"+|"+$/g, "");
        if (!normalized)
            return;
        if (!fs.existsSync(normalized))
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
function bundleCodexCliResources(resourcesDir, bundledCliPath) {
    const cliSrcDir = path.dirname(bundledCliPath);
    (0, exec_1.copyFileSafe)(bundledCliPath, path.join(resourcesDir, "codex.exe"));
    for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
        if (!entry.isFile())
            continue;
        if (entry.name.toLowerCase() === path.basename(bundledCliPath).toLowerCase())
            continue;
        (0, exec_1.copyFileSafe)(path.join(cliSrcDir, entry.name), path.join(resourcesDir, entry.name));
    }
    const vendorArchDir = path.resolve(cliSrcDir, "..");
    const vendorPathDir = path.join(vendorArchDir, "path");
    if ((0, exec_1.fileExists)(vendorPathDir)) {
        (0, exec_1.writeInfo)("Bundling Codex CLI companion tools...");
        (0, exec_1.copyDirectory)(vendorPathDir, path.join(resourcesDir, "path"));
    }
}
function isBusyDirectoryError(error) {
    if (!error || typeof error !== "object")
        return false;
    const code = String(error.code || "").toUpperCase();
    return code === "EBUSY" || code === "EPERM";
}
function preparePortableOutputDir(distDir, outputName) {
    const primary = path.join(distDir, outputName);
    try {
        (0, exec_1.removePath)(primary);
        (0, exec_1.ensureDir)(primary);
        return primary;
    }
    catch (error) {
        if (!isBusyDirectoryError(error))
            throw error;
    }
    const fallbackName = `${outputName}-next`;
    const fallback = path.join(distDir, fallbackName);
    (0, exec_1.removePath)(fallback);
    (0, exec_1.ensureDir)(fallback);
    (0, exec_1.writeWarn)(`Portable output directory is busy: ${primary}; using ${fallback} instead.`);
    return fallback;
}
function writePortableLauncher(outputDir, profileName) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = profile === "default";
    const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
    const cacheFolder = isDefault ? "cache" : `cache-${profile}`;
    const launcherPath = path.join(outputDir, "Launch-Codex.cmd");
    const launcher = `@echo off
setlocal

set "BASE=%~dp0"
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\\Windows"

set "PATH=%WINROOT%\\System32;%WINROOT%;%WINROOT%\\System32\\Wbem;%WINROOT%\\System32\\WindowsPowerShell\\v1.0;%ProgramFiles%\\PowerShell\\7;%ProgramFiles%\\nodejs;%ProgramFiles(x86)%\\nodejs;%APPDATA%\\npm;%PATH%"
set "PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
set "COMSPEC=%WINROOT%\\System32\\cmd.exe"

if exist "%ProgramFiles%\\PowerShell\\7\\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles%\\PowerShell\\7\\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" set "CODEX_PWSH_PATH=%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

if exist "%BASE%resources\\codex.exe" set "CODEX_CLI_PATH=%BASE%resources\\codex.exe"
set "CODEX_WINDOWS_PROFILE=${profile}"
set "CODEX_GIT_CAPABILITY_CACHE=%BASE%resources\\git-capability-cache.json"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"

if not exist "%BASE%${userDataFolder}" mkdir "%BASE%${userDataFolder}" >nul 2>nul
if not exist "%BASE%${cacheFolder}" mkdir "%BASE%${cacheFolder}" >nul 2>nul

"%BASE%Codex.exe" --enable-logging --user-data-dir="%BASE%${userDataFolder}" --disk-cache-dir="%BASE%${cacheFolder}"
exit /b %ERRORLEVEL%
`;
    fs.writeFileSync(launcherPath, launcher, "ascii");
    return launcherPath;
}
function startPortableDirectLaunch(outputDir, profileName) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = profile === "default";
    const userDataFolder = isDefault ? "userdata" : `userdata-${profile}`;
    const cacheFolder = isDefault ? "cache" : `cache-${profile}`;
    const exePath = path.join(outputDir, "Codex.exe");
    if (!(0, exec_1.fileExists)(exePath))
        throw new Error(`Portable executable not found: ${exePath}`);
    const userDataDir = path.join(outputDir, userDataFolder);
    const cacheDir = path.join(outputDir, cacheFolder);
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
    const codexCliPath = path.join(outputDir, "resources", "codex.exe");
    if (!(0, exec_1.fileExists)(codexCliPath)) {
        throw new Error(`Portable Codex CLI is missing: ${codexCliPath}`);
    }
    env.CODEX_CLI_PATH = codexCliPath;
    const cliProbe = (0, exec_1.runCommand)(codexCliPath, ["--version"], { capture: true, allowNonZero: true });
    if (cliProbe.status !== 0) {
        throw new Error(`Portable Codex CLI failed preflight (exit=${cliProbe.status}): ${(cliProbe.stdout || cliProbe.stderr || "").trim()}`);
    }
    const status = (0, exec_1.runCommand)(exePath, ["--enable-logging", `--user-data-dir=${userDataDir}`, `--disk-cache-dir=${cacheDir}`], { cwd: outputDir, env, capture: false, allowNonZero: true }).status;
    return status;
}
async function invokePortableBuild(distDir, nativeDir, appDir, buildNumber, buildFlavor, bundledCliPath, profileName, workDir, appVersion) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = profile === "default";
    const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
    const electronDistDir = path.join(nativeDir, "node_modules", "electron", "dist");
    if (!(0, exec_1.fileExists)(electronDistDir))
        throw new Error("Electron runtime not found.");
    const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
    const outputDir = preparePortableOutputDir(distDir, outputName);
    (0, exec_1.writeInfo)("Copying Electron runtime...");
    (0, exec_1.copyDirectory)(electronDistDir, outputDir);
    const srcExe = path.join(outputDir, "electron.exe");
    const dstExe = path.join(outputDir, "Codex.exe");
    if ((0, exec_1.fileExists)(srcExe)) {
        (0, exec_1.movePathSafe)(srcExe, dstExe);
    }
    else if (!(0, exec_1.fileExists)(dstExe)) {
        throw new Error("electron.exe not found in Electron dist.");
    }
    const codexIcon = (0, branding_1.resolveDefaultCodexIconPath)();
    if (codexIcon) {
        (0, branding_1.copyCodexIconToOutput)(codexIcon, outputDir);
    }
    else {
        (0, exec_1.writeWarn)("codex.ico not found; app may keep default Electron icon.");
    }
    const branded = await (0, branding_1.applyExecutableBranding)(dstExe, {
        productName: "Codex",
        fileDescription: "Codex by OpenAI",
        appVersion,
        iconPath: codexIcon,
        workDir,
    });
    if (!branded) {
        (0, exec_1.writeWarn)("Executable branding skipped or failed; binary will keep default metadata.");
    }
    (0, exec_1.writeInfo)("Copying app files...");
    const resourcesDir = (0, exec_1.ensureDir)(path.join(outputDir, "resources"));
    const appDstDir = path.join(resourcesDir, "app");
    (0, exec_1.copyDirectory)(appDir, appDstDir);
    const defaultAsar = path.join(resourcesDir, "default_app.asar");
    (0, exec_1.removePath)(defaultAsar);
    (0, launch_1.patchMainForWindowsEnvironment)(appDstDir, buildNumber, buildFlavor);
    if (bundledCliPath && (0, exec_1.fileExists)(bundledCliPath)) {
        (0, exec_1.writeInfo)("Bundling Codex CLI...");
        bundleCodexCliResources(resourcesDir, bundledCliPath);
    }
    else {
        (0, exec_1.writeWarn)("codex.exe not found; portable build will rely on PATH auto-detection.");
    }
    const launcherPath = writePortableLauncher(outputDir, profile);
    return { outputDir, launcherPath };
}
