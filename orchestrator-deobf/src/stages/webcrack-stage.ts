import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WebcrackStageInput, WebcrackStageOutput } from "../contracts";
import { runCommand, resolveNpxCommand } from "../adapters/command-runner";
import { listFilesRecursive, isJavascriptFile, FileEntry } from "../utils/file-tree";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

async function prepareOutputDirectory(outputDirectory: string, forceOverwrite: boolean): Promise<void> {
  if (forceOverwrite) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    return;
  }
  const exists = await fs
    .stat(outputDirectory)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(`webcrack output directory is not empty: ${outputDirectory}`);
  }
  await ensureDirectory(outputDirectory);
}

function selectPrimaryOutputJs(files: FileEntry[], outputDirectory: string): { absolutePath: string; relativePath: string } {
  const sorted = files
    .filter((file) => isJavascriptFile(file.relativePath))
    .sort((left, right) => {
      if (left.size !== right.size) {
        return right.size - left.size;
      }
      return left.relativePath.localeCompare(right.relativePath);
    });

  const primary = sorted[0];
  if (!primary) {
    throw new Error("webcrack stage produced zero JavaScript files");
  }

  const relativePath = path.relative(outputDirectory, primary.absolutePath).split(path.sep).join("/");
  return {
    absolutePath: primary.absolutePath,
    relativePath,
  };
}

async function buildWebcrackOutput(input: WebcrackStageInput): Promise<WebcrackStageOutput> {
  const files = await listFilesRecursive(input.outputDirectory);
  const jsFiles = files.filter((file) => isJavascriptFile(file.relativePath));
  const primary = selectPrimaryOutputJs(files, input.outputDirectory);
  return {
    outputDirectory: input.outputDirectory,
    producedFileCount: files.length,
    producedJsFileCount: jsFiles.length,
    primaryOutputJsPath: primary.absolutePath,
    primaryOutputJsRelativePath: primary.relativePath,
  };
}

async function executeWebcrack(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<WebcrackStageInput>(request.inputPath);
  await fs.stat(input.entryJsPath);
  await prepareOutputDirectory(input.outputDirectory, input.forceOverwriteOutputDirectory);

  const npxCommand = resolveNpxCommand();
  const args = input.forceOverwriteOutputDirectory
    ? ["--yes", "webcrack", input.entryJsPath, "-o", input.outputDirectory, "-f"]
    : ["--yes", "webcrack", input.entryJsPath, "-o", input.outputDirectory];
  const commandResult = await runCommand(npxCommand, args, request.runDirectory);
  await fs.writeFile(`${request.stageDirectory}/command.log`, `${commandResult.stdout}\n${commandResult.stderr}`, "utf8");

  const output = await buildWebcrackOutput(input);
  await writeJsonFile(request.outputPath, output);
}

export const webcrackStage: PipelineStage = {
  id: "webcrack",
  execute: executeWebcrack,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as WebcrackStageInput;
      const digest = await hashFileSha256(input.entryJsPath);
      return JSON.stringify({
        entrySha256: digest.sha256,
        entryBytes: digest.bytes,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as WebcrackStageInput;
      return [{ kind: "directory", path: input.outputDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<WebcrackStageOutput> => {
      const input = inputUnknown as WebcrackStageInput;
      return await buildWebcrackOutput(input);
    },
  } as StageCachePlan<unknown>,
};
