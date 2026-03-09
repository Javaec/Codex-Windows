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
exports.discoverForgeMods = discoverForgeMods;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("../exec");
const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs"));
function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeStringList(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const item of value) {
        const normalized = normalizeString(item);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
function normalizeContact(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        const normalized = normalizeString(raw);
        if (!key || !normalized)
            continue;
        out[key] = normalized;
    }
    return out;
}
function readRawManifest(filePath) {
    if (!(0, exec_1.fileExists)(filePath))
        return {};
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return {};
    }
}
function collectEntrypoints(entrypoints) {
    const out = [];
    if (entrypoints.main)
        out.push("main");
    if (entrypoints.renderer)
        out.push("renderer");
    return out;
}
function detectLane(entrypoints) {
    if (entrypoints.renderer && entrypoints.main)
        return "mixed";
    if (entrypoints.main)
        return "main";
    return "renderer";
}
function discoverForgeMods(paths) {
    const catalog = compatibility.loadModCatalog({
        modsRoot: paths.sourceModsRoot,
        loaderRoot: paths.sourceModLoaderRoot,
    });
    return catalog.mods
        .map((mod) => {
        const rawManifest = readRawManifest(mod.manifestPath);
        const rootPath = path.dirname(mod.manifestPath);
        const iconPath = normalizeString(rawManifest.icon);
        return {
            id: mod.id,
            name: mod.name,
            description: mod.description,
            version: normalizeString(rawManifest.version) || "0.0.0-local",
            authors: normalizeStringList(rawManifest.authors),
            contact: normalizeContact(rawManifest.contact),
            licenses: normalizeStringList(Array.isArray(rawManifest.license) ? rawManifest.license : [rawManifest.license].filter(Boolean)),
            environment: normalizeString(rawManifest.environment) || "*",
            iconPath: iconPath ? path.join(rootPath, iconPath) : "",
            provides: normalizeStringList(rawManifest.provides),
            priority: mod.priority,
            enabledInManifest: mod.enabled,
            entrypoints: collectEntrypoints(mod.entrypoints),
            lane: detectLane(mod.entrypoints),
            capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
            manifestPath: mod.manifestPath,
            rootPath,
            codeSourcePaths: [rootPath],
            origin: {
                kind: "directory",
                paths: [rootPath],
            },
            builtin: false,
        };
    })
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}
