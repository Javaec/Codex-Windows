import * as path from "node:path";

export interface ChunkTsBridgeRow {
  sourceFile: string;
  chunkArtifactPath: string;
  chunkTsModulePath: string;
}

export interface RewriteChunkImportsResult {
  moduleBody: string;
  rewrites: number;
  bridges: ChunkTsBridgeRow[];
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function toChunkArtifactPath(sourceFile: string): string {
  const normalized = toPosixPath(sourceFile).replace(/^\.?\//, "");
  return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}

function toChunkTsModulePathFromSourceFile(sourceFile: string): string {
  const artifactPath = toChunkArtifactPath(sourceFile).replace(/\.js$/i, ".ts");
  return toPosixPath(path.posix.join("src", "chunks-ts", artifactPath));
}

function toModuleSpecifier(fromDirectory: string, targetFilePath: string): string {
  const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
  const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
  const relative = path.posix.relative(from, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function resolveChunkTsBridge(input: {
  specifier: string;
  sourceFile: string;
  emittedPath: string;
}): {
  nextSpecifier: string;
  bridge: ChunkTsBridgeRow;
} | undefined {
  if (!/^(?:\.{1,2})\//.test(input.specifier)) return undefined;
  if (!/\.(?:mjs|cjs|js)$/i.test(input.specifier)) return undefined;
  const sourceDir = path.posix.dirname(toPosixPath(input.sourceFile).replace(/^\.?\//, ""));
  const resolvedSource = path.posix.normalize(path.posix.join(sourceDir, input.specifier));
  if (resolvedSource.startsWith("../")) return undefined;

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

export function rewriteChunkImportsToTsBridge(input: {
  moduleBody: string;
  sourceFile: string;
  emittedPath: string;
  isBridgeSourceFile?: (sourceFile: string) => boolean;
}): RewriteChunkImportsResult {
  let rewrites = 0;
  const bridgesByModulePath = new Map<string, ChunkTsBridgeRow>();

  const rewriteSpecifier = (raw: string): string => {
    const resolved = resolveChunkTsBridge({
      specifier: raw,
      sourceFile: input.sourceFile,
      emittedPath: input.emittedPath,
    });
    if (!resolved) return raw;

    if (input.isBridgeSourceFile && !input.isBridgeSourceFile(resolved.bridge.sourceFile)) {
      const stripped = raw.replace(/\.(?:mjs|cjs|js)$/i, "");
      if (stripped !== raw) {
        rewrites += 1;
      }
      return stripped;
    }

    if (resolved.nextSpecifier === raw) return raw;
    rewrites += 1;
    const current = bridgesByModulePath.get(resolved.bridge.chunkTsModulePath);
    if (!current) {
      bridgesByModulePath.set(resolved.bridge.chunkTsModulePath, resolved.bridge);
    } else if (current.chunkArtifactPath !== resolved.bridge.chunkArtifactPath) {
      throw new Error(
        `Chunk TS module collision: path=${resolved.bridge.chunkTsModulePath} artifacts=${current.chunkArtifactPath} vs ${resolved.bridge.chunkArtifactPath}`,
      );
    }
    return resolved.nextSpecifier;
  };

  const rewriteLine = (line: string): string => {
    let nextLine = line;
    nextLine = nextLine.replace(/from\s+(['"])([^'"]+)\1/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `from ${quote}${rewritten}${quote}`;
    });
    nextLine = nextLine.replace(/\bimport\s+(['"])([^'"]+)\1/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `import ${quote}${rewritten}${quote}`;
    });
    nextLine = nextLine.replace(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `require(${quote}${rewritten}${quote})`;
    });
    nextLine = nextLine.replace(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `import(${quote}${rewritten}${quote})`;
    });
    nextLine = nextLine.replace(/(['"])(\.{1,2}\/[^'"]+\.(?:mjs|cjs|js))\1/g, (_match, quote: string, specifier: string) => {
      const rewritten = rewriteSpecifier(specifier);
      return `${quote}${rewritten}${quote}`;
    });
    return nextLine;
  };

  const rewrittenLines = input.moduleBody.split("\n").map((line) => rewriteLine(line));
  const bridges = Array.from(bridgesByModulePath.values()).sort((a, b) =>
    a.chunkTsModulePath.localeCompare(b.chunkTsModulePath),
  );
  return {
    moduleBody: rewrittenLines.join("\n"),
    rewrites,
    bridges,
  };
}

export function renderChunkTsModuleSource(input: {
  bridge: ChunkTsBridgeRow;
  moduleBody: string;
  rewrittenImports: number;
}): string {
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
