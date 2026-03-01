import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WakaruStageInput, WakaruStageOutput } from "../contracts";
import { runCommand, resolveNpxCommand } from "../adapters/command-runner";
import { listFilesRecursive, isJavascriptFile } from "../utils/file-tree";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

async function prepareOutputDirectory(outputDirectory: string, forceOverwrite: boolean): Promise<void> {
  if (forceOverwrite) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    await ensureDirectory(outputDirectory);
    return;
  }
  const exists = await fs
    .stat(outputDirectory)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(`wakaru output directory is not empty: ${outputDirectory}`);
  }
  await ensureDirectory(outputDirectory);
}

async function buildWakaruOutput(input: WakaruStageInput): Promise<WakaruStageOutput> {
  const files = await listFilesRecursive(input.outputDirectory);
  const jsFiles = files.filter((file) => isJavascriptFile(file.relativePath));
  return {
    status: "executed",
    outputDirectory: input.outputDirectory,
    producedFileCount: files.length,
    producedJsFileCount: jsFiles.length,
    outputFiles: files.map((file) => path.relative(input.outputDirectory, file.absolutePath).split(path.sep).join("/")),
    reason: "",
  };
}

async function executeWakaru(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<WakaruStageInput>(request.inputPath);
  if (!input.enabled) {
    const output: WakaruStageOutput = {
      status: "skipped",
      outputDirectory: input.outputDirectory,
      producedFileCount: 0,
      producedJsFileCount: 0,
      outputFiles: [],
      reason: "disabled by run flag",
    };
    await writeJsonFile(request.outputPath, output);
    return;
  }
  await fs.stat(input.sourceJsPath);
  await prepareOutputDirectory(input.outputDirectory, input.forceOverwriteOutputDirectory);

  const npxCommand = resolveNpxCommand();
  const args = [
    "--yes",
    "@wakaru/cli",
    "all",
    input.sourceJsPath,
    "--output",
    input.outputDirectory,
    "--force",
    "--concurrency",
    String(input.concurrency),
  ];
  const commandResult = await runCommand(npxCommand, args, request.runDirectory);
  await fs.writeFile(`${request.stageDirectory}/command.log`, `${commandResult.stdout}\n${commandResult.stderr}`, "utf8");

  const output = await buildWakaruOutput(input);
  await writeJsonFile(request.outputPath, output);
}

export const wakaruStage: PipelineStage = {
  id: "wakaru",
  execute: executeWakaru,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as WakaruStageInput;
      if (!input.enabled) {
        return JSON.stringify({
          enabled: false,
        });
      }
      const digest = await hashFileSha256(input.sourceJsPath);
      return JSON.stringify({
        enabled: input.enabled,
        sourceSha256: digest.sha256,
        sourceBytes: digest.bytes,
        concurrency: input.concurrency,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as WakaruStageInput;
      return [{ kind: "directory", path: input.outputDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<WakaruStageOutput> => {
      const input = inputUnknown as WakaruStageInput;
      if (!input.enabled) {
        return {
          status: "skipped",
          outputDirectory: input.outputDirectory,
          producedFileCount: 0,
          producedJsFileCount: 0,
          outputFiles: [],
          reason: "disabled by run flag",
        };
      }
      return await buildWakaruOutput(input);
    },
  } as StageCachePlan<unknown>,
};
