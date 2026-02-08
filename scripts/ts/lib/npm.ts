import { resolveCmdPath } from "./env";
import { resolveCommand, runCommand } from "./exec";

export interface NpmInvokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

function quoteForCmd(value: string): string {
  if (value === "") return '""';
  if (!/[\s"&()^|<>]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function runViaCmd(
  scriptPath: string,
  args: string[],
  cwd: string | undefined,
  capture: boolean,
): NpmInvokeResult {
  const cmd = resolveCmdPath() ?? "cmd.exe";
  const line = [quoteForCmd(scriptPath), ...args.map(quoteForCmd)].join(" ");
  const result = runCommand(cmd, ["/d", "/s", "/c", line], {
    cwd,
    capture,
    allowNonZero: true,
  });
  return result;
}

export function resolveNpmCommand(): string {
  const npm = resolveCommand("npm.cmd") ?? resolveCommand("npm");
  if (!npm) throw new Error("npm not found.");
  return npm;
}

export function resolveNpxCommand(): string {
  const npx = resolveCommand("npx.cmd") ?? resolveCommand("npx");
  if (!npx) throw new Error("npx not found.");
  return npx;
}

export function invokeNpmWithResult(args: string[], cwd?: string, passThruOutput = false): NpmInvokeResult {
  return runViaCmd(resolveNpmCommand(), args, cwd, !passThruOutput);
}

export function invokeNpxWithResult(args: string[], cwd?: string, passThruOutput = false): NpmInvokeResult {
  return runViaCmd(resolveNpxCommand(), args, cwd, !passThruOutput);
}

export function invokeNpm(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpmWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpx(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpxWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpmCapture(args: string[], cwd?: string): string {
  return invokeNpmWithResult(args, cwd, false).stdout || "";
}
