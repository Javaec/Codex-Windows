import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCommand, runCommand } from "./exec";

export interface NpmInvokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

function resolveNodeCommand(): string {
  const node = resolveCommand("node.exe") ?? resolveCommand("node");
  if (!node) throw new Error("node not found.");
  return node;
}

function resolveNpmCliScript(): string {
  const npm = resolveNpmCommand();
  if (npm.toLowerCase().endsWith(".js")) {
    if (!fs.existsSync(npm)) throw new Error(`npm CLI script does not exist: ${npm}`);
    return npm;
  }
  const npmDir = path.dirname(npm);
  const npmCli = path.join(npmDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) {
    throw new Error(`npm-cli.js not found next to npm command: ${npmCli}`);
  }
  return npmCli;
}

function runViaNodeNpm(
  args: string[],
  cwd: string | undefined,
  capture: boolean,
) : NpmInvokeResult {
  const npmCli = resolveNpmCliScript();
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
  return runViaNodeNpm(args, cwd, !passThruOutput);
}

export function invokeNpxWithResult(args: string[], cwd?: string, passThruOutput = false): NpmInvokeResult {
  return runViaNodeNpm(translateNpxArgsToNpmExec(args), cwd, !passThruOutput);
}

export function invokeNpm(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpmWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpx(args: string[], cwd?: string, passThruOutput = false): number {
  return invokeNpxWithResult(args, cwd, passThruOutput).status;
}

export function invokeNpmCapture(args: string[], cwd?: string): string {
  const result = runViaNodeNpm(args, cwd, true);
  return result.stdout || "";
}
