import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface ChunkArtifactRow {
  sourceFile: string;
  artifactPath: string;
  bytes: number;
  sha256: string;
}

export interface ChunkArtifactRegistry {
  registerSourceChunk(input: { sourceFile: string; sourceChunk: string }): ChunkArtifactRow;
  resolveArtifactPath(sourceFile: string): string;
  getRows(): ChunkArtifactRow[];
  count(): number;
}

interface ChunkArtifactRegistryInput {
  chunkArtifactsRoot: string;
  artifactRootPrefix?: string;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function normalizeSourceFile(input: string): string {
  return toPosixPath(input).replace(/^\.?\//, "").trim();
}

function toChunkArtifactPath(sourceFile: string): string {
  const normalized = normalizeSourceFile(sourceFile);
  return normalized.replace(/\.(?:mjs|cjs|js)$/i, ".js");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function createChunkArtifactRegistry(input: ChunkArtifactRegistryInput): ChunkArtifactRegistry {
  const chunkArtifactsRoot = path.resolve(input.chunkArtifactsRoot);
  const artifactRootPrefix = (input.artifactRootPrefix ?? "src/chunks").replace(/\\/g, "/").replace(/\/+$/, "");
  fs.mkdirSync(chunkArtifactsRoot, { recursive: true });

  const rowBySourceFile = new Map<string, ChunkArtifactRow>();
  const sourceFileByArtifactPath = new Map<string, string>();

  const registerSourceChunk = (registration: { sourceFile: string; sourceChunk: string }): ChunkArtifactRow => {
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
        throw new Error(
          `Chunk artifact registry: source content drift for ${sourceFile} (${currentBySource.sha256} -> ${sha256}).`,
        );
      }
      return currentBySource;
    }

    const currentSourceForArtifact = sourceFileByArtifactPath.get(artifactPath);
    if (currentSourceForArtifact && currentSourceForArtifact !== sourceFile) {
      throw new Error(
        `Chunk artifact registry: artifact path collision ${artifactPath} for ${currentSourceForArtifact} and ${sourceFile}.`,
      );
    }

    fs.mkdirSync(path.dirname(artifactAbsPath), { recursive: true });
    if (fs.existsSync(artifactAbsPath)) {
      const existing = fs.readFileSync(artifactAbsPath, "utf8");
      const existingHash = sha256Hex(existing);
      if (existingHash !== sha256) {
        throw new Error(
          `Chunk artifact registry: existing artifact content mismatch for ${artifactPath} (${existingHash} != ${sha256}).`,
        );
      }
    } else {
      fs.writeFileSync(artifactAbsPath, sourceChunk, "utf8");
    }

    const row: ChunkArtifactRow = {
      sourceFile,
      artifactPath,
      bytes,
      sha256,
    };
    rowBySourceFile.set(sourceFile, row);
    sourceFileByArtifactPath.set(artifactPath, sourceFile);
    return row;
  };

  const resolveArtifactPath = (sourceFileInput: string): string => {
    const sourceFile = normalizeSourceFile(sourceFileInput);
    const row = rowBySourceFile.get(sourceFile);
    if (!row) {
      throw new Error(`Chunk artifact registry: source file is not registered: ${sourceFile}`);
    }
    return row.artifactPath;
  };

  const getRows = (): ChunkArtifactRow[] =>
    Array.from(rowBySourceFile.values()).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));

  const count = (): number => rowBySourceFile.size;

  return {
    registerSourceChunk,
    resolveArtifactPath,
    getRows,
    count,
  };
}
