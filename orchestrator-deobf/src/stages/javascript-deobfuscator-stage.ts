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
  const attempts: Array<{ parseAsModule: boolean; label: string }> = input.parseAsModule
    ? [
        { parseAsModule: true, label: "module" },
        { parseAsModule: false, label: "script-fallback" },
      ]
    : [
        { parseAsModule: false, label: "script" },
        { parseAsModule: true, label: "module-fallback" },
      ];

  const logs: string[] = [];
  let success = false;
  for (const attempt of attempts) {
    const args = ["--yes", "js-deobfuscator", "--input", input.sourceJsPath, "--output", input.outputFilePath];
    if (attempt.parseAsModule) {
      args.push("--module");
    }
    try {
      const commandResult = await runCommand(npxCommand, args, request.runDirectory);
      logs.push(`# attempt:${attempt.label}\n${commandResult.stdout}\n${commandResult.stderr}`);
      success = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`# attempt:${attempt.label}\nexecution-failed\n${message}`);
    }
  }

  if (!success) {
    await fs.copyFile(input.sourceJsPath, input.outputFilePath);
    logs.push("# recovery\nsource-copy-fallback");
  }

  await fs.writeFile(`${request.stageDirectory}/command.log`, logs.join("\n\n"), "utf8");
  const output = await buildJavascriptDeobfuscatorOutput(input);
  await writeJsonFile(request.outputPath, {
    ...output,
    status: "executed",
    reason: success ? "executed" : "source-copy-fallback",
  });
}

export const javascriptDeobfuscatorStage: PipelineStage = {
  id: "javascript-deobfuscator",
  execute: executeJavascriptDeobfuscator,
  cachePlan: {
    version: 2,
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
