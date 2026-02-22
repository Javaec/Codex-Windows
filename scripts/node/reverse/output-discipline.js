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
exports.DEFAULT_REVERSE_REGRESSION_RUNS_ROOT = exports.DEFAULT_REVERSE_REGRESSION_LATEST_DIR = exports.DEFAULT_REVERSE_RUNS_ROOT = exports.DEFAULT_REVERSE_LATEST_DIR = void 0;
exports.normalizePathForComparison = normalizePathForComparison;
exports.createStableRunId = createStableRunId;
exports.prepareStableRunPaths = prepareStableRunPaths;
exports.pruneStableRunDirs = pruneStableRunDirs;
exports.publishStableRun = publishStableRun;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../lib/exec");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
exports.DEFAULT_REVERSE_LATEST_DIR = path.resolve(REPO_ROOT, "work", "reverse", "latest");
exports.DEFAULT_REVERSE_RUNS_ROOT = path.resolve(REPO_ROOT, "work", "reverse", "runs");
exports.DEFAULT_REVERSE_REGRESSION_LATEST_DIR = path.resolve(REPO_ROOT, "work", "reverse", "regression-latest");
exports.DEFAULT_REVERSE_REGRESSION_RUNS_ROOT = path.resolve(REPO_ROOT, "work", "reverse", "regression-runs");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function toRunStamp(now) {
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const min = String(now.getUTCMinutes()).padStart(2, "0");
    const sec = String(now.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}${mm}${dd}-${hh}${min}${sec}Z`;
}
function sanitizeRunId(raw) {
    const normalized = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (normalized.length === 0) {
        throw new Error("Stable run id resolved to empty value.");
    }
    return normalized;
}
function collectStableRunEntries(runsRoot) {
    if (!fs.existsSync(runsRoot) || !fs.statSync(runsRoot).isDirectory()) {
        return [];
    }
    const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const absPath = path.join(runsRoot, entry.name);
        const stats = fs.statSync(absPath);
        out.push({
            absPath,
            mtimeMs: stats.mtimeMs,
        });
    }
    out.sort((a, b) => {
        if (a.mtimeMs !== b.mtimeMs)
            return b.mtimeMs - a.mtimeMs;
        return b.absPath.localeCompare(a.absPath);
    });
    return out;
}
function normalizePathForComparison(input) {
    return toPosixPath(path.resolve(input)).toLowerCase();
}
function createStableRunId(prefix) {
    const base = sanitizeRunId(prefix);
    return `${base}-${toRunStamp(new Date())}`;
}
function prepareStableRunPaths(input) {
    if (!Number.isFinite(input.keepLastRuns) || input.keepLastRuns < 1) {
        throw new Error(`keepLastRuns must be >= 1, got ${input.keepLastRuns}`);
    }
    const latestDir = path.resolve(input.latestDir);
    const runsRoot = path.resolve(input.runsRoot);
    (0, exec_1.ensureDir)(runsRoot);
    const runId = sanitizeRunId(input.runId && input.runId.trim().length > 0 ? input.runId : createStableRunId("run"));
    const runDir = path.join(runsRoot, runId);
    (0, exec_1.removePath)(runDir);
    (0, exec_1.ensureDir)(runDir);
    return {
        runId,
        runDir,
        latestDir,
        runsRoot,
        keepLastRuns: Math.floor(input.keepLastRuns),
    };
}
function pruneStableRunDirs(runsRoot, keepLastRuns) {
    if (!Number.isFinite(keepLastRuns) || keepLastRuns < 1) {
        throw new Error(`keepLastRuns must be >= 1, got ${keepLastRuns}`);
    }
    const entries = collectStableRunEntries(path.resolve(runsRoot));
    if (entries.length <= keepLastRuns)
        return [];
    const removed = [];
    const stale = entries.slice(keepLastRuns);
    for (const entry of stale) {
        (0, exec_1.removePath)(entry.absPath);
        removed.push(toPosixPath(entry.absPath));
    }
    return removed;
}
function publishStableRun(input) {
    (0, exec_1.removePath)(input.latestDir);
    (0, exec_1.ensureDir)(path.dirname(input.latestDir));
    fs.cpSync(input.runDir, input.latestDir, {
        recursive: true,
    });
    const removedRuns = pruneStableRunDirs(input.runsRoot, input.keepLastRuns);
    return { removedRuns };
}
