import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function resolveNpxCommand(): string {
  return "npx";
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

export async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
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
      const normalizedExitCode = typeof exitCode === "number" ? exitCode : -1;
      if (normalizedExitCode !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`));
        return;
      }
      resolve({
        exitCode: normalizedExitCode,
        stdout,
        stderr,
      });
    });
  });
}
