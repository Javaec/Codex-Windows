import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_CYAN = "\x1b[36m";

function colorize(text: string, color: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

export function writeHeader(text: string): void {
  process.stdout.write(`\n${colorize(`=== ${text} ===`, ANSI_CYAN)}\n`);
}

export function writeInfo(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeSuccess(text: string): void {
  process.stdout.write(`${colorize(text, ANSI_GREEN)}\n`);
}

export function writeWarn(text: string): void {
  process.stdout.write(`${colorize(text, ANSI_YELLOW)}\n`);
}

export function writeError(text: string): void {
  process.stderr.write(`${colorize(text, ANSI_RED)}\n`);
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function resolveCommand(name: string): string | null {
  const where = spawnSync("where.exe", [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  if (where.error || where.status !== 0) return null;
  const lines = (where.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (fileExists(line)) return path.resolve(line);
  }
  return null;
}

export function mustResolveCommand(name: string): string {
  const resolved = resolveCommand(name);
  if (!resolved) throw new Error(`${name} not found.`);
  return resolved;
}

export function runCommand(
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    capture?: boolean;
    allowNonZero?: boolean;
  },
): CommandResult {
  const capture = Boolean(options?.capture);
  const result = spawnSync(file, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    windowsHide: false,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  const status = typeof result.status === "number" ? result.status : 1;
  const stdout = capture ? (result.stdout || "") : "";
  const stderr = capture ? (result.stderr || "") : "";
  if (!options?.allowNonZero && status !== 0) {
    const details = capture ? `\n${stdout}\n${stderr}` : "";
    throw new Error(`${path.basename(file)} exited with code ${status}.${details}`.trim());
  }
  return { status, stdout, stderr };
}

export function runRobocopy(
  sourceDir: string,
  destinationDir: string,
  extraArgs: string[] = ["/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"],
): void {
  ensureDir(destinationDir);
  const robocopy = resolveCommand("robocopy.exe") ?? "robocopy";
  const result = runCommand(robocopy, [sourceDir, destinationDir, ...extraArgs], {
    capture: true,
    allowNonZero: true,
  });
  if (result.status >= 8) {
    throw new Error(`robocopy failed with code ${result.status}.\n${result.stdout}\n${result.stderr}`.trim());
  }
}

export function uniqueExistingDirs(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !fileExists(candidate)) continue;
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}
