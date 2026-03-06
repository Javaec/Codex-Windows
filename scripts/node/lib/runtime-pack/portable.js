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
exports.startPortableDirectLaunch = void 0;
exports.invokePortableBuild = invokePortableBuild;
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const branding_1 = require("../branding");
const args_1 = require("../args");
const bundle_patches_1 = require("../platform-patches/bundle-patches");
const codex_resources_1 = require("./codex-resources");
const direct_launch_1 = require("./direct-launch");
Object.defineProperty(exports, "startPortableDirectLaunch", { enumerable: true, get: function () { return direct_launch_1.startPortableDirectLaunch; } });
const launchers_1 = require("./launchers");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CODEX_MODS_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods");
const CODEX_MOD_API_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "api");
const CODEX_MOD_LOADER_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader");
function isBusyDirectoryError(error) {
    if (!error || typeof error !== "object")
        return false;
    const code = String(error.code || "").toUpperCase();
    return code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}
function preparePortableOutputDir(distDir, workDir, outputName) {
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
    const fallbackRoot = (0, exec_1.ensureDir)(path.join(workDir, "portable-output"));
    const suffix = Date.now();
    for (const fallbackName of [
        `${outputName}-next`,
        `${outputName}-next-${suffix}`,
        `${outputName}-next-${suffix}-1`,
        `${outputName}-next-${suffix}-2`,
    ]) {
        const fallback = path.join(fallbackRoot, fallbackName);
        try {
            (0, exec_1.removePath)(fallback);
            (0, exec_1.ensureDir)(fallback);
            (0, exec_1.writeWarn)(`Portable output directory is busy: ${primary}; using ${fallback} instead.`);
            return fallback;
        }
        catch (error) {
            if (!isBusyDirectoryError(error))
                throw error;
        }
    }
    throw new Error(`Portable output directory is locked and no fallback path could be prepared. Primary: ${primary}`);
}
async function invokePortableBuild(distDir, nativeDir, appDir, buildNumber, buildFlavor, bundledCliPath, profileName, workDir, appVersion) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = profile === "default";
    const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
    const electronDistDir = path.join(nativeDir, "node_modules", "electron", "dist");
    if (!(0, exec_1.fileExists)(electronDistDir))
        throw new Error("Electron runtime not found.");
    const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
    const outputDir = preparePortableOutputDir(distDir, workDir, outputName);
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
    if (!(0, exec_1.fileExists)(CODEX_MODS_SRC_DIR)) {
        throw new Error(`Codex modpack missing: ${CODEX_MODS_SRC_DIR}`);
    }
    if (!(0, exec_1.fileExists)(CODEX_MOD_API_SRC_DIR)) {
        throw new Error(`Codex mod API missing: ${CODEX_MOD_API_SRC_DIR}`);
    }
    if (!(0, exec_1.fileExists)(CODEX_MOD_LOADER_SRC_DIR)) {
        throw new Error(`Codex mod loader missing: ${CODEX_MOD_LOADER_SRC_DIR}`);
    }
    (0, exec_1.writeInfo)("Bundling Codex mods...");
    (0, exec_1.copyDirectory)(CODEX_MODS_SRC_DIR, path.join(resourcesDir, "mods"));
    (0, exec_1.writeInfo)("Bundling Codex mod API...");
    (0, exec_1.copyDirectory)(CODEX_MOD_API_SRC_DIR, path.join(resourcesDir, "mod-api"));
    (0, exec_1.writeInfo)("Bundling Codex mod loader...");
    (0, exec_1.copyDirectory)(CODEX_MOD_LOADER_SRC_DIR, path.join(resourcesDir, "mod-loader"));
    (0, exec_1.removePath)(path.join(resourcesDir, "default_app.asar"));
    (0, bundle_patches_1.patchMainForWindowsEnvironment)(appDstDir, buildNumber, buildFlavor);
    if (!bundledCliPath || !(0, exec_1.fileExists)(bundledCliPath)) {
        throw new Error("Portable build requires a valid codex.exe source path.");
    }
    (0, exec_1.writeInfo)("Bundling Codex CLI...");
    (0, codex_resources_1.bundleCodexCliResources)(resourcesDir, bundledCliPath);
    const launcherPath = (0, launchers_1.writePortableLauncher)(outputDir, profile);
    for (const requiredLauncher of [
        "Launch-Codex.cmd",
        "Launch-Codex-no-mods.cmd",
        "Launch-Codex-minimal.cmd",
        "Launch-Codex-with-mods.cmd",
        "Launch-Codex-isolated-home.cmd",
    ]) {
        const candidate = path.join(outputDir, requiredLauncher);
        if (!(0, exec_1.fileExists)(candidate)) {
            throw new Error(`Portable launcher missing after packaging: ${candidate}`);
        }
    }
    if (isDefault) {
        (0, launchers_1.pruneStalePortableOutputs)(distDir, outputName);
        (0, launchers_1.writeLatestPortableLaunchers)(distDir, outputDir);
    }
    return { outputDir, launcherPath };
}
