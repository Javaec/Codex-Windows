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
exports.createChunkArtifactRegistry = createChunkArtifactRegistry;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function normalizeSourceFile(input) {
    return toPosixPath(input).replace(/^\.?\//, "").trim();
}
function toChunkArtifactPath(sourceFile) {
    const normalized = normalizeSourceFile(sourceFile);
    return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}
function sha256Hex(input) {
    return (0, node_crypto_1.createHash)("sha256").update(input, "utf8").digest("hex");
}
function createChunkArtifactRegistry(input) {
    const chunkArtifactsRoot = path.resolve(input.chunkArtifactsRoot);
    const artifactRootPrefix = (input.artifactRootPrefix ?? "src/chunks").replace(/\\/g, "/").replace(/\/+$/, "");
    fs.mkdirSync(chunkArtifactsRoot, { recursive: true });
    const rowBySourceFile = new Map();
    const sourceFileByArtifactPath = new Map();
    const registerSourceChunk = (registration) => {
        const sourceFile = normalizeSourceFile(registration.sourceFile);
        if (sourceFile.length === 0) {
            throw new Error("Chunk artifact registry: sourceFile is empty.");
        }
        const sourceChunk = registration.sourceChunk;
        const bytes = Buffer.byteLength(sourceChunk, "utf8");
        const sha256 = sha256Hex(sourceChunk);
        const artifactRelPath = toChunkArtifactPath(sourceFile);
        const artifactPath = toPosixPath(path.posix.join(artifactRootPrefix, artifactRelPath));
        const artifactAbsPath = path.join(chunkArtifactsRoot, ...artifactRelPath.split("/"));
        const currentBySource = rowBySourceFile.get(sourceFile);
        if (currentBySource) {
            if (currentBySource.sha256 !== sha256 || currentBySource.bytes !== bytes) {
                throw new Error(`Chunk artifact registry: source content drift for ${sourceFile} (${currentBySource.sha256} -> ${sha256}).`);
            }
            return currentBySource;
        }
        const currentSourceForArtifact = sourceFileByArtifactPath.get(artifactPath);
        if (currentSourceForArtifact && currentSourceForArtifact !== sourceFile) {
            throw new Error(`Chunk artifact registry: artifact path collision ${artifactPath} for ${currentSourceForArtifact} and ${sourceFile}.`);
        }
        fs.mkdirSync(path.dirname(artifactAbsPath), { recursive: true });
        if (fs.existsSync(artifactAbsPath)) {
            const existing = fs.readFileSync(artifactAbsPath, "utf8");
            const existingHash = sha256Hex(existing);
            if (existingHash !== sha256) {
                throw new Error(`Chunk artifact registry: existing artifact content mismatch for ${artifactPath} (${existingHash} != ${sha256}).`);
            }
        }
        else {
            fs.writeFileSync(artifactAbsPath, sourceChunk, "utf8");
        }
        const row = {
            sourceFile,
            artifactPath,
            bytes,
            sha256,
        };
        rowBySourceFile.set(sourceFile, row);
        sourceFileByArtifactPath.set(artifactPath, sourceFile);
        return row;
    };
    const resolveArtifactPath = (sourceFileInput) => {
        const sourceFile = normalizeSourceFile(sourceFileInput);
        const row = rowBySourceFile.get(sourceFile);
        if (!row) {
            throw new Error(`Chunk artifact registry: source file is not registered: ${sourceFile}`);
        }
        return row.artifactPath;
    };
    const getRows = () => Array.from(rowBySourceFile.values()).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
    const count = () => rowBySourceFile.size;
    return {
        registerSourceChunk,
        resolveArtifactPath,
        getRows,
        count,
    };
}
