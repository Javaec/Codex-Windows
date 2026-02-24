import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NamingMemoryStageInput, NamingMemoryStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { SemanticIrModel } from "../ir/semantic-ir";
import { applyNamingMemory, createEmptyNamingMemory, NamingMemoryModel, updateNamingMemory } from "../ir/naming-memory";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

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

async function executeNamingMemory(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<NamingMemoryStageInput>(request.inputPath);
  const semanticIr = await readJsonFile<SemanticIrModel>(input.semanticIrPath);
  const namingMemory = await readNamingMemoryFromPath(input.namingMemoryPath);
  const updateResult = updateNamingMemory(namingMemory, semanticIr, input.runId);
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
