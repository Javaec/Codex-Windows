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
exports.cleanupRunnerArtifacts = cleanupRunnerArtifacts;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const STALE_ARTIFACT_MAX_AGE_HOURS = 12;
const PROTECTED_WORK_NAMES = new Set([
    "_resources",
    "app",
    "cache",
    "diagnostics",
    "electron",
    "extracted",
    "native-builds",
    "tools",
    "userdata",
    "state.manifest.json",
]);
const PROTECTED_WORK_PREFIXES = ["state.manifest."];
const PROTECTED_DIST_NAMES = new Set([
    "Codex-win32-x64",
    "Codex-win32-arm64",
    "Launch-Codex-latest.cmd",
    "Launch-Codex-latest-with-mods.cmd",
]);
function resolveProtectedTopLevelName(rootDir, currentPath) {
    if (!currentPath)
        return "";
    const relativePath = path.relative(rootDir, path.resolve(currentPath));
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return "";
    }
    return relativePath.split(path.sep)[0] || "";
}
function isProtectedName(name, input) {
    if (input.protectedNames.has(name))
        return true;
    if (input.extraProtectedName && name === input.extraProtectedName)
        return true;
    return (input.protectedPrefixes || []).some((prefix) => name.startsWith(prefix));
}
function cleanupRoot(input) {
    const removed = [];
    const skipped = [];
    if (!(0, exec_1.fileExists)(input.rootDir)) {
        return { removed, skipped };
    }
    for (const entry of fs.readdirSync(input.rootDir, { withFileTypes: true })) {
        const entryName = String(entry.name || "").trim();
        if (!entryName)
            continue;
        if (isProtectedName(entryName, input))
            continue;
        const entryPath = path.join(input.rootDir, entryName);
        let stat;
        try {
            stat = fs.statSync(entryPath);
        }
        catch (error) {
            skipped.push(`${entryPath} (stat failed)`);
            continue;
        }
        if (stat.mtimeMs >= input.cutoffMs)
            continue;
        try {
            (0, exec_1.removePath)(entryPath);
            removed.push(entryPath);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            skipped.push(`${entryPath} (${message})`);
        }
    }
    return { removed, skipped };
}
function cleanupRunnerArtifacts(repoRoot, currentWorkDir, currentDistDir) {
    const cutoffMs = Date.now() - STALE_ARTIFACT_MAX_AGE_HOURS * 60 * 60 * 1000;
    const canonicalWorkRoot = path.join(repoRoot, "work");
    const canonicalDistRoot = path.join(repoRoot, "dist");
    const workSummary = cleanupRoot({
        rootDir: canonicalWorkRoot,
        protectedNames: PROTECTED_WORK_NAMES,
        protectedPrefixes: PROTECTED_WORK_PREFIXES,
        extraProtectedName: resolveProtectedTopLevelName(canonicalWorkRoot, currentWorkDir),
        cutoffMs,
    });
    const distSummary = cleanupRoot({
        rootDir: canonicalDistRoot,
        protectedNames: PROTECTED_DIST_NAMES,
        extraProtectedName: resolveProtectedTopLevelName(canonicalDistRoot, currentDistDir),
        cutoffMs,
    });
    const removedCount = workSummary.removed.length + distSummary.removed.length;
    if (removedCount > 0) {
        (0, exec_1.writeSuccess)(`Artifact cleanup: removed=${removedCount} work=${workSummary.removed.length} dist=${distSummary.removed.length}`);
    }
    for (const skipped of [...workSummary.skipped, ...distSummary.skipped]) {
        (0, exec_1.writeWarn)(`Artifact cleanup skipped: ${skipped}`);
    }
}
