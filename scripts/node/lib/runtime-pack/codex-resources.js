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
exports.bundleCodexCliResources = bundleCodexCliResources;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const windows_apps_1 = require("../runtime-donor/windows-apps");
const DONOR_TOOL_NAMES = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe"]);
const CLI_RESOURCE_ALLOWLIST = new Set(["codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "rg.exe", "notification.wav"]);
const PORTABLE_RESOURCE_ROOT_ALLOWLIST = new Set([
    "app",
    "mods",
    "mod-api",
    "path",
    "codex.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
    "notification.wav",
    "rg.exe",
]);
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
        (0, exec_1.copyFileSafe)(donorToolPath, path.join(resourcesDir, fileName));
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
    trimPortableResourceRoot(resourcesDir);
}
