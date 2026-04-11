"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bundlePackagedRuntimeSupportResources = bundlePackagedRuntimeSupportResources;
exports.bundleCodexCliResources = bundleCodexCliResources;
const fs = require("node:fs");
const path = require("node:path");
const exec_1 = require("../exec");
const windows_apps_1 = require("../runtime-donor/windows-apps");
const DONOR_TOOL_NAMES = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe"]);
const CLI_RESOURCE_ALLOWLIST = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe", "notification.wav"]);
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
const PACKAGED_RUNTIME_SUPPORT_NAMES = [
    "native",
    "codex",
    "icon.ico",
    "rg",
    "THIRD_PARTY_NOTICES.txt",
];
function ensureBundledRipgrep(resourcesDir) {
    const bundledRipgrepPath = path.join(resourcesDir, "rg.exe");
    if (!(0, exec_1.fileExists)(bundledRipgrepPath)) {
        throw new Error(`Portable build requires bundled rg.exe: ${bundledRipgrepPath}`);
    }
    const pathToolsDir = (0, exec_1.ensureDir)(path.join(resourcesDir, "path"));
    const pathRipgrepPath = path.join(pathToolsDir, "rg.exe");
    if (!(0, exec_1.fileExists)(pathRipgrepPath)) {
        (0, exec_1.copyFileSafe)(bundledRipgrepPath, pathRipgrepPath);
    }
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
    const pathToolsDir = (0, exec_1.ensureDir)(path.join(resourcesDir, "path"));
    (0, exec_1.writeInfo)("Bundling Windows runtime donor tools...");
    for (const donorToolPath of donorToolPaths) {
        const fileName = path.basename(donorToolPath);
        if (!DONOR_TOOL_NAMES.has(fileName.toLowerCase()))
            continue;
        const destinationPath = path.join(resourcesDir, fileName);
        if (fileName.toLowerCase() !== "rg.exe" && (0, exec_1.fileExists)(destinationPath))
            continue;
        (0, exec_1.copyFileSafe)(donorToolPath, destinationPath);
        if (fileName.toLowerCase() === "rg.exe") {
            (0, exec_1.copyFileSafe)(donorToolPath, path.join(pathToolsDir, fileName));
        }
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
    for (const entryName of PACKAGED_RUNTIME_SUPPORT_NAMES) {
        const sourcePath = path.join(runtimeResourcesDir, entryName);
        if (!(0, exec_1.fileExists)(sourcePath))
            continue;
        const destinationPath = path.join(resourcesDir, entryName);
        (0, exec_1.removePath)(destinationPath);
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
            (0, exec_1.copyDirectory)(sourcePath, destinationPath);
        }
        else {
            (0, exec_1.copyFileSafe)(sourcePath, destinationPath);
        }
    }
}
function bundleCodexCliResources(resourcesDir, bundledCliPath) {
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
        (0, exec_1.copyFileSafe)(path.join(cliSrcDir, entry.name), path.join(resourcesDir, entry.name));
    }
    bundleVendorPathTools(resourcesDir, cliSrcDir);
    bundleWindowsRuntimeDonorTools(resourcesDir);
    ensureBundledRipgrep(resourcesDir);
    trimPortableResourceRoot(resourcesDir);
}
