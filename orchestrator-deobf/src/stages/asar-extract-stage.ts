import * as fs from "node:fs/promises";
import { AsarExtractStageInput, AsarExtractStageOutput } from "../contracts";
import { runCommand, resolveNpxCommand } from "../adapters/command-runner";
import { listFilesRecursive, isJavascriptFile, FileEntry } from "../utils/file-tree";
import { hashFileSha256 } from "../utils/hash";
import { ensureCleanDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

function normalizePath(filePath: string): string {
  return filePath.split("\\").join("/");
}

function wildcardPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") {
        return "__WILDCARD__";
      }
      return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
    })
    .join("");
  const regexPattern = escaped.replace(/__WILDCARD__/g, "[^/]*");
  return new RegExp(`^${regexPattern}$`, "i");
}

function selectEntryFile(jsFiles: FileEntry[], entryFileHints: string[]): FileEntry {
  const normalizedFiles = jsFiles
    .map((file) => ({
      ...file,
      relativePath: normalizePath(file.relativePath),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  for (const hint of entryFileHints) {
    const normalizedHint = normalizePath(hint);
    const hintRegex = wildcardPatternToRegex(normalizedHint);
    const matched = normalizedFiles.find((file) => hintRegex.test(file.relativePath));
    if (matched) {
      return matched;
    }
  }

  throw new Error(`Unable to resolve entry JS file using hints: ${entryFileHints.join(", ")}`);
}

function isRelevantPipelinePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath).toLowerCase();
  if (normalized.startsWith(".vite/build/")) {
    return true;
  }
  if (normalized.startsWith("webview/assets/")) {
    return true;
  }
  return false;
}

async function buildAsarExtractOutput(input: AsarExtractStageInput): Promise<AsarExtractStageOutput> {
  const files = await listFilesRecursive(input.extractDirectory);
  const jsFiles = files.filter((file) => isJavascriptFile(file.relativePath));
  const mapFiles = files.filter((file) => file.relativePath.toLowerCase().endsWith(".map"));
  if (jsFiles.length === 0) {
    throw new Error("asar-extract stage produced zero JavaScript files");
  }

  const selectedEntry = selectEntryFile(jsFiles, input.entryFileHints);
  return {
    extractedRootDirectory: input.extractDirectory,
    extractedFileCount: files.length,
    extractedJsFileCount: jsFiles.length,
    extractedMapFileCount: mapFiles.length,
    selectedEntryJsPath: selectedEntry.absolutePath,
    selectedEntryJsRelativePath: selectedEntry.relativePath,
    discoveredJsFiles: jsFiles
      .filter((file) => isRelevantPipelinePath(file.relativePath))
      .map((file) => file.absolutePath)
      .sort((left, right) => left.localeCompare(right)),
    discoveredMapFiles: mapFiles
      .filter((file) => isRelevantPipelinePath(file.relativePath))
      .map((file) => file.absolutePath)
      .sort((left, right) => left.localeCompare(right)),
  };
}

async function executeAsarExtract(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<AsarExtractStageInput>(request.inputPath);
  await fs.stat(input.snapshotAsarPath);
  await ensureCleanDirectory(input.extractDirectory);
  const stageLocalAsarPath = `${request.stageDirectory}/snapshot-input.asar`;
  await fs.link(input.snapshotAsarPath, stageLocalAsarPath);
  const sourceUnpackedDirectory = `${input.snapshotAsarPath}.unpacked`;
  const localUnpackedDirectory = `${stageLocalAsarPath}.unpacked`;
  const hasUnpackedDirectory = await fs
    .stat(sourceUnpackedDirectory)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (hasUnpackedDirectory) {
    await fs.symlink(sourceUnpackedDirectory, localUnpackedDirectory, "junction");
  }

  const npxCommand = resolveNpxCommand();
  const args = ["--yes", "@electron/asar", "extract", stageLocalAsarPath, input.extractDirectory];
  const commandResult = await runCommand(npxCommand, args, request.runDirectory);

  await fs.writeFile(`${request.stageDirectory}/command.log`, `${commandResult.stdout}\n${commandResult.stderr}`, "utf8");

  const output = await buildAsarExtractOutput(input);
  await writeJsonFile(request.outputPath, output);
}

export const asarExtractStage: PipelineStage = {
  id: "asar-extract",
  execute: executeAsarExtract,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as AsarExtractStageInput;
      const digest = await hashFileSha256(input.snapshotAsarPath);
      return JSON.stringify({
        snapshotSha256: digest.sha256,
        snapshotBytes: digest.bytes,
        entryFileHints: input.entryFileHints,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as AsarExtractStageInput;
      return [{ kind: "directory", path: input.extractDirectory }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<AsarExtractStageOutput> => {
      const input = inputUnknown as AsarExtractStageInput;
      return await buildAsarExtractOutput(input);
    },
  } as StageCachePlan<unknown>,
};
