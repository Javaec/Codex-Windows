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
exports.ensureGitCapabilityCachePath = ensureGitCapabilityCachePath;
exports.rememberGitMissingRef = rememberGitMissingRef;
exports.rememberGitInvalidCwd = rememberGitInvalidCwd;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
function nowIso() {
    return new Date().toISOString();
}
function newEntry(ttlHours) {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    return {
        firstSeenUtc: now.toISOString(),
        lastSeenUtc: now.toISOString(),
        expiresUtc: expires.toISOString(),
        failCount: 1,
    };
}
function emptyCache() {
    return {
        schemaVersion: 1,
        updatedAtUtc: nowIso(),
        missingRefs: {},
        invalidCwds: {},
    };
}
function pruneExpired(map, now) {
    const out = {};
    for (const [key, value] of Object.entries(map)) {
        const expires = new Date(value.expiresUtc).getTime();
        if (!Number.isFinite(expires) || expires <= now.getTime())
            continue;
        out[key] = value;
    }
    return out;
}
function capEntries(map, maxEntries) {
    const entries = Object.entries(map);
    if (entries.length <= maxEntries)
        return map;
    entries.sort((a, b) => {
        const aTime = new Date(a[1].lastSeenUtc).getTime();
        const bTime = new Date(b[1].lastSeenUtc).getTime();
        return bTime - aTime;
    });
    return Object.fromEntries(entries.slice(0, maxEntries));
}
function readCache(cachePath) {
    if (!(0, exec_1.fileExists)(cachePath))
        return emptyCache();
    try {
        const raw = fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        return {
            schemaVersion: parsed.schemaVersion || 1,
            updatedAtUtc: parsed.updatedAtUtc || nowIso(),
            missingRefs: parsed.missingRefs || {},
            invalidCwds: parsed.invalidCwds || {},
        };
    }
    catch {
        return emptyCache();
    }
}
function writeCache(cachePath, cache) {
    cache.updatedAtUtc = nowIso();
    (0, exec_1.ensureDir)(path.dirname(cachePath));
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}
function ensureGitCapabilityCachePath(workDir, profileName) {
    const diagnosticsDir = (0, exec_1.ensureDir)(path.join(workDir, "diagnostics", profileName));
    const cachePath = path.join(diagnosticsDir, "git-capability-cache.json");
    const now = new Date();
    const cache = readCache(cachePath);
    cache.missingRefs = capEntries(pruneExpired(cache.missingRefs, now), 2000);
    cache.invalidCwds = capEntries(pruneExpired(cache.invalidCwds, now), 1000);
    writeCache(cachePath, cache);
    return cachePath;
}
function rememberGitMissingRef(cachePath, cwd, ref, ttlHours = 6) {
    const key = `${path.resolve(cwd).toLowerCase()}|${ref.trim().toLowerCase()}`;
    if (!key)
        return;
    const cache = readCache(cachePath);
    const existing = cache.missingRefs[key];
    if (existing) {
        const updated = newEntry(ttlHours);
        updated.firstSeenUtc = existing.firstSeenUtc;
        updated.failCount = existing.failCount + 1;
        cache.missingRefs[key] = updated;
    }
    else {
        cache.missingRefs[key] = newEntry(ttlHours);
    }
    writeCache(cachePath, cache);
}
function rememberGitInvalidCwd(cachePath, cwd, ttlHours = 12) {
    const key = path.resolve(cwd).toLowerCase();
    if (!key)
        return;
    const cache = readCache(cachePath);
    const existing = cache.invalidCwds[key];
    if (existing) {
        const updated = newEntry(ttlHours);
        updated.firstSeenUtc = existing.firstSeenUtc;
        updated.failCount = existing.failCount + 1;
        cache.invalidCwds[key] = updated;
    }
    else {
        cache.invalidCwds[key] = newEntry(ttlHours);
    }
    writeCache(cachePath, cache);
}
