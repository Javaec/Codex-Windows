import { resolveCmdPath } from "./env";
import { resolveCommand, runCommand } from "./exec";

export interface NpmInvokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runViaCmd(
  scriptPath: string,
  args: string[],
  cwd: string | undefined,
  capture: boolean,
): NpmInvokeResult {
  const cmd = resolveCmdPath() ?? "cmd.exe";
  // Pass tokens separately to avoid fragile string re-quoting under localized cmd.exe.
  const result = runCommand(cmd, ["/d", "/c", "call", scriptPath, ...args], {
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
  const cmd = resolveCmdPath() ?? "cmd.exe";
  const npm = resolveNpmCommand();
  const result = runCommand(cmd, ["/d", "/c", "call", npm, ...args], {
    cwd,
    capture: true,
    allowNonZero: true,
  });
  return result.stdout || "";
}
