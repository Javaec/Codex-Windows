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
exports.cleanupCodexState = cleanupCodexState;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const DEFAULT_POLICY = {
    logMaxAgeDays: 7,
    sessionMaxAgeDays: 10,
    worktreeMaxAgeDays: 5,
};
function resolveCodexHome() {
    const explicit = String(process.env.CODEX_HOME || "").trim();
    if (explicit)
        return path.resolve(explicit);
    const userProfile = String(process.env.USERPROFILE || "").trim();
    if (!userProfile) {
        throw new Error("Unable to resolve Codex home: USERPROFILE is not set.");
    }
    return path.join(userProfile, ".codex");
}
function isDirectory(fullPath) {
    try {
        return fs.statSync(fullPath).isDirectory();
    }
    catch {
        return false;
    }
}
function statSafe(fullPath) {
    try {
        return fs.statSync(fullPath);
    }
    catch {
        return null;
    }
}
function listChildren(fullPath) {
    try {
        return fs.readdirSync(fullPath, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function pruneOldFiles(rootDir, cutoffMs) {
    if (!isDirectory(rootDir))
        return { removedFiles: 0, removedBytes: 0 };
    const stack = [rootDir];
    const visitOrder = [];
    let removedFiles = 0;
    let removedBytes = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        visitOrder.push(current);
        for (const entry of listChildren(current)) {
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                stack.push(target);
                continue;
            }
            if (!entry.isFile())
                continue;
            const stats = statSafe(target);
            if (!stats)
                continue;
            if (stats.mtimeMs >= cutoffMs)
                continue;
            removedBytes += stats.size;
            (0, exec_1.removePath)(target);
            removedFiles += 1;
        }
    }
    visitOrder.sort((a, b) => b.length - a.length);
    for (const current of visitOrder) {
        if (current === rootDir)
            continue;
        const children = listChildren(current);
        if (children.length === 0) {
            (0, exec_1.removePath)(current);
        }
    }
    return { removedFiles, removedBytes };
}
function collectTreeMetrics(rootDir) {
    const rootStats = statSafe(rootDir);
    if (!rootStats)
        return { latestMtimeMs: 0, totalBytes: 0 };
    let latestMtimeMs = rootStats.mtimeMs;
    let totalBytes = rootStats.isFile() ? rootStats.size : 0;
    const stack = rootStats.isDirectory() ? [rootDir] : [];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of listChildren(current)) {
            if (entry.isSymbolicLink())
                continue;
            const target = path.join(current, entry.name);
            const stats = statSafe(target);
            if (!stats)
                continue;
            if (stats.mtimeMs > latestMtimeMs)
                latestMtimeMs = stats.mtimeMs;
            if (stats.isDirectory()) {
                stack.push(target);
                continue;
            }
            if (stats.isFile())
                totalBytes += stats.size;
        }
    }
    return { latestMtimeMs, totalBytes };
}
function pruneOldWorktrees(worktreesDir, cutoffMs) {
    if (!isDirectory(worktreesDir))
        return { removedRoots: 0, removedBytes: 0 };
    let removedRoots = 0;
    let removedBytes = 0;
    for (const entry of listChildren(worktreesDir)) {
        if (entry.isSymbolicLink())
            continue;
        const target = path.join(worktreesDir, entry.name);
        const stats = statSafe(target);
        if (!stats)
            continue;
        if (stats.isFile()) {
            if (stats.mtimeMs >= cutoffMs)
                continue;
            removedBytes += stats.size;
            (0, exec_1.removePath)(target);
            removedRoots += 1;
            continue;
        }
        if (!stats.isDirectory())
            continue;
        const metrics = collectTreeMetrics(target);
        if (metrics.latestMtimeMs >= cutoffMs)
            continue;
        removedBytes += metrics.totalBytes;
        (0, exec_1.removePath)(target);
        removedRoots += 1;
    }
    return { removedRoots, removedBytes };
}
function cleanupCodexState(rawPolicy = {}) {
    const policy = { ...DEFAULT_POLICY, ...rawPolicy };
    const codexHome = resolveCodexHome();
    if (!isDirectory(codexHome)) {
        (0, exec_1.writeWarn)(`[cleanup] Codex home not found, skipping: ${codexHome}`);
        return {
            rootDir: codexHome,
            logsRemoved: 0,
            sessionsRemoved: 0,
            worktreeRootsRemoved: 0,
            bytesRemoved: 0,
        };
    }
    const now = Date.now();
    const logsCutoff = now - policy.logMaxAgeDays * 24 * 60 * 60 * 1000;
    const sessionsCutoff = now - policy.sessionMaxAgeDays * 24 * 60 * 60 * 1000;
    const worktreesCutoff = now - policy.worktreeMaxAgeDays * 24 * 60 * 60 * 1000;
    const logsResult = pruneOldFiles(path.join(codexHome, "log"), logsCutoff);
    const sessionsResult = pruneOldFiles(path.join(codexHome, "sessions"), sessionsCutoff);
    const worktreesResult = pruneOldWorktrees(path.join(codexHome, "worktrees"), worktreesCutoff);
    const bytesRemoved = logsResult.removedBytes + sessionsResult.removedBytes + worktreesResult.removedBytes;
    (0, exec_1.writeInfo)(`[cleanup] codexHome=${codexHome} logsRemoved=${logsResult.removedFiles} sessionsRemoved=${sessionsResult.removedFiles} worktreeRootsRemoved=${worktreesResult.removedRoots} reclaimedMB=${(bytesRemoved / 1024 / 1024).toFixed(2)}`);
    return {
        rootDir: codexHome,
        logsRemoved: logsResult.removedFiles,
        sessionsRemoved: sessionsResult.removedFiles,
        worktreeRootsRemoved: worktreesResult.removedRoots,
        bytesRemoved,
    };
}
