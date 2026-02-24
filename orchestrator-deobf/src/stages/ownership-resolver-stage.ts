import { OwnershipResolverStageInput, OwnershipResolverStageOutput } from "../contracts";
import { readJsonFile, writeJsonFile } from "../utils/fs-json";
import { SemanticIrModel } from "../ir/semantic-ir";
import { buildOwnershipModel } from "../ir/ownership-model";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

async function executeOwnershipResolver(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<OwnershipResolverStageInput>(request.inputPath);
  const semanticIr = await readJsonFile<SemanticIrModel>(input.namedSemanticIrPath);
  const ownershipModel = buildOwnershipModel(semanticIr);
  await writeJsonFile(input.outputFilePath, ownershipModel);

  const layerCounts = {
    main: 0,
    renderer: 0,
    services: 0,
    tauri: 0,
  };
  const archetypeCounts = {
    hook: 0,
    service: 0,
    ui: 0,
    transport: 0,
    store: 0,
  };
  for (const symbol of ownershipModel.symbols) {
    layerCounts[symbol.layer] += 1;
    archetypeCounts[symbol.archetype] += 1;
  }

  const output: OwnershipResolverStageOutput = {
    outputFilePath: input.outputFilePath,
    symbolCount: ownershipModel.symbols.length,
    layerCounts,
    archetypeCounts,
  };
  await writeJsonFile(request.outputPath, output);
}

export const ownershipResolverStage: PipelineStage = {
  id: "ownership-resolver",
  execute: executeOwnershipResolver,
};
