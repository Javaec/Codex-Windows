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
exports.renderChunkTsWrapperSource = renderChunkTsWrapperSource;
const path = __importStar(require("node:path"));
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function toChunkArtifactPath(sourceFile) {
    const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
    return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}
function toChunkTsWrapperPathFromSourceFile(sourceFile) {
    const artifactPath = toChunkArtifactPath(sourceFile).replace(/\.js$/i, ".ts");
    return toPosixPath(path.posix.join("src", "chunks-ts", artifactPath));
}
function toModuleSpecifier(fromDirectory, targetFilePath) {
    const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
    const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
    const relative = path.posix.relative(from, target);
    return relative.startsWith(".") ? relative : `./${relative}`;
}
function toRelativePathSpecifier(fromDirectory, targetFilePath) {
    const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
    const target = toPosixPath(targetFilePath).replace(/^\.?\//, "");
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
    const chunkTsWrapperPath = toChunkTsWrapperPathFromSourceFile(resolvedSource);
    const emittedDirectory = path.posix.dirname(toPosixPath(input.emittedPath).replace(/^\.?\//, ""));
    const nextSpecifier = toModuleSpecifier(emittedDirectory, chunkTsWrapperPath);
    return {
        nextSpecifier,
        bridge: {
            sourceFile: resolvedSource,
            chunkArtifactPath,
            chunkTsWrapperPath,
        },
    };
}
function rewriteChunkImportsToTsBridge(input) {
    let rewrites = 0;
    const bridgesByWrapperPath = new Map();
    const rewriteSpecifier = (raw) => {
        const resolved = resolveChunkTsBridge({
            specifier: raw,
            sourceFile: input.sourceFile,
            emittedPath: input.emittedPath,
        });
        if (!resolved || resolved.nextSpecifier === raw)
            return raw;
        rewrites += 1;
        const current = bridgesByWrapperPath.get(resolved.bridge.chunkTsWrapperPath);
        if (!current) {
            bridgesByWrapperPath.set(resolved.bridge.chunkTsWrapperPath, resolved.bridge);
        }
        else if (current.chunkArtifactPath !== resolved.bridge.chunkArtifactPath) {
            throw new Error(`Chunk TS bridge collision: wrapper=${resolved.bridge.chunkTsWrapperPath} artifacts=${current.chunkArtifactPath} vs ${resolved.bridge.chunkArtifactPath}`);
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
        return nextLine;
    };
    const rewrittenLines = input.moduleBody.split("\n").map((line) => rewriteLine(line));
    const bridges = Array.from(bridgesByWrapperPath.values()).sort((a, b) => a.chunkTsWrapperPath.localeCompare(b.chunkTsWrapperPath));
    return {
        moduleBody: rewrittenLines.join("\n"),
        rewrites,
        bridges,
    };
}
function renderChunkTsWrapperSource(input) {
    const wrapperDirectory = path.posix.dirname(toPosixPath(input.chunkTsWrapperPath).replace(/^\.?\//, ""));
    const importSpecifier = toRelativePathSpecifier(wrapperDirectory, input.chunkArtifactPath);
    return [
        "/**",
        " * Generated TS bridge to raw chunk artifact.",
        ` * Source chunk artifact: ${input.chunkArtifactPath}`,
        " */",
        "",
        `import * as chunkModule from "${importSpecifier}";`,
        `export * from "${importSpecifier}";`,
        "export default chunkModule;",
        "",
    ].join("\n");
}
