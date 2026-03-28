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

function normalizeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function isRetryableFsError(error: unknown): boolean {
  const code = normalizeErrorCode(error);
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES";
}

function runFsOperation<T>(label: string, operation: () => T, maxAttempts = 6): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt >= maxAttempts) {
        throw error;
      }
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${String(lastError)}`);
}

function normalizeExecutablePath(input: string): string {
  let normalized = String(input || "").trim();
  if (!normalized) return normalized;

  for (let i = 0; i < 4; i += 1) {
    const before = normalized;
    normalized = normalized
      .replace(/^"+/, "")
      .replace(/"+$/, "")
      .replace(/^'+/, "")
      .replace(/'+$/, "")
      .replace(/^\\+"/, "")
      .replace(/\\+"$/, "")
      .trim();
    if (normalized === before) break;
  }

  return normalized;
}

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function removePath(targetPath: string): void {
  if (!targetPath || !fileExists(targetPath)) return;
  runFsOperation(`remove path ${targetPath}`, () => {
    fs.rmSync(targetPath, { recursive: true, force: true });
  });
}

export function copyFileSafe(sourcePath: string, destinationPath: string): void {
  if (!fileExists(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  ensureDir(path.dirname(destinationPath));
  runFsOperation(`copy file ${sourcePath} -> ${destinationPath}`, () => {
    fs.copyFileSync(sourcePath, destinationPath);
  });
}

export function copyDirectory(sourceDir: string, destinationDir: string): void {
  if (!fileExists(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }
  ensureDir(destinationDir);
  runFsOperation(`copy directory ${sourceDir} -> ${destinationDir}`, () => {
    fs.cpSync(sourceDir, destinationDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: true,
    });
  });
}

export function movePathSafe(sourcePath: string, destinationPath: string): void {
  if (!fileExists(sourcePath)) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }
  ensureDir(path.dirname(destinationPath));
  runFsOperation(`move path ${sourcePath} -> ${destinationPath}`, () => {
    fs.renameSync(sourcePath, destinationPath);
  });
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
    .map((line) => normalizeExecutablePath(line))
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
  const executable = normalizeExecutablePath(file);
  if (!executable) {
    throw new Error(`Command executable is empty. Args=[${args.join(" ")}]`);
  }
  const capture = Boolean(options?.capture);
  const result = spawnSync(executable, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    windowsHide: false,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw new Error(
      `Failed to spawn [${executable}] ${args.join(" ")}: ${result.error.message}`,
    );
  }

  const status = typeof result.status === "number" ? result.status : 1;
  const stdout = capture ? (result.stdout || "") : "";
  const stderr = capture ? (result.stderr || "") : "";
  if (!options?.allowNonZero && status !== 0) {
    const details = capture ? `\n${stdout}\n${stderr}` : "";
    throw new Error(`${path.basename(executable)} exited with code ${status}.${details}`.trim());
  }
  return { status, stdout, stderr };
}

export function runRobocopy(
  sourceDir: string,
  destinationDir: string,
  _extraArgs: string[] = ["/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"],
): void {
  copyDirectory(sourceDir, destinationDir);
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
