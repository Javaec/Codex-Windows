import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  GreenGateCommandResult,
  GreenGateStageInput,
  GreenGateStageOutput,
} from "../contracts";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../utils/fs-json";
import { PipelineStage, StageExecutionRequest } from "./stage-runner";

interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function quoteForWindowsCmd(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }
  if (!/[ \t"&|<>^()]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function runCommandCapture(command: string, args: string[], cwd: string): Promise<CommandRunResult> {
  const started = Date.now();
  return await new Promise<CommandRunResult>((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(
            "cmd.exe",
            ["/d", "/s", "/c", [command, ...args.map((arg) => quoteForWindowsCmd(arg))].join(" ")],
            {
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          )
        : spawn(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (exitCode) => {
      const durationMs = Date.now() - started;
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : -1,
        stdout,
        stderr,
        durationMs,
      });
    });
  });
}

function analyzeRuntimeLogs(payload: string): { runtimeErrorCount: number; runtimeWarningCount: number } {
  const lines = payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let runtimeErrorCount = 0;
  let runtimeWarningCount = 0;
  for (const line of lines) {
    if (/\b(error|exception|fatal|unhandled)\b/i.test(line)) {
      runtimeErrorCount += 1;
      continue;
    }
    if (/\b(warn|warning|deprecated)\b/i.test(line)) {
      runtimeWarningCount += 1;
    }
  }
  return {
    runtimeErrorCount,
    runtimeWarningCount,
  };
}

async function executeGreenGates(request: StageExecutionRequest): Promise<void> {
  const input = await readJsonFile<GreenGateStageInput>(request.inputPath);
  await ensureDirectory(input.logDirectory);
  const commands: Array<{ command: string; args: string[]; label: string }> = [
    { command: "npm", args: ["install", "--include=dev", "--no-audit", "--no-fund"], label: "01-npm-install" },
    { command: "npm", args: ["run", "typecheck"], label: "02-typecheck" },
    { command: "npm", args: ["run", "lint"], label: "03-eslint" },
    { command: "npm", args: ["run", "build"], label: "04-build" },
    { command: "npm", args: ["run", "dev:smoke"], label: "05-dev-smoke" },
  ];

  const checkedCommands: GreenGateCommandResult[] = [];
  let runtimeLogPath = "";
  let runtimeErrorCount = 0;
  let runtimeWarningCount = 0;

  for (const command of commands) {
    const result = await runCommandCapture(command.command, command.args, input.projectDirectory);
    const logPath = path.join(input.logDirectory, `${command.label}.log`);
    await fs.writeFile(logPath, `${result.stdout}\n${result.stderr}`, "utf8");
    checkedCommands.push({
      command: `${command.command} ${command.args.join(" ")}`,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      logPath,
    });

    if (command.label === "05-dev-smoke") {
      runtimeLogPath = logPath;
      const runtimeAnalysis = analyzeRuntimeLogs(`${result.stdout}\n${result.stderr}`);
      runtimeErrorCount = runtimeAnalysis.runtimeErrorCount;
      runtimeWarningCount = runtimeAnalysis.runtimeWarningCount;
    }
  }

  const allCommandsPassed = checkedCommands.every((entry) => entry.exitCode === 0);
  const runtimeHealthy = runtimeErrorCount < 1 && runtimeWarningCount < 1;

  const output: GreenGateStageOutput = {
    passed: allCommandsPassed && runtimeHealthy,
    outputReportPath: input.outputReportPath,
    checkedCommands,
    runtimeLogPath,
    runtimeErrorCount,
    runtimeWarningCount,
  };
  await writeJsonFile(input.outputReportPath, output);
  await writeJsonFile(request.outputPath, output);
}

export const greenGatesStage: PipelineStage = {
  id: "green-gates",
  execute: executeGreenGates,
};
