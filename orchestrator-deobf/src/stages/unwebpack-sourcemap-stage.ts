import * as fs from "node:fs/promises";
import * as path from "node:path";
import { UnwebpackSourcemapStageInput, UnwebpackSourcemapStageOutput } from "../contracts";
import { runCommand } from "../adapters/command-runner";
import { hashFileSha256 } from "../utils/hash";
import { ensureCleanDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { listFilesRecursive } from "../utils/file-tree";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function buildUnwebpackOutput(input: UnwebpackSourcemapStageInput): Promise<UnwebpackSourcemapStageOutput> {
  if (!input.enabled) {
    return {
      status: "skipped",
      outputDirectory: input.outputDirectory,
      scannedMapCount: input.mapFilePaths.length,
      usedMapCount: 0,
      extractedSourceFileCount: 0,
      extractedSourceFiles: [],
      reason: "stage-disabled",
    };
  }

  const selectedMapFiles = input.mapFilePaths.slice(0, input.maxMaps);
  if (selectedMapFiles.length === 0) {
    return {
      status: "skipped",
      outputDirectory: input.outputDirectory,
      scannedMapCount: 0,
      usedMapCount: 0,
      extractedSourceFileCount: 0,
      extractedSourceFiles: [],
      reason: "no-map-files",
    };
  }

  const extractedFiles = await listFilesRecursive(input.outputDirectory);
  return {
    status: "executed",
    outputDirectory: input.outputDirectory,
    scannedMapCount: input.mapFilePaths.length,
    usedMapCount: selectedMapFiles.length,
    extractedSourceFileCount: extractedFiles.length,
    extractedSourceFiles: extractedFiles.map((file) => normalizePath(file.absolutePath)).sort((left, right) => left.localeCompare(right)),
    reason: "executed",
  };
}

async function executeUnwebpackSourcemap(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<UnwebpackSourcemapStageInput>(request.inputPath);
  if (!input.enabled) {
    const skipped = await buildUnwebpackOutput(input);
    await writeJsonFile(request.outputPath, skipped);
    return;
  }

  await fs.stat(input.referenceScriptPath);
  const selectedMapFiles = input.mapFilePaths.slice(0, input.maxMaps);
  if (selectedMapFiles.length === 0) {
    const skipped = await buildUnwebpackOutput(input);
    await writeJsonFile(request.outputPath, skipped);
    return;
  }

  await ensureCleanDirectory(input.outputDirectory);
  const logs: string[] = [];
  for (let index = 0; index < selectedMapFiles.length; index += 1) {
    const mapPath = selectedMapFiles[index];
    if (!mapPath) {
      continue;
    }
    await fs.stat(mapPath);
    const mapOutputDirectory = path.join(input.outputDirectory, `map-${String(index + 1).padStart(3, "0")}`);
    const args = [input.referenceScriptPath, "--local", "--make-directory", mapPath, mapOutputDirectory];
    try {
      const commandResult = await runCommand(input.pythonExecutable, args, request.runDirectory);
      logs.push(`# map:${mapPath}\n${commandResult.stdout}\n${commandResult.stderr}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`# map:${mapPath}\nexecution-failed\n${message}`);
    }
  }

  await fs.writeFile(`${request.stageDirectory}/command.log`, logs.join("\n\n"), "utf8");
  const output = await buildUnwebpackOutput(input);
  await writeJsonFile(request.outputPath, output);
}

export const unwebpackSourcemapStage: PipelineStage = {
  id: "unwebpack-sourcemap",
  execute: executeUnwebpackSourcemap,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as UnwebpackSourcemapStageInput;
      if (!input.enabled) {
        return JSON.stringify({ enabled: false });
      }
      const scriptDigest = await hashFileSha256(input.referenceScriptPath);
      const selectedMaps = input.mapFilePaths.slice(0, input.maxMaps).sort((left, right) => left.localeCompare(right));
      const mapDigests: Array<{ path: string; sha256: string; bytes: number }> = [];
      for (const mapPath of selectedMaps) {
        const digest = await hashFileSha256(mapPath);
        mapDigests.push({
          path: normalizePath(mapPath),
          sha256: digest.sha256,
          bytes: digest.bytes,
        });
      }
      return JSON.stringify({
        enabled: true,
        pythonExecutable: input.pythonExecutable,
        scriptSha256: scriptDigest.sha256,
        scriptBytes: scriptDigest.bytes,
        maxMaps: input.maxMaps,
        maps: mapDigests,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as UnwebpackSourcemapStageInput;
      if (!input.enabled || input.mapFilePaths.length === 0) {
        return [];
      }
      return [{ kind: "directory", path: input.outputDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<UnwebpackSourcemapStageOutput> => {
      const input = inputUnknown as UnwebpackSourcemapStageInput;
      return await buildUnwebpackOutput(input);
    },
  } as StageCachePlan<unknown>,
};
