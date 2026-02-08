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
exports.newEmptyStateManifest = newEmptyStateManifest;
exports.readStateManifest = readStateManifest;
exports.writeStateManifest = writeStateManifest;
exports.getFileDescriptorWithCache = getFileDescriptorWithCache;
exports.getStepSignature = getStepSignature;
exports.testManifestStepCurrent = testManifestStepCurrent;
exports.setManifestStepState = setManifestStepState;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
function newEmptyStateManifest() {
    return {
        schemaVersion: 1,
        updatedAtUtc: new Date().toISOString(),
        dmg: null,
        steps: { extract: null, native: null },
    };
}
function readStateManifest(manifestPath) {
    if (!(0, exec_1.fileExists)(manifestPath))
        return newEmptyStateManifest();
    try {
        const raw = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        const manifest = newEmptyStateManifest();
        if (parsed.schemaVersion)
            manifest.schemaVersion = parsed.schemaVersion;
        if (parsed.updatedAtUtc)
            manifest.updatedAtUtc = parsed.updatedAtUtc;
        if (parsed.dmg)
            manifest.dmg = parsed.dmg;
        if (parsed.steps?.extract)
            manifest.steps.extract = parsed.steps.extract;
        if (parsed.steps?.native)
            manifest.steps.native = parsed.steps.native;
        return manifest;
    }
    catch {
        return newEmptyStateManifest();
    }
}
function writeStateManifest(manifestPath, manifest) {
    manifest.updatedAtUtc = new Date().toISOString();
    (0, exec_1.ensureDir)(path.dirname(manifestPath));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}
function getFileSha256(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}
function getFileDescriptorWithCache(filePath, previous) {
    if (!(0, exec_1.fileExists)(filePath))
        throw new Error(`File not found: ${filePath}`);
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const lastWriteUtc = new Date(stat.mtimeMs).toISOString();
    const sha256 = previous &&
        previous.size === size &&
        previous.lastWriteUtc === lastWriteUtc &&
        typeof previous.sha256 === "string" &&
        previous.sha256
        ? previous.sha256
        : getFileSha256(filePath);
    return {
        path: path.resolve(filePath),
        size,
        lastWriteUtc,
        sha256,
    };
}
function getStepSignature(fields) {
    return Object.keys(fields)
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join("|");
}
function testManifestStepCurrent(manifest, stepName, signature) {
    const step = manifest.steps[stepName];
    return Boolean(step && step.signature === signature);
}
function setManifestStepState(manifest, stepName, signature, status, meta) {
    manifest.steps[stepName] = {
        status,
        signature,
        atUtc: new Date().toISOString(),
        meta,
    };
}
