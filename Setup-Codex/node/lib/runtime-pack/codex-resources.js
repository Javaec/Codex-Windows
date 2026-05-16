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
exports.ensureBundledNotificationSound = ensureBundledNotificationSound;
exports.bundlePackagedRuntimeSupportResources = bundlePackagedRuntimeSupportResources;
exports.bundleCodexCliResources = bundleCodexCliResources;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const windows_apps_1 = require("../runtime-donor/windows-apps");
const DONOR_TOOL_NAMES = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]);
const CLI_RESOURCE_ALLOWLIST = new Set([
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
    "rg.exe",
    "notification.wav",
    "codex-notification.wav",
]);
const PORTABLE_RESOURCE_ROOT_ALLOWLIST = new Set([
    "app",
    "app.asar.unpacked",
    "native",
    "mods",
    "mod-api",
    "mod-loader",
    "compatibility.cjs",
    "version-identity",
    "path",
    "codex",
    "codex.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
    "icon.ico",
    "notification.wav",
    "rg",
    "rg.exe",
    "third_party_notices.txt",
]);
const PACKAGED_RUNTIME_SUPPORT_ENTRIES = [
    { sourceName: "native", targetName: "native" },
    { sourceName: "codex", targetName: "codex" },
    { sourceName: "icon.ico", targetName: "icon.ico" },
    { sourceName: "notification.wav", targetName: "notification.wav" },
    { sourceName: "codex-notification.wav", targetName: "notification.wav" },
    { sourceName: "rg", targetName: "rg" },
    { sourceName: "THIRD_PARTY_NOTICES.txt", targetName: "THIRD_PARTY_NOTICES.txt" },
];
function resolveNotificationSoundSource(resourcesDir, runtimeResourcesDir) {
    for (const candidate of [
        path.join(resourcesDir, "notification.wav"),
        path.join(resourcesDir, "codex-notification.wav"),
        path.join(runtimeResourcesDir, "notification.wav"),
        path.join(runtimeResourcesDir, "codex-notification.wav"),
    ]) {
        if ((0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return "";
}
function ensureBundledNotificationSound(resourcesDir, runtimeResourcesDir) {
    const bundledNotificationPath = path.join(resourcesDir, "notification.wav");
    if ((0, exec_1.fileExists)(bundledNotificationPath))
        return bundledNotificationPath;
    const sourcePath = resolveNotificationSoundSource(resourcesDir, runtimeResourcesDir);
    if (!sourcePath) {
        throw new Error(`Portable build requires bundled notification.wav: ${bundledNotificationPath}`);
    }
    (0, exec_1.writeInfo)(`Bundling notification sound from: ${sourcePath}`);
    (0, exec_1.copyFileSafe)(sourcePath, bundledNotificationPath);
    return bundledNotificationPath;
}
function resolveRipgrepSource(resourcesDir, preferredRipgrepPath) {
    const pathRipgrepPath = path.join(resourcesDir, "path", "rg.exe");
    const donorRipgrepPath = (0, windows_apps_1.getWindowsRuntimeDonorRipgrepPath)();
    for (const candidate of [
        preferredRipgrepPath || "",
        (0, exec_1.fileExists)(pathRipgrepPath) ? pathRipgrepPath : "",
        donorRipgrepPath,
        (0, exec_1.resolveCommand)("rg.exe") || "",
        (0, exec_1.resolveCommand)("rg") || "",
    ]) {
        if (candidate && (0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return "";
}
function installBundledRipgrep(resourcesDir, preferredRipgrepPath) {
    const bundledRipgrepPath = path.join(resourcesDir, "rg.exe");
    const pathToolsDir = (0, exec_1.ensureDir)(path.join(resourcesDir, "path"));
    const pathRipgrepPath = path.join(pathToolsDir, "rg.exe");
    const ripgrepSourcePath = resolveRipgrepSource(resourcesDir, preferredRipgrepPath);
    if (!ripgrepSourcePath) {
        throw new Error(`Portable build requires bundled rg.exe: ${bundledRipgrepPath}`);
    }
    (0, exec_1.writeInfo)(`Bundling ripgrep from: ${ripgrepSourcePath}`);
    if (path.resolve(ripgrepSourcePath) !== path.resolve(bundledRipgrepPath)) {
        (0, exec_1.copyFileSafe)(ripgrepSourcePath, bundledRipgrepPath);
    }
    if (path.resolve(ripgrepSourcePath) !== path.resolve(pathRipgrepPath)) {
        (0, exec_1.copyFileSafe)(ripgrepSourcePath, pathRipgrepPath);
    }
    return {
        bundledRipgrepPath,
        bundledRipgrepSourcePath: ripgrepSourcePath,
    };
}
function bundleVendorPathTools(resourcesDir, cliSrcDir) {
    const vendorArchDir = path.resolve(cliSrcDir, "..");
    const vendorPathDir = path.join(vendorArchDir, "path");
    if (!(0, exec_1.fileExists)(vendorPathDir))
        return;
    (0, exec_1.writeInfo)("Bundling Codex CLI companion tools...");
    (0, exec_1.copyDirectory)(vendorPathDir, path.join(resourcesDir, "path"));
}
function bundleWindowsRuntimeDonorTools(resourcesDir) {
    const donorToolPaths = (0, windows_apps_1.getWindowsRuntimeDonorToolPaths)();
    if (donorToolPaths.length === 0)
        return;
    (0, exec_1.writeInfo)("Bundling Windows runtime donor tools...");
    for (const donorToolPath of donorToolPaths) {
        const fileName = path.basename(donorToolPath);
        if (!DONOR_TOOL_NAMES.has(fileName.toLowerCase()))
            continue;
        const destinationPath = path.join(resourcesDir, fileName);
        if ((0, exec_1.fileExists)(destinationPath))
            continue;
        (0, exec_1.copyFileSafe)(donorToolPath, destinationPath);
    }
}
function trimPortableResourceRoot(resourcesDir) {
    for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
        if (PORTABLE_RESOURCE_ROOT_ALLOWLIST.has(entry.name.toLowerCase()))
            continue;
        (0, exec_1.removePath)(path.join(resourcesDir, entry.name));
    }
}
function bundlePackagedRuntimeSupportResources(resourcesDir, runtimeResourcesDir) {
    if (!(0, exec_1.fileExists)(runtimeResourcesDir))
        return;
    const copiedTargets = new Set();
    for (const entry of PACKAGED_RUNTIME_SUPPORT_ENTRIES) {
        if (copiedTargets.has(entry.targetName.toLowerCase()))
            continue;
        const sourcePath = path.join(runtimeResourcesDir, entry.sourceName);
        if (!(0, exec_1.fileExists)(sourcePath))
            continue;
        const destinationPath = path.join(resourcesDir, entry.targetName);
        (0, exec_1.removePath)(destinationPath);
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
            (0, exec_1.copyDirectory)(sourcePath, destinationPath);
        }
        else {
            (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
        }
        copiedTargets.add(entry.targetName.toLowerCase());
    }
}
function bundleCodexCliResources(resourcesDir, bundledCliPath, preferredRipgrepPath) {
    const cliSrcDir = path.dirname(bundledCliPath);
    (0, exec_1.copyFileSafe)(bundledCliPath, path.join(resourcesDir, "codex.exe"));
    for (const entry of fs.readdirSync(cliSrcDir, { withFileTypes: true })) {
        if (!entry.isFile())
            continue;
        const fileName = entry.name.toLowerCase();
        if (fileName === path.basename(bundledCliPath).toLowerCase())
            continue;
        if (!CLI_RESOURCE_ALLOWLIST.has(fileName))
            continue;
        const destinationName = fileName === "codex-notification.wav" ? "notification.wav" : entry.name;
        (0, exec_1.copyFileSafe)(path.join(cliSrcDir, entry.name), path.join(resourcesDir, destinationName));
    }
    bundleVendorPathTools(resourcesDir, cliSrcDir);
    bundleWindowsRuntimeDonorTools(resourcesDir);
    const bundledTools = installBundledRipgrep(resourcesDir, preferredRipgrepPath);
    trimPortableResourceRoot(resourcesDir);
    return bundledTools;
}
