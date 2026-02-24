import { ChunkArtifactModelStageInput, ChunkArtifactModelStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { OwnershipModel } from "../ir/ownership-model";
import { buildChunkArtifactModel } from "../ir/chunk-artifact-model";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

async function executeChunkArtifactModel(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<ChunkArtifactModelStageInput>(request.inputPath);
  const ownershipModel = await readJsonFile<OwnershipModel>(input.ownershipModelPath);
  const chunkArtifactModel = await buildChunkArtifactModel(input.sourceFiles, ownershipModel);
  await writeJsonFile(input.outputFilePath, chunkArtifactModel);

  const output: ChunkArtifactModelStageOutput = {
    outputFilePath: input.outputFilePath,
    artifactCount: chunkArtifactModel.chunks.length,
    symbolMappingCount: chunkArtifactModel.symbolMappings.length,
  };
  await writeJsonFile(request.outputPath, output);
}

export const chunkArtifactModelStage: PipelineStage = {
  id: "chunk-artifact-model",
  execute: executeChunkArtifactModel,
};
