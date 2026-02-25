import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NamingMemoryStageInput, NamingMemoryStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { SemanticIrModel } from "../ir/semantic-ir";
import {
  applyNamingMemory,
  createEmptyNamingMemory,
  NamingMemoryModel,
  NamingSeedCandidate,
  updateNamingMemory,
} from "../ir/naming-memory";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

interface CensusSeedEntry {
  symbolKey: string;
  censusName: string;
  signalScore?: number;
  promoteToQuality?: boolean;
}

interface CensusMappingModel {
  seedEntries: CensusSeedEntry[];
}

async function readNamingMemoryFromPath(namingMemoryPath: string): Promise<NamingMemoryModel> {
  const exists = await fs
    .stat(namingMemoryPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return createEmptyNamingMemory();
  }
  return await readJsonFile<NamingMemoryModel>(namingMemoryPath);
}

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

function scoreSeedCandidate(candidate: NamingSeedCandidate): number {
  return Number((candidate.confidence * 0.75 + candidate.signalScore * 0.25).toFixed(4));
}

function pickStrongerSeed(
  existing: NamingSeedCandidate | undefined,
  incoming: NamingSeedCandidate,
): NamingSeedCandidate {
  if (!existing) {
    return incoming;
  }
  const existingScore = scoreSeedCandidate(existing);
  const incomingScore = scoreSeedCandidate(incoming);
  if (incomingScore !== existingScore) {
    return incomingScore > existingScore ? incoming : existing;
  }
  if (incoming.name.length !== existing.name.length) {
    return incoming.name.length > existing.name.length ? incoming : existing;
  }
  return incoming.name.localeCompare(existing.name) < 0 ? incoming : existing;
}

function toPromotionKey(symbolKey: string): string {
  return symbolKey.replace("-census:", ":");
}

async function readSeedMap(censusMappingPath: string): Promise<Map<string, NamingSeedCandidate>> {
  const exists = await fs
    .stat(censusMappingPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return new Map<string, NamingSeedCandidate>();
  }
  const mapping = await readJsonFile<CensusMappingModel>(censusMappingPath);
  const seedMap = new Map<string, NamingSeedCandidate>();
  for (const entry of mapping.seedEntries) {
    const signalScore = clamp(typeof entry.signalScore === "number" ? entry.signalScore : 0.42);
    const directCandidate: NamingSeedCandidate = {
      name: entry.censusName,
      confidence: clamp(0.38 + signalScore * 0.34),
      source: "direct",
      signalScore,
    };
    seedMap.set(entry.symbolKey, pickStrongerSeed(seedMap.get(entry.symbolKey), directCandidate));

    if (!entry.promoteToQuality) {
      continue;
    }
    const promotedKey = toPromotionKey(entry.symbolKey);
    if (promotedKey === entry.symbolKey) {
      continue;
    }
    const promotedCandidate: NamingSeedCandidate = {
      name: entry.censusName,
      confidence: clamp(0.64 + signalScore * 0.28),
      source: "promotion",
      signalScore,
    };
    seedMap.set(promotedKey, pickStrongerSeed(seedMap.get(promotedKey), promotedCandidate));
  }
  return seedMap;
}

async function executeNamingMemory(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<NamingMemoryStageInput>(request.inputPath);
  const semanticIr = await readJsonFile<SemanticIrModel>(input.semanticIrPath);
  const namingMemory = await readNamingMemoryFromPath(input.namingMemoryPath);
  const seedNameBySymbolKey = await readSeedMap(input.censusMappingPath);
  const updateResult = updateNamingMemory(namingMemory, semanticIr, input.runId, seedNameBySymbolKey);
  const namedSemanticIr = applyNamingMemory(semanticIr, updateResult.namingMemory);

  await fs.mkdir(path.dirname(input.namingMemoryPath), { recursive: true });
  await fs.mkdir(path.dirname(input.snapshotPath), { recursive: true });
  await fs.mkdir(path.dirname(input.namedSemanticIrPath), { recursive: true });
  await writeJsonFile(input.namingMemoryPath, updateResult.namingMemory);
  await writeJsonFile(input.snapshotPath, updateResult.namingMemory);
  await writeJsonFile(input.namedSemanticIrPath, namedSemanticIr);

  const output: NamingMemoryStageOutput = {
    namingMemoryPath: input.namingMemoryPath,
    snapshotPath: input.snapshotPath,
    namedSemanticIrPath: input.namedSemanticIrPath,
    insertedEntryCount: updateResult.insertedEntryCount,
    updatedEntryCount: updateResult.updatedEntryCount,
    keptEntryCount: updateResult.keptEntryCount,
  };
  await writeJsonFile(request.outputPath, output);
}

export const namingMemoryStage: PipelineStage = {
  id: "naming-memory",
  execute: executeNamingMemory,
};
