import { SemanticIrStageInput, SemanticIrStageOutput } from "../contracts";
import { hashFileSha256 } from "../utils/hash";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { EvidenceStoreModel } from "../ir/evidence-store";
import { SemanticIrModel } from "../ir/semantic-ir";
import { buildSemanticIrFromSweep } from "../ir/semantic-ir-sweep";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

async function executeSemanticIr(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<SemanticIrStageInput>(request.inputPath);
  const evidenceStore = await readJsonFile<EvidenceStoreModel>(input.evidenceStorePath);
  const sweepProfiles = input.sweepProfiles.length > 0 ? input.sweepProfiles : [{ profileId: "base", toolWeights: input.toolWeights }];
  const sweepResult = buildSemanticIrFromSweep(evidenceStore, sweepProfiles);
  await writeJsonFile(input.outputFilePath, sweepResult.merged);

  const output: SemanticIrStageOutput = {
    outputFilePath: input.outputFilePath,
    fileCount: sweepResult.merged.fileHints.length,
    symbolCount: sweepResult.merged.symbols.length,
    callEdgeCount: sweepResult.merged.callEdges.length,
    stateKeyCount: sweepResult.merged.stateKeys.length,
    profileCount: sweepResult.profileCount,
    anchorProfileId: sweepResult.anchorProfileId,
    mergedSymbolWinners: sweepResult.mergedSymbolWinners,
    mergedFileHintWinners: sweepResult.mergedFileHintWinners,
  };
  await writeJsonFile(`${request.stageDirectory}/sweep-profiles.json`, {
    generatedAtIso: new Date().toISOString(),
    profileSummaries: sweepResult.profileSummaries,
    anchorProfileId: sweepResult.anchorProfileId,
  });
  await writeJsonFile(request.outputPath, output);
}

export const semanticIrStage: PipelineStage = {
  id: "semantic-ir",
  execute: executeSemanticIr,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as SemanticIrStageInput;
      const digest = await hashFileSha256(input.evidenceStorePath);
      return JSON.stringify({
        evidenceStoreSha256: digest.sha256,
        evidenceStoreBytes: digest.bytes,
        sweepProfiles: input.sweepProfiles,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as SemanticIrStageInput;
      return [{ kind: "file", path: input.outputFilePath }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<SemanticIrStageOutput> => {
      const input = inputUnknown as SemanticIrStageInput;
      const semanticIr = await readJsonFile<SemanticIrModel>(input.outputFilePath);
      const profiles = input.sweepProfiles.length;
      const firstProfile = input.sweepProfiles[0];
      return {
        outputFilePath: input.outputFilePath,
        fileCount: semanticIr.fileHints.length,
        symbolCount: semanticIr.symbols.length,
        callEdgeCount: semanticIr.callEdges.length,
        stateKeyCount: semanticIr.stateKeys.length,
        profileCount: profiles,
        anchorProfileId: firstProfile ? firstProfile.profileId : "base",
        mergedSymbolWinners: semanticIr.symbols.length,
        mergedFileHintWinners: semanticIr.fileHints.length,
      };
    },
  } as StageCachePlan<unknown>,
};
