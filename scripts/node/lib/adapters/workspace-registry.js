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
exports.sanitizeWorkspaceRegistry = sanitizeWorkspaceRegistry;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_DEPTH = 3;
const PATH_KEY_HINT = /(workspace|worktree|cwd|repo|root|folder|directory|project|recent|path)s?/i;
const CANDIDATE_NAME = /(workspace|worktree|recent|registry|preference|local state|config|project|repo).*\.(json|jsn)$/i;
const SKIP_DIRS = new Set([
    "cache",
    "code cache",
    "gpucache",
    "dawngraphitecache",
    "indexeddb",
    "blob_storage",
    "session storage",
    "local storage",
    "shared dictionary",
    "crashpad",
    "sentry",
]);
function isPathLike(raw) {
    const value = raw.trim();
    if (!value)
        return false;
    if (/^[A-Za-z]:[\\/]/.test(value))
        return true;
    if (/^\\\\[^\\]/.test(value))
        return true;
    if (/^file:\/\//i.test(value))
        return true;
    return false;
}
function normalizeCandidatePath(raw) {
    let value = raw.trim().replace(/^"+|"+$/g, "");
    if (/^file:\/\//i.test(value)) {
        try {
            const urlValue = new URL(value);
            value = decodeURIComponent(urlValue.pathname || value);
            if (/^\/[A-Za-z]:/.test(value))
                value = value.slice(1);
        }
        catch {
            return "";
        }
    }
    value = value.replace(/%([^%]+)%/g, (all, name) => {
        const envValue = process.env[name];
        return envValue ? envValue : all;
    });
    if (value.includes("%"))
        return "";
    return path.normalize(value);
}
function isPathKey(keyHint) {
    return PATH_KEY_HINT.test(keyHint);
}
function collectCandidateFiles(rootDir) {
    if (!(0, exec_1.fileExists)(rootDir))
        return [];
    const out = [];
    const seen = new Set();
    const queue = [{ dir: rootDir, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            break;
        let entries = [];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current.dir, entry.name);
            const lowerName = entry.name.toLowerCase();
            if (entry.isDirectory()) {
                if (current.depth >= MAX_SCAN_DEPTH)
                    continue;
                if (SKIP_DIRS.has(lowerName))
                    continue;
                queue.push({ dir: fullPath, depth: current.depth + 1 });
                continue;
            }
            if (!entry.isFile())
                continue;
            const explicitCandidate = lowerName === "preferences" || lowerName === "local state";
            const jsonCandidate = CANDIDATE_NAME.test(lowerName);
            if (!explicitCandidate && !jsonCandidate)
                continue;
            const key = path.resolve(fullPath).toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(fullPath);
        }
    }
    return out;
}
function sanitizeNode(value, keyHint) {
    if (typeof value === "string") {
        if (!isPathKey(keyHint) || !isPathLike(value)) {
            return { value, removedEntries: 0 };
        }
        const normalized = normalizeCandidatePath(value);
        if (!normalized || !(0, exec_1.fileExists)(normalized)) {
            return { value: undefined, removedEntries: 1 };
        }
        return { value: normalized, removedEntries: 0 };
    }
    if (Array.isArray(value)) {
        const values = value;
        const pathLikeCount = values.filter((item) => typeof item === "string" && isPathLike(item)).length;
        const treatAsPathArray = isPathKey(keyHint) || pathLikeCount >= Math.max(1, Math.floor(values.length / 2));
        const next = [];
        const seen = new Set();
        let removedEntries = 0;
        for (const item of values) {
            if (treatAsPathArray && typeof item === "string" && isPathLike(item)) {
                const normalized = normalizeCandidatePath(item);
                if (!normalized || !(0, exec_1.fileExists)(normalized)) {
                    removedEntries += 1;
                    continue;
                }
                const dedupeKey = normalized.toLowerCase();
                if (seen.has(dedupeKey))
                    continue;
                seen.add(dedupeKey);
                next.push(normalized);
                continue;
            }
            const child = sanitizeNode(item, keyHint);
            removedEntries += child.removedEntries;
            if (typeof child.value === "undefined")
                continue;
            next.push(child.value);
        }
        return { value: next, removedEntries };
    }
    if (value && typeof value === "object") {
        const next = {};
        let removedEntries = 0;
        for (const [key, childValue] of Object.entries(value)) {
            const child = sanitizeNode(childValue, key);
            removedEntries += child.removedEntries;
            if (typeof child.value === "undefined")
                continue;
            next[key] = child.value;
        }
        return { value: next, removedEntries };
    }
    return { value, removedEntries: 0 };
}
function sanitizeJsonFile(filePath) {
    let raw = "";
    try {
        raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    }
    catch {
        return { changed: false, removedEntries: 0 };
    }
    if (!raw.trim())
        return { changed: false, removedEntries: 0 };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { changed: false, removedEntries: 0 };
    }
    const result = sanitizeNode(parsed, "root");
    const nextRaw = `${JSON.stringify(result.value, null, 2)}\n`;
    const changed = nextRaw !== raw;
    if (changed) {
        fs.writeFileSync(filePath, nextRaw, "utf8");
    }
    return { changed, removedEntries: result.removedEntries };
}
function sanitizeWorkspaceRegistry(userDataDir, diagnosticsDir) {
    const reportDir = (0, exec_1.ensureDir)(diagnosticsDir);
    const reportPath = path.join(reportDir, "workspace-sanitizer-report.json");
    if (!(0, exec_1.fileExists)(userDataDir)) {
        const emptyResult = {
            scannedFiles: 0,
            updatedFiles: 0,
            removedEntries: 0,
            reportPath,
        };
        fs.writeFileSync(reportPath, `${JSON.stringify({ ...emptyResult, atUtc: new Date().toISOString() }, null, 2)}\n`, "utf8");
        return emptyResult;
    }
    const candidateFiles = collectCandidateFiles(userDataDir);
    let scannedFiles = 0;
    let updatedFiles = 0;
    let removedEntries = 0;
    for (const filePath of candidateFiles) {
        let stat;
        try {
            stat = fs.statSync(filePath);
        }
        catch {
            continue;
        }
        if (stat.size > MAX_FILE_SIZE_BYTES)
            continue;
        scannedFiles += 1;
        const sanitizeResult = sanitizeJsonFile(filePath);
        if (sanitizeResult.changed)
            updatedFiles += 1;
        removedEntries += sanitizeResult.removedEntries;
    }
    const result = { scannedFiles, updatedFiles, removedEntries, reportPath };
    const report = {
        atUtc: new Date().toISOString(),
        userDataDir: path.resolve(userDataDir),
        ...result,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return result;
}
