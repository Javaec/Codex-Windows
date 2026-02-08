import * as fs from "node:fs";
import * as path from "node:path";
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

function resolveNodeCommand(): string {
  const node = resolveCommand("node.exe") ?? resolveCommand("node");
  if (!node) throw new Error("node not found.");
  return node;
}

function resolveNpmCliScript(): string | null {
  const npm = resolveNpmCommand();
  if (npm.toLowerCase().endsWith(".js")) return npm;
  const npmDir = path.dirname(npm);
  const npmCli = path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(npmCli)) return npmCli;
  return null;
}

function runViaNodeNpm(
  args: string[],
  cwd: string | undefined,
  capture: boolean,
): NpmInvokeResult | null {
  const npmCli = resolveNpmCliScript();
  if (!npmCli) return null;
  const node = resolveNodeCommand();
  return runCommand(node, [npmCli, ...args], {
    cwd,
    capture,
    allowNonZero: true,
  });
}

function translateNpxArgsToNpmExec(args: string[]): string[] {
  if (!args.length) return ["exec"];
  let index = 0;
  let yes = false;
  if (args[index] === "-y" || args[index] === "--yes") {
    yes = true;
    index += 1;
  }
  const pkg = args[index];
  if (!pkg) return ["exec", ...args];
  index += 1;
  const commandArgs = args.slice(index);
  const npmArgs = ["exec"];
  if (yes) npmArgs.push("--yes");
  npmArgs.push("--package", pkg);
  if (commandArgs.length) npmArgs.push("--", ...commandArgs);
  return npmArgs;
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
  const nodeResult = runViaNodeNpm(args, cwd, !passThruOutput);
  if (nodeResult) return nodeResult;
  return runViaCmd(resolveNpmCommand(), args, cwd, !passThruOutput);
}

export function invokeNpxWithResult(args: string[], cwd?: string, passThruOutput = false): NpmInvokeResult {
  const nodeResult = runViaNodeNpm(translateNpxArgsToNpmExec(args), cwd, !passThruOutput);
  if (nodeResult) return nodeResult;
  return runViaCmd(resolveNpxCommand(), args, cwd, !passThruOutput);
}

export function invokeNpm(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpmWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpx(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpxWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpmCapture(args: string[], cwd?: string): string {
  const nodeResult = runViaNodeNpm(args, cwd, true);
  if (nodeResult) return nodeResult.stdout || "";
  const cmd = resolveCmdPath() ?? "cmd.exe";
  const npm = resolveNpmCommand();
  const result = runCommand(cmd, ["/d", "/c", "call", npm, ...args], { cwd, capture: true, allowNonZero: true });
  return result.stdout || "";
}
