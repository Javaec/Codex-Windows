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
const path = __importStar(require("node:path"));
const compatibility = require(path.join(__dirname, "..", "..", "..", "..", "shared", "codex-mod-loader", "compatibility.cjs"));
function collectEntrypoints(entrypoints) {
    const out = [];
    if (entrypoints.main.length > 0)
        out.push("main");
    if (entrypoints.renderer.length > 0)
        out.push("renderer");
    return out;
}
function detectLane(entrypoints) {
    if (entrypoints.renderer.length > 0 && entrypoints.main.length > 0)
        return "mixed";
    if (entrypoints.main.length > 0)
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
        return {
            id: mod.id,
            name: mod.name,
            description: mod.description,
            version: mod.version || "0.0.0-local",
            authors: [...mod.authors],
            contact: { ...mod.contact },
            licenses: [...mod.licenses],
            environment: mod.environment || "*",
            iconPath: mod.iconPath ? path.join(mod.rootPath, mod.iconPath) : "",
            provides: [...mod.provides],
            priority: mod.priority,
            enabledInManifest: mod.enabled,
            entrypoints: collectEntrypoints(mod.entrypoints),
            lane: detectLane(mod.entrypoints),
            capabilities: [...mod.capabilities.main, ...mod.capabilities.renderer].sort(),
            manifestPath: mod.manifestPath,
            rootPath: mod.rootPath,
            codeSourcePaths: [mod.rootPath],
            origin: {
                kind: "directory",
                paths: [mod.rootPath],
            },
            builtin: false,
        };
    })
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}
