import * as fs from "node:fs";
import * as path from "node:path";
import { removePath, writeInfo, writeWarn } from "./exec";

export interface CodexCleanupPolicy {
  logMaxAgeDays: number;
  sessionMaxAgeDays: number;
  worktreeMaxAgeDays: number;
}

export interface CodexCleanupStats {
  rootDir: string;
  logsRemoved: number;
  sessionsRemoved: number;
  worktreeRootsRemoved: number;
  bytesRemoved: number;
}

const DEFAULT_POLICY: CodexCleanupPolicy = {
  logMaxAgeDays: 7,
  sessionMaxAgeDays: 10,
  worktreeMaxAgeDays: 5,
};

function resolveCodexHome(): string {
  const explicit = String(process.env.CODEX_HOME || "").trim();
  if (explicit) return path.resolve(explicit);

  const userProfile = String(process.env.USERPROFILE || "").trim();
  if (!userProfile) {
    throw new Error("Unable to resolve Codex home: USERPROFILE is not set.");
  }
  return path.join(userProfile, ".codex");
}

function isDirectory(fullPath: string): boolean {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function statSafe(fullPath: string): fs.Stats | null {
  try {
    return fs.statSync(fullPath);
  } catch {
    return null;
  }
}

function listChildren(fullPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pruneOldFiles(rootDir: string, cutoffMs: number): { removedFiles: number; removedBytes: number } {
  if (!isDirectory(rootDir)) return { removedFiles: 0, removedBytes: 0 };

  const stack: string[] = [rootDir];
  const visitOrder: string[] = [];
  let removedFiles = 0;
  let removedBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop() as string;
    visitOrder.push(current);
    for (const entry of listChildren(current)) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSafe(target);
      if (!stats) continue;
      if (stats.mtimeMs >= cutoffMs) continue;
      removedBytes += stats.size;
      removePath(target);
      removedFiles += 1;
    }
  }

  visitOrder.sort((a, b) => b.length - a.length);
  for (const current of visitOrder) {
    if (current === rootDir) continue;
    const children = listChildren(current);
    if (children.length === 0) {
      removePath(current);
    }
  }

  return { removedFiles, removedBytes };
}

interface TreeMetrics {
  latestMtimeMs: number;
  totalBytes: number;
}

function collectTreeMetrics(rootDir: string): TreeMetrics {
  const rootStats = statSafe(rootDir);
  if (!rootStats) return { latestMtimeMs: 0, totalBytes: 0 };

  let latestMtimeMs = rootStats.mtimeMs;
  let totalBytes = rootStats.isFile() ? rootStats.size : 0;
  const stack: string[] = rootStats.isDirectory() ? [rootDir] : [];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of listChildren(current)) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      const stats = statSafe(target);
      if (!stats) continue;
      if (stats.mtimeMs > latestMtimeMs) latestMtimeMs = stats.mtimeMs;
      if (stats.isDirectory()) {
        stack.push(target);
        continue;
      }
      if (stats.isFile()) totalBytes += stats.size;
    }
  }

  return { latestMtimeMs, totalBytes };
}

function pruneOldWorktrees(worktreesDir: string, cutoffMs: number): { removedRoots: number; removedBytes: number } {
  if (!isDirectory(worktreesDir)) return { removedRoots: 0, removedBytes: 0 };

  let removedRoots = 0;
  let removedBytes = 0;

  for (const entry of listChildren(worktreesDir)) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(worktreesDir, entry.name);
    const stats = statSafe(target);
    if (!stats) continue;

    if (stats.isFile()) {
      if (stats.mtimeMs >= cutoffMs) continue;
      removedBytes += stats.size;
      removePath(target);
      removedRoots += 1;
      continue;
    }

    if (!stats.isDirectory()) continue;
    const metrics = collectTreeMetrics(target);
    if (metrics.latestMtimeMs >= cutoffMs) continue;
    removedBytes += metrics.totalBytes;
    removePath(target);
    removedRoots += 1;
  }

  return { removedRoots, removedBytes };
}

export function cleanupCodexState(rawPolicy: Partial<CodexCleanupPolicy> = {}): CodexCleanupStats {
  const policy: CodexCleanupPolicy = { ...DEFAULT_POLICY, ...rawPolicy };
  const codexHome = resolveCodexHome();
  if (!isDirectory(codexHome)) {
    writeWarn(`[cleanup] Codex home not found, skipping: ${codexHome}`);
    return {
      rootDir: codexHome,
      logsRemoved: 0,
      sessionsRemoved: 0,
      worktreeRootsRemoved: 0,
      bytesRemoved: 0,
    };
  }

  const now = Date.now();
  const logsCutoff = now - policy.logMaxAgeDays * 24 * 60 * 60 * 1000;
  const sessionsCutoff = now - policy.sessionMaxAgeDays * 24 * 60 * 60 * 1000;
  const worktreesCutoff = now - policy.worktreeMaxAgeDays * 24 * 60 * 60 * 1000;

  const logsResult = pruneOldFiles(path.join(codexHome, "log"), logsCutoff);
  const sessionsResult = pruneOldFiles(path.join(codexHome, "sessions"), sessionsCutoff);
  const worktreesResult = pruneOldWorktrees(path.join(codexHome, "worktrees"), worktreesCutoff);
  const bytesRemoved = logsResult.removedBytes + sessionsResult.removedBytes + worktreesResult.removedBytes;

  writeInfo(
    `[cleanup] codexHome=${codexHome} logsRemoved=${logsResult.removedFiles} sessionsRemoved=${sessionsResult.removedFiles} worktreeRootsRemoved=${worktreesResult.removedRoots} reclaimedMB=${(bytesRemoved / 1024 / 1024).toFixed(2)}`,
  );

  return {
    rootDir: codexHome,
    logsRemoved: logsResult.removedFiles,
    sessionsRemoved: sessionsResult.removedFiles,
    worktreeRootsRemoved: worktreesResult.removedRoots,
    bytesRemoved,
  };
}
