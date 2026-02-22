import * as fs from "node:fs";
import * as path from "node:path";

import { ensureDir, removePath } from "../lib/exec";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export const DEFAULT_REVERSE_LATEST_DIR = path.resolve(REPO_ROOT, "work", "reverse", "latest");
export const DEFAULT_REVERSE_RUNS_ROOT = path.resolve(REPO_ROOT, "work", "reverse", "runs");
export const DEFAULT_REVERSE_REGRESSION_LATEST_DIR = path.resolve(REPO_ROOT, "work", "reverse", "regression-latest");
export const DEFAULT_REVERSE_REGRESSION_RUNS_ROOT = path.resolve(REPO_ROOT, "work", "reverse", "regression-runs");

interface StableRunEntry {
  absPath: string;
  mtimeMs: number;
}

export interface StableRunPaths {
  runId: string;
  runDir: string;
  latestDir: string;
  runsRoot: string;
  keepLastRuns: number;
}

export interface PrepareStableRunInput {
  latestDir: string;
  runsRoot: string;
  keepLastRuns: number;
  runId?: string;
}

export interface PublishStableRunResult {
  removedRuns: string[];
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function toRunStamp(now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const sec = String(now.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}Z`;
}

function sanitizeRunId(raw: string): string {
  const normalized = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Stable run id resolved to empty value.");
  }
  return normalized;
}

function collectStableRunEntries(runsRoot: string): StableRunEntry[] {
  if (!fs.existsSync(runsRoot) || !fs.statSync(runsRoot).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  const out: StableRunEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absPath = path.join(runsRoot, entry.name);
    const stats = fs.statSync(absPath);
    out.push({
      absPath,
      mtimeMs: stats.mtimeMs,
    });
  }
  out.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.absPath.localeCompare(a.absPath);
  });
  return out;
}

export function normalizePathForComparison(input: string): string {
  return toPosixPath(path.resolve(input)).toLowerCase();
}

export function createStableRunId(prefix: string): string {
  const base = sanitizeRunId(prefix);
  return `${base}-${toRunStamp(new Date())}`;
}

export function prepareStableRunPaths(input: PrepareStableRunInput): StableRunPaths {
  if (!Number.isFinite(input.keepLastRuns) || input.keepLastRuns < 1) {
    throw new Error(`keepLastRuns must be >= 1, got ${input.keepLastRuns}`);
  }
  const latestDir = path.resolve(input.latestDir);
  const runsRoot = path.resolve(input.runsRoot);
  ensureDir(runsRoot);

  const runId = sanitizeRunId(input.runId && input.runId.trim().length > 0 ? input.runId : createStableRunId("run"));
  const runDir = path.join(runsRoot, runId);
  removePath(runDir);
  ensureDir(runDir);
  return {
    runId,
    runDir,
    latestDir,
    runsRoot,
    keepLastRuns: Math.floor(input.keepLastRuns),
  };
}

export function pruneStableRunDirs(runsRoot: string, keepLastRuns: number): string[] {
  if (!Number.isFinite(keepLastRuns) || keepLastRuns < 1) {
    throw new Error(`keepLastRuns must be >= 1, got ${keepLastRuns}`);
  }
  const entries = collectStableRunEntries(path.resolve(runsRoot));
  if (entries.length <= keepLastRuns) return [];
  const removed: string[] = [];
  const stale = entries.slice(keepLastRuns);
  for (const entry of stale) {
    removePath(entry.absPath);
    removed.push(toPosixPath(entry.absPath));
  }
  return removed;
}

export function publishStableRun(input: StableRunPaths): PublishStableRunResult {
  removePath(input.latestDir);
  ensureDir(path.dirname(input.latestDir));
  fs.cpSync(input.runDir, input.latestDir, {
    recursive: true,
  });
  const removedRuns = pruneStableRunDirs(input.runsRoot, input.keepLastRuns);
  return { removedRuns };
}
