import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JavascriptDeobfuscatorStageInput, JavascriptDeobfuscatorStageOutput } from "../contracts";
import { runCommand, resolveNpxCommand } from "../adapters/command-runner";
import { hashFileSha256 } from "../utils/hash";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest, StageCachePlan } from "./stage-runner";

async function buildJavascriptDeobfuscatorOutput(input: JavascriptDeobfuscatorStageInput): Promise<JavascriptDeobfuscatorStageOutput> {
  if (!input.enabled) {
    return {
      status: "skipped",
      outputFilePath: input.outputFilePath,
      producedBytes: 0,
      reason: "stage-disabled",
    };
  }
  const stat = await fs.stat(input.outputFilePath);
  return {
    status: "executed",
    outputFilePath: input.outputFilePath,
    producedBytes: stat.size,
    reason: "executed",
  };
}

async function executeJavascriptDeobfuscator(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<JavascriptDeobfuscatorStageInput>(request.inputPath);
  if (!input.enabled) {
    const skipped = await buildJavascriptDeobfuscatorOutput(input);
    await writeJsonFile(request.outputPath, skipped);
    return;
  }

  await fs.stat(input.sourceJsPath);
  await ensureDirectory(path.dirname(input.outputFilePath));

  const npxCommand = resolveNpxCommand();
  const args = ["--yes", "js-deobfuscator", "--input", input.sourceJsPath, "--output", input.outputFilePath];
  if (input.parseAsModule) {
    args.push("--module");
  }
  let commandResult: { stdout: string; stderr: string };
  try {
    commandResult = await runCommand(npxCommand, args, request.runDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: JavascriptDeobfuscatorStageOutput = {
      status: "skipped",
      outputFilePath: input.outputFilePath,
      producedBytes: 0,
      reason: `execution-failed:${message.slice(0, 180)}`,
    };
    await writeJsonFile(request.outputPath, failed);
    return;
  }
  await fs.writeFile(`${request.stageDirectory}/command.log`, `${commandResult.stdout}\n${commandResult.stderr}`, "utf8");

  const output = await buildJavascriptDeobfuscatorOutput(input);
  await writeJsonFile(request.outputPath, output);
}

export const javascriptDeobfuscatorStage: PipelineStage = {
  id: "javascript-deobfuscator",
  execute: executeJavascriptDeobfuscator,
  cachePlan: {
    version: 1,
    key: async (inputUnknown: unknown): Promise<string> => {
      const input = inputUnknown as JavascriptDeobfuscatorStageInput;
      if (!input.enabled) {
        return JSON.stringify({ enabled: false });
      }
      const digest = await hashFileSha256(input.sourceJsPath);
      return JSON.stringify({
        enabled: true,
        sourceSha256: digest.sha256,
        sourceBytes: digest.bytes,
        parseAsModule: input.parseAsModule,
      });
    },
    artifacts: (inputUnknown: unknown) => {
      const input = inputUnknown as JavascriptDeobfuscatorStageInput;
      if (!input.enabled) {
        return [];
      }
      return [{ kind: "file", path: input.outputFilePath }];
    },
    rehydrateOutput: async (inputUnknown: unknown): Promise<JavascriptDeobfuscatorStageOutput> => {
      const input = inputUnknown as JavascriptDeobfuscatorStageInput;
      return await buildJavascriptDeobfuscatorOutput(input);
    },
  } as StageCachePlan<unknown>,
};
