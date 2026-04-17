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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const exec_1 = require("../exec");
const branding_1 = require("../branding");
const args_1 = require("../args");
const bundle_patches_1 = require("../platform-patches/bundle-patches");
const codex_resources_1 = require("./codex-resources");
const direct_launch_1 = require("./direct-launch");
Object.defineProperty(exports, "startPortableDirectLaunch", { enumerable: true, get: function () { return direct_launch_1.startPortableDirectLaunch; } });
const launchers_1 = require("./launchers");
const verify_1 = require("./verify");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CODEX_MODS_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "mods");
const CODEX_MOD_API_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "api");
const CODEX_MOD_LOADER_SRC_DIR = path.join(REPO_ROOT, "shared", "codex-mod-loader", "loader");
const CODEX_MOD_COMPATIBILITY_SRC_PATH = path.join(REPO_ROOT, "shared", "codex-mod-loader", "compatibility.cjs");
const CODEX_VERSION_IDENTITY_SRC_DIR = path.join(REPO_ROOT, "shared", "version-identity");
function getFileSha256(targetPath) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    const fd = fs.openSync(targetPath, "r");
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (bytesRead <= 0)
                break;
            hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
    }
    finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}
function resolvePortableShellRuntime(runtime) {
    if (runtime.sourceKind !== "packaged-runtime-cache" && runtime.sourceKind !== "windows-runtime-donor-copy") {
        return runtime;
    }
    const nativeRoot = path.dirname(runtime.runtimeRoot);
    const electronRuntimeDir = path.join(nativeRoot, "node_modules", "electron", "dist");
    const electronExe = path.join(electronRuntimeDir, "electron.exe");
    if (!(0, exec_1.fileExists)(electronExe)) {
        throw new Error(`Portable packaging requires plain Electron dist because donor Codex.exe enforces upstream ASAR integrity: ${electronExe}`);
    }
    (0, exec_1.writeInfo)(`Using Electron dist cache for portable shell: ${electronExe}`);
    return {
        sourceKind: "electron-dist-cache",
        executablePath: electronExe,
        runtimeRoot: electronRuntimeDir,
        electronVersion: runtime.electronVersion,
        sourceLabel: electronRuntimeDir,
        fingerprint: getFileSha256(electronExe),
        validationMode: "electron-run-as-node",
    };
}
function preparePortableOutputDir(distDir, workDir, outputName, allowWorkFallback) {
    const primary = path.join(distDir, outputName);
    try {
        (0, exec_1.removePath)(primary);
        (0, exec_1.ensureDir)(primary);
        return primary;
    }
    catch (error) {
        if (!(0, exec_1.isBusyFsError)(error))
            throw error;
        if (!allowWorkFallback) {
            throw new Error((0, exec_1.describePathLock)("prepare canonical portable output", primary, error));
        }
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
            if (!(0, exec_1.isBusyFsError)(error))
                throw error;
        }
    }
    throw new Error(`Portable output directory is locked and no fallback path could be prepared. Primary: ${primary}`);
}
async function invokePortableBuild(distDir, runtime, appDir, buildNumber, buildFlavor, bundledCliPath, profileName, workDir, appVersion) {
    const profile = (0, args_1.normalizeProfileName)(profileName);
    const isDefault = (0, args_1.isCanonicalProfileName)(profile);
    const includeRuntimeMods = (0, args_1.isForgeProfileName)(profile);
    const packagerArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
    const portableRuntime = resolvePortableShellRuntime(runtime);
    const electronExe = portableRuntime.executablePath;
    if (!(0, exec_1.fileExists)(electronExe))
        throw new Error("Electron runtime not found.");
    const electronRuntimeDir = portableRuntime.runtimeRoot;
    const isPackagedRuntime = portableRuntime.sourceKind === "packaged-runtime-cache" ||
        portableRuntime.sourceKind === "windows-runtime-donor-copy" ||
        path.basename(electronExe).toLowerCase() === "codex.exe";
    const outputName = isDefault ? `Codex-win32-${packagerArch}` : `Codex-win32-${packagerArch}-${profile}`;
    const canonicalOutputDir = path.join(distDir, outputName);
    const outputDir = preparePortableOutputDir(distDir, workDir, outputName, !isDefault);
    (0, exec_1.writeInfo)(`Copying Electron runtime (${portableRuntime.sourceKind})...`);
    if (isPackagedRuntime) {
        for (const entry of fs.readdirSync(electronRuntimeDir, { withFileTypes: true })) {
            if (entry.name.toLowerCase() === "resources")
                continue;
            const sourcePath = path.join(electronRuntimeDir, entry.name);
            const destinationPath = path.join(outputDir, entry.name);
            if (entry.isDirectory()) {
                (0, exec_1.copyDirectory)(sourcePath, destinationPath);
            }
            else {
                (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
            }
        }
        (0, exec_1.ensureDir)(path.join(outputDir, "resources"));
    }
    else {
        (0, exec_1.copyDirectory)(electronRuntimeDir, outputDir);
    }
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
    const donorSupportResourcesDir = path.join(runtime.runtimeRoot, "resources");
    if ((0, exec_1.fileExists)(donorSupportResourcesDir)) {
        (0, codex_resources_1.bundlePackagedRuntimeSupportResources)(resourcesDir, donorSupportResourcesDir);
    }
    const appStagingDir = path.join(outputDir, ".app-staging");
    (0, exec_1.removePath)(appStagingDir);
    (0, exec_1.copyDirectory)(appDir, appStagingDir);
    if (includeRuntimeMods) {
        if (!(0, exec_1.fileExists)(CODEX_MODS_SRC_DIR)) {
            throw new Error(`Codex modpack missing: ${CODEX_MODS_SRC_DIR}`);
        }
        if (!(0, exec_1.fileExists)(CODEX_MOD_API_SRC_DIR)) {
            throw new Error(`Codex mod API missing: ${CODEX_MOD_API_SRC_DIR}`);
        }
        if (!(0, exec_1.fileExists)(CODEX_MOD_LOADER_SRC_DIR)) {
            throw new Error(`Codex mod loader missing: ${CODEX_MOD_LOADER_SRC_DIR}`);
        }
        if (!(0, exec_1.fileExists)(CODEX_MOD_COMPATIBILITY_SRC_PATH)) {
            throw new Error(`Codex mod compatibility helper missing: ${CODEX_MOD_COMPATIBILITY_SRC_PATH}`);
        }
        if (!(0, exec_1.fileExists)(CODEX_VERSION_IDENTITY_SRC_DIR)) {
            throw new Error(`Codex version identity helper missing: ${CODEX_VERSION_IDENTITY_SRC_DIR}`);
        }
        (0, exec_1.writeInfo)("Bundling Codex mods...");
        (0, exec_1.copyDirectory)(CODEX_MODS_SRC_DIR, path.join(resourcesDir, "mods"));
        (0, exec_1.writeInfo)("Bundling Codex mod API...");
        (0, exec_1.copyDirectory)(CODEX_MOD_API_SRC_DIR, path.join(resourcesDir, "mod-api"));
        (0, exec_1.writeInfo)("Bundling Codex mod loader...");
        (0, exec_1.copyDirectory)(CODEX_MOD_LOADER_SRC_DIR, path.join(resourcesDir, "mod-loader"));
        (0, exec_1.writeInfo)("Bundling Codex mod compatibility...");
        (0, exec_1.copyFileSafe)(CODEX_MOD_COMPATIBILITY_SRC_PATH, path.join(resourcesDir, "compatibility.cjs"));
        (0, exec_1.writeInfo)("Bundling version identity helper...");
        (0, exec_1.copyDirectory)(CODEX_VERSION_IDENTITY_SRC_DIR, path.join(resourcesDir, "version-identity"));
    }
    else {
        (0, exec_1.writeInfo)("Building Codex Lite runtime (no Forge mod stack bundled)...");
    }
    (0, exec_1.removePath)(path.join(resourcesDir, "default_app.asar"));
    (0, bundle_patches_1.patchMainForWindowsEnvironment)(appStagingDir, buildNumber, buildFlavor);
    (0, exec_1.copyDirectory)(appStagingDir, path.join(resourcesDir, "app"));
    (0, exec_1.removePath)(appStagingDir);
    if (!bundledCliPath || !(0, exec_1.fileExists)(bundledCliPath)) {
        throw new Error("Portable build requires a valid codex.exe source path.");
    }
    (0, exec_1.writeInfo)("Bundling Codex CLI...");
    (0, codex_resources_1.bundleCodexCliResources)(resourcesDir, bundledCliPath);
    const launcherPath = (0, launchers_1.writePortableLauncher)(outputDir, profile);
    for (const requiredLauncher of [
        "Launch-Codex.cmd",
        ...(includeRuntimeMods ? ["Launch-Codex-with-mods.cmd"] : []),
    ]) {
        const candidate = path.join(outputDir, requiredLauncher);
        if (!(0, exec_1.fileExists)(candidate)) {
            throw new Error(`Portable launcher missing after packaging: ${candidate}`);
        }
    }
    (0, verify_1.verifyPortableRuntimeContract)({
        outputDir,
        includeRuntimeMods,
        requireWebviewCwdPatch: true,
    });
    let latestLaunchersReady = false;
    if (isDefault) {
        (0, launchers_1.pruneStalePortableOutputs)(distDir, outputName, true);
        (0, launchers_1.writeLatestPortableLaunchers)(distDir, outputDir, includeRuntimeMods);
        latestLaunchersReady = [
            path.join(distDir, "Launch-Codex-latest.cmd"),
            path.join(distDir, "Launch-Codex-latest-compact-debug.cmd"),
            ...(includeRuntimeMods ? [path.join(distDir, "Launch-Codex-latest-with-mods.cmd")] : []),
        ].every((candidate) => (0, exec_1.fileExists)(candidate));
    }
    return {
        outputDir,
        launcherPath,
        canonicalOutputReady: isDefault && path.resolve(outputDir) === path.resolve(canonicalOutputDir),
        latestLaunchersReady,
        runtime: portableRuntime,
    };
}
