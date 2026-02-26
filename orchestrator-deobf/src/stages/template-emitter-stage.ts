import { TemplateEmitterStageInput, TemplateEmitterStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { OwnershipModel } from "../ir/ownership-model";
import { ChunkArtifactModel } from "../ir/chunk-artifact-model";
import { SemanticIrModel } from "../ir/semantic-ir";
import { emitTemplateProject } from "../emit/template-emitter";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

async function executeTemplateEmitter(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<TemplateEmitterStageInput>(request.inputPath);
  const ownershipModel = await readJsonFile<OwnershipModel>(input.ownershipModelPath);
  const chunkArtifacts = await readJsonFile<ChunkArtifactModel>(input.chunkArtifactsPath);
  const semanticIr = await readJsonFile<SemanticIrModel>(input.semanticIrPath);

  const emitResult = await emitTemplateProject(
    ownershipModel,
    chunkArtifacts,
    semanticIr,
    input.outputProjectDirectory,
    input.statementBudget,
  );

  await writeJsonFile(input.emittedFilesIndexPath, {
    generatedAtIso: new Date().toISOString(),
    files: emitResult.emittedFiles,
  });

  const output: TemplateEmitterStageOutput = {
    outputProjectDirectory: input.outputProjectDirectory,
    emittedFileCount: emitResult.emittedFiles.length,
    emittedModuleCount: emitResult.emittedModuleCount,
    emittedSymbolCount: emitResult.emittedSymbolCount,
    emittedFilesIndexPath: input.emittedFilesIndexPath,
    fileQualityReportPath: emitResult.fileQualityReportPath,
    rerenderedModuleCount: emitResult.rerenderedModuleCount,
    hotChunkCount: emitResult.hotChunkCount,
  };
  await writeJsonFile(request.outputPath, output);
}

export const templateEmitterStage: PipelineStage = {
  id: "template-emitter",
  execute: executeTemplateEmitter,
};
