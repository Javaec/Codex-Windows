import { EvidenceStoreStageInput, EvidenceStoreStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { buildEvidenceStore } from "../ir/evidence-store";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

async function executeEvidenceStore(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<EvidenceStoreStageInput>(request.inputPath);
  const evidenceStore = await buildEvidenceStore(input.sourceFiles, input.maxRecords);
  await writeJsonFile(input.outputFilePath, evidenceStore);

  const output: EvidenceStoreStageOutput = {
    outputFilePath: input.outputFilePath,
    sourceFileCount: input.sourceFiles.length,
    totalRecords: evidenceStore.stats.totalRecords,
    fileHintCount: evidenceStore.stats.fileHintCount,
    symbolHintCount: evidenceStore.stats.symbolHintCount,
    callEdgeCount: evidenceStore.stats.callEdgeCount,
    stateKeyCount: evidenceStore.stats.stateKeyCount,
    sourceMapCount: evidenceStore.stats.sourceMapCount,
    ioSignatureCount: evidenceStore.stats.ioSignatureCount,
  };
  await writeJsonFile(request.outputPath, output);
}

export const evidenceStoreStage: PipelineStage = {
  id: "evidence-store",
  execute: executeEvidenceStore,
};
