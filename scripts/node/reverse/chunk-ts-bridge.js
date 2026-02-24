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
exports.rewriteChunkImportsToTsBridge = rewriteChunkImportsToTsBridge;
exports.renderChunkTsModuleSource = renderChunkTsModuleSource;
const path = __importStar(require("node:path"));
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function toChunkArtifactPath(sourceFile) {
    const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}
function toChunkTsModulePathFromSourceFile(sourceFile) {
    const artifactPath = toChunkArtifactPath(sourceFile).replace(/\.js$/i, ".ts");
    return toPosixPath(path.posix.join("src", "chunks-ts", artifactPath));
}
function toModuleSpecifier(fromDirectory, targetFilePath) {
    const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
    const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
    const relative = path.posix.relative(from, target);
    return relative.startsWith(".") ? relative : `./${relative}`;
}
function resolveChunkTsBridge(input) {
    if (!/^(?:\.{1,2})\//.test(input.specifier))
        return undefined;
    if (!/\.(?:mjs|cjs|js)$/i.test(input.specifier))
        return undefined;
    const sourceDir = path.posix.dirname(toPosixPath(input.sourceFile).replace(/^\.?\//, ""));
    const resolvedSource = path.posix.normalize(path.posix.join(sourceDir, input.specifier));
    if (resolvedSource.startsWith("../"))
        return undefined;
    const chunkArtifactPath = toPosixPath(path.posix.join("src", "chunks", toChunkArtifactPath(resolvedSource)));
    const chunkTsModulePath = toChunkTsModulePathFromSourceFile(resolvedSource);
    const emittedDirectory = path.posix.dirname(toPosixPath(input.emittedPath).replace(/^\.?\//, ""));
    const nextSpecifier = toModuleSpecifier(emittedDirectory, chunkTsModulePath);
    return {
        nextSpecifier,
        bridge: {
            sourceFile: resolvedSource,
            chunkArtifactPath,
            chunkTsModulePath,
        },
    };
}
function rewriteChunkImportsToTsBridge(input) {
    let rewrites = 0;
    const bridgesByModulePath = new Map();
    const rewriteSpecifier = (raw) => {
        const resolved = resolveChunkTsBridge({
            specifier: raw,
            sourceFile: input.sourceFile,
            emittedPath: input.emittedPath,
        });
        if (!resolved)
            return raw;
        if (input.isBridgeSourceFile && !input.isBridgeSourceFile(resolved.bridge.sourceFile)) {
            const stripped = raw.replace(/\.(?:mjs|cjs|js)$/i, "");
            if (stripped !== raw) {
                rewrites += 1;
            }
            return stripped;
        }
        if (resolved.nextSpecifier === raw)
            return raw;
        rewrites += 1;
        const current = bridgesByModulePath.get(resolved.bridge.chunkTsModulePath);
        if (!current) {
            bridgesByModulePath.set(resolved.bridge.chunkTsModulePath, resolved.bridge);
        }
        else if (current.chunkArtifactPath !== resolved.bridge.chunkArtifactPath) {
            throw new Error(`Chunk TS module collision: path=${resolved.bridge.chunkTsModulePath} artifacts=${current.chunkArtifactPath} vs ${resolved.bridge.chunkArtifactPath}`);
        }
        return resolved.nextSpecifier;
    };
    const rewriteLine = (line) => {
        let nextLine = line;
        nextLine = nextLine.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote, specifier) => {
            const rewritten = rewriteSpecifier(specifier);
            return `from ${quote}${rewritten}${quote}`;
        });
        nextLine = nextLine.replace(/\bimport\s+(['"])([^'"]+)\1/g, (_match, quote, specifier) => {
            const rewritten = rewriteSpecifier(specifier);
            return `import ${quote}${rewritten}${quote}`;
        });
        nextLine = nextLine.replace(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, quote, specifier) => {
            const rewritten = rewriteSpecifier(specifier);
            return `require(${quote}${rewritten}${quote})`;
        });
        nextLine = nextLine.replace(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, quote, specifier) => {
            const rewritten = rewriteSpecifier(specifier);
            return `import(${quote}${rewritten}${quote})`;
        });
        nextLine = nextLine.replace(/(['"])(\.{1,2}\/[^'"]+\.(?:mjs|cjs|js))\1/g, (_match, quote, specifier) => {
            const rewritten = rewriteSpecifier(specifier);
            return `${quote}${rewritten}${quote}`;
        });
        return nextLine;
    };
    const rewrittenLines = input.moduleBody.split("\n").map((line) => rewriteLine(line));
    const bridges = Array.from(bridgesByModulePath.values()).sort((a, b) => a.chunkTsModulePath.localeCompare(b.chunkTsModulePath));
    return {
        moduleBody: rewrittenLines.join("\n"),
        rewrites,
        bridges,
    };
}
function renderChunkTsModuleSource(input) {
    const trimmedBody = input.moduleBody.trimEnd();
    const moduleBody = trimmedBody.length > 0 ? `${trimmedBody}\n` : "";
    return [
        "/**",
        " * Generated TS chunk module from decompiled source.",
        ` * Source chunk: ${input.bridge.sourceFile}`,
        ` * Chunk artifact: ${input.bridge.chunkArtifactPath}`,
        ` * Import rewrites: ${input.rewrittenImports}`,
        " */",
        "",
        "// @ts-nocheck",
        "",
        moduleBody,
        "",
    ].join("\n");
}
