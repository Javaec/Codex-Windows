import * as path from "node:path";

export interface ChunkTsBridgeRow {
  sourceFile: string;
  chunkArtifactPath: string;
  chunkTsWrapperPath: string;
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

function toChunkTsWrapperPathFromSourceFile(sourceFile: string): string {
  const artifactPath = toChunkArtifactPath(sourceFile).replace(/\.js$/i, ".ts");
  return toPosixPath(path.posix.join("src", "chunks-ts", artifactPath));
}

function toModuleSpecifier(fromDirectory: string, targetFilePath: string): string {
  const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
  const target = toPosixPath(targetFilePath).replace(/^\.?\//, "").replace(/\.ts$/i, "");
  const relative = path.posix.relative(from, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function toRelativePathSpecifier(fromDirectory: string, targetFilePath: string): string {
  const from = toPosixPath(fromDirectory).replace(/^\.?\//, "");
  const target = toPosixPath(targetFilePath).replace(/^\.?\//, "");
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

export function rewriteChunkImportsToTsBridge(input: {
  moduleBody: string;
  sourceFile: string;
  emittedPath: string;
}): RewriteChunkImportsResult {
  let rewrites = 0;
  const bridgesByWrapperPath = new Map<string, ChunkTsBridgeRow>();

  const rewriteSpecifier = (raw: string): string => {
    const resolved = resolveChunkTsBridge({
      specifier: raw,
      sourceFile: input.sourceFile,
      emittedPath: input.emittedPath,
    });
    if (!resolved || resolved.nextSpecifier === raw) return raw;
    rewrites += 1;
    const current = bridgesByWrapperPath.get(resolved.bridge.chunkTsWrapperPath);
    if (!current) {
      bridgesByWrapperPath.set(resolved.bridge.chunkTsWrapperPath, resolved.bridge);
    } else if (current.chunkArtifactPath !== resolved.bridge.chunkArtifactPath) {
      throw new Error(
        `Chunk TS bridge collision: wrapper=${resolved.bridge.chunkTsWrapperPath} artifacts=${current.chunkArtifactPath} vs ${resolved.bridge.chunkArtifactPath}`,
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
    return nextLine;
  };

  const rewrittenLines = input.moduleBody.split("\n").map((line) => rewriteLine(line));
  const bridges = Array.from(bridgesByWrapperPath.values()).sort((a, b) =>
    a.chunkTsWrapperPath.localeCompare(b.chunkTsWrapperPath),
  );
  return {
    moduleBody: rewrittenLines.join("\n"),
    rewrites,
    bridges,
  };
}

export function renderChunkTsWrapperSource(input: ChunkTsBridgeRow): string {
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
