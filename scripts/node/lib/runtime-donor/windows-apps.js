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
exports.listWindowsCodexPackages = listWindowsCodexPackages;
exports.getWindowsRuntimeDonorAppDirs = getWindowsRuntimeDonorAppDirs;
exports.getWindowsRuntimeDonorCliPath = getWindowsRuntimeDonorCliPath;
exports.getWindowsRuntimeDonorRipgrepPath = getWindowsRuntimeDonorRipgrepPath;
exports.getWindowsRuntimeDonorBetterSqlite3Path = getWindowsRuntimeDonorBetterSqlite3Path;
exports.getWindowsRuntimeDonorToolPaths = getWindowsRuntimeDonorToolPaths;
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const WINDOWS_APPS_PACKAGE_QUERY = "OpenAI.Codex*";
function getPowerShellPath() {
    return ((0, exec_1.resolveCommand)("pwsh.exe") ||
        (0, exec_1.resolveCommand)("pwsh") ||
        (0, exec_1.resolveCommand)("powershell.exe") ||
        (0, exec_1.resolveCommand)("powershell") ||
        "");
}
let cachedWindowsCodexPackages = [];
let windowsCodexPackagesLoaded = false;
function loadWindowsCodexPackages() {
    if (windowsCodexPackagesLoaded)
        return cachedWindowsCodexPackages;
    windowsCodexPackagesLoaded = true;
    const shellPath = getPowerShellPath();
    if (!shellPath)
        return cachedWindowsCodexPackages;
    const command = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
        `Get-AppxPackage '${WINDOWS_APPS_PACKAGE_QUERY}' | ` +
        `Sort-Object Version -Descending | ` +
        `ForEach-Object { '{0}|{1}|{2}' -f $_.PackageFullName, $_.Version, $_.InstallLocation }`;
    const result = (0, exec_1.runCommand)(shellPath, ["-NoProfile", "-Command", command], {
        capture: true,
        allowNonZero: true,
    });
    if (result.status !== 0)
        return cachedWindowsCodexPackages;
    const packages = [];
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const parts = trimmed.split("|");
        if (parts.length < 3)
            continue;
        const packageFullName = String(parts[0] || "").trim();
        const packageVersion = String(parts[1] || "").trim();
        const packageRoot = String(parts.slice(2).join("|") || "").trim();
        if (!packageFullName || !packageRoot || !(0, exec_1.fileExists)(packageRoot))
            continue;
        packages.push({
            packageFullName,
            packageVersion,
            packageRoot,
            appDir: path.join(packageRoot, "app"),
            resourcesDir: path.join(packageRoot, "app", "resources"),
            appAsarUnpackedDir: path.join(packageRoot, "app", "resources", "app.asar.unpacked"),
        });
    }
    cachedWindowsCodexPackages = packages;
    return cachedWindowsCodexPackages;
}
function listWindowsCodexPackages() {
    return [...loadWindowsCodexPackages()];
}
function findFirstExistingTool(toolName) {
    for (const runtimePackage of loadWindowsCodexPackages()) {
        const candidate = path.join(runtimePackage.resourcesDir, toolName);
        if ((0, exec_1.fileExists)(candidate))
            return candidate;
    }
    return "";
}
function getWindowsRuntimeDonorAppDirs() {
    return (0, exec_1.uniqueExistingDirs)(loadWindowsCodexPackages().map((runtimePackage) => runtimePackage.appAsarUnpackedDir));
}
function getWindowsRuntimeDonorCliPath() {
    return findFirstExistingTool("codex.exe");
}
function getWindowsRuntimeDonorRipgrepPath() {
    return findFirstExistingTool("rg.exe");
}
function getWindowsRuntimeDonorBetterSqlite3Path() {
    for (const runtimePackage of loadWindowsCodexPackages()) {
        const candidate = path.join(runtimePackage.appAsarUnpackedDir, "node_modules", "better-sqlite3");
        if ((0, exec_1.fileExists)(candidate))
            return candidate;
    }
    return "";
}
function getWindowsRuntimeDonorToolPaths() {
    return (0, exec_1.uniqueExistingDirs)([
        findFirstExistingTool("codex-command-runner.exe"),
        findFirstExistingTool("codex-windows-sandbox-setup.exe"),
        findFirstExistingTool("rg.exe"),
    ]);
}
