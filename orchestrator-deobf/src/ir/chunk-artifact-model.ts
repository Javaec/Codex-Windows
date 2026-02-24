import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EvidenceSourceFile } from "../contracts";
import { OwnershipModel } from "./ownership-model";

export interface ChunkArtifactRecord {
  chunkId: string;
  lineageId: string;
  sourceFilePath: string;
  sourceKind: "javascript" | "sourcemap" | "text";
  tool: string;
  bytes: number;
  sha256: string;
}

export interface SymbolChunkMapping {
  symbolKey: string;
  symbolName: string;
  lineageId: string;
  chunkId: string;
}

export interface ChunkArtifactModel {
  version: number;
  generatedAtIso: string;
  chunks: ChunkArtifactRecord[];
  symbolMappings: SymbolChunkMapping[];
}

const TOOL_PRIORITY: Record<string, number> = {
  webcrack: 100,
  wakaru: 90,
  "javascript-deobfuscator": 80,
  synchrony: 70,
  "unwebpack-sourcemap": 60,
  asar: 50,
};

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function baseNameStem(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function computeChunkId(filePath: string): string {
  const normalized = normalizePath(filePath);
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  const stem = baseNameStem(filePath) || "artifact";
  return `chunk-${stem}-${digest}`;
}

async function digestFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const content = await fs.readFile(filePath);
  return {
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function pickPreferredChunk(chunks: ChunkArtifactRecord[]): ChunkArtifactRecord {
  const ranked = [...chunks].sort((left, right) => {
    const leftPriority = TOOL_PRIORITY[left.tool] ?? 0;
    const rightPriority = TOOL_PRIORITY[right.tool] ?? 0;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    return left.chunkId.localeCompare(right.chunkId);
  });
  const winner = ranked[0];
  if (!winner) {
    throw new Error("pickPreferredChunk called with empty list");
  }
  return winner;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function chunkScoreForSymbol(chunk: ChunkArtifactRecord, symbolName: string, lineageId: string): number {
  const pathLower = normalizePath(chunk.sourceFilePath).toLowerCase();
  const symbolTokens = tokenize(symbolName).slice(0, 4);
  const lineageTokens = tokenize(lineageId).slice(0, 4);

  let score = (TOOL_PRIORITY[chunk.tool] ?? 40) / 100;
  for (const token of symbolTokens) {
    if (pathLower.includes(token)) {
      score += 0.18;
    }
  }
  for (const token of lineageTokens) {
    if (pathLower.includes(token)) {
      score += 0.07;
    }
  }
  return score;
}

function pickChunkForSymbol(
  chunks: ChunkArtifactRecord[],
  symbolKey: string,
  symbolName: string,
  lineageId: string,
): ChunkArtifactRecord {
  if (chunks.length === 0) {
    throw new Error("pickChunkForSymbol called with empty chunk set");
  }
  if (chunks.length === 1) {
    const single = chunks[0];
    if (!single) {
      throw new Error("pickChunkForSymbol: missing single chunk");
    }
    return single;
  }

  const ranked = [...chunks].sort((left, right) => {
    const leftScore = chunkScoreForSymbol(left, symbolName, lineageId);
    const rightScore = chunkScoreForSymbol(right, symbolName, lineageId);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.chunkId.localeCompare(right.chunkId);
  });

  const windowSize = Math.min(48, ranked.length);
  const stableIndex = stableHash(symbolKey) % windowSize;
  const selected = ranked[stableIndex];
  if (!selected) {
    throw new Error(`pickChunkForSymbol: failed to select chunk for ${symbolKey}`);
  }
  return selected;
}

export async function buildChunkArtifactModel(
  sourceFiles: EvidenceSourceFile[],
  ownershipModel: OwnershipModel,
): Promise<ChunkArtifactModel> {
  const uniqueByPath = new Map<string, EvidenceSourceFile>();
  for (const source of sourceFiles) {
    if (!uniqueByPath.has(source.filePath)) {
      uniqueByPath.set(source.filePath, source);
    }
  }

  const uniqueSources = [...uniqueByPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
  const chunks: ChunkArtifactRecord[] = [];
  for (const source of uniqueSources) {
    const digest = await digestFile(source.filePath);
    chunks.push({
      chunkId: computeChunkId(source.filePath),
      lineageId: source.lineageId,
      sourceFilePath: source.filePath,
      sourceKind: source.sourceKind,
      tool: source.tool,
      bytes: digest.bytes,
      sha256: digest.sha256,
    });
  }

  const chunksByLineage = new Map<string, ChunkArtifactRecord[]>();
  for (const chunk of chunks) {
    const existing = chunksByLineage.get(chunk.lineageId);
    if (existing) {
      existing.push(chunk);
      continue;
    }
    chunksByLineage.set(chunk.lineageId, [chunk]);
  }

  const primaryChunk = pickPreferredChunk(chunks);
  const javascriptChunks = chunks
    .filter((chunk) => chunk.sourceKind === "javascript")
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const symbolMappings: SymbolChunkMapping[] = ownershipModel.symbols
    .map((symbol) => {
      const lineageChunks = chunksByLineage.get(symbol.ownerLineageId);
      const candidatePool =
        lineageChunks && lineageChunks.length >= 12
          ? lineageChunks
          : javascriptChunks.length > 0
            ? javascriptChunks
            : lineageChunks && lineageChunks.length > 0
              ? lineageChunks
              : [primaryChunk];
      const winner = pickChunkForSymbol(candidatePool, symbol.symbolKey, symbol.symbolName, symbol.ownerLineageId);
      return {
        symbolKey: symbol.symbolKey,
        symbolName: symbol.symbolName,
        lineageId: symbol.ownerLineageId,
        chunkId: winner.chunkId,
      };
    })
    .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));

  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    chunks: chunks.sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
    symbolMappings,
  };
}
