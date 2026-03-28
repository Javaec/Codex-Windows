import * as fs from "node:fs";
import * as path from "node:path";
import { fileExists, removePath, writeSuccess, writeWarn } from "../exec";

const STALE_ARTIFACT_MAX_AGE_HOURS = 12;

const PROTECTED_WORK_NAMES = new Set([
  "_resources",
  "app",
  "cache",
  "diagnostics",
  "electron",
  "extracted",
  "native-builds",
  "tools",
  "userdata",
  "state.manifest.json",
]);

const PROTECTED_WORK_PREFIXES = ["state.manifest."];

const PROTECTED_DIST_NAMES = new Set([
  "Codex-win32-x64",
  "Codex-win32-arm64",
  "Launch-Codex-latest.cmd",
  "Launch-Codex-latest-with-mods.cmd",
]);

type CleanupRootInput = {
  rootDir: string;
  protectedNames: Set<string>;
  protectedPrefixes?: string[];
  extraProtectedName?: string;
  cutoffMs: number;
};

type CleanupSummary = {
  removed: string[];
  skipped: string[];
};

function resolveProtectedTopLevelName(rootDir: string, currentPath: string | undefined): string {
  if (!currentPath) return "";
  const relativePath = path.relative(rootDir, path.resolve(currentPath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return relativePath.split(path.sep)[0] || "";
}

function isProtectedName(name: string, input: CleanupRootInput): boolean {
  if (input.protectedNames.has(name)) return true;
  if (input.extraProtectedName && name === input.extraProtectedName) return true;
  return (input.protectedPrefixes || []).some((prefix) => name.startsWith(prefix));
}

function cleanupRoot(input: CleanupRootInput): CleanupSummary {
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!fileExists(input.rootDir)) {
    return { removed, skipped };
  }

  for (const entry of fs.readdirSync(input.rootDir, { withFileTypes: true })) {
    const entryName = String(entry.name || "").trim();
    if (!entryName) continue;
    if (isProtectedName(entryName, input)) continue;

    const entryPath = path.join(input.rootDir, entryName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch (error) {
      skipped.push(`${entryPath} (stat failed)`);
      continue;
    }
    if (stat.mtimeMs >= input.cutoffMs) continue;

    try {
      removePath(entryPath);
      removed.push(entryPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push(`${entryPath} (${message})`);
    }
  }

  return { removed, skipped };
}

export function cleanupRunnerArtifacts(repoRoot: string, currentWorkDir: string, currentDistDir: string): void {
  const cutoffMs = Date.now() - STALE_ARTIFACT_MAX_AGE_HOURS * 60 * 60 * 1000;
  const canonicalWorkRoot = path.join(repoRoot, "work");
  const canonicalDistRoot = path.join(repoRoot, "dist");

  const workSummary = cleanupRoot({
    rootDir: canonicalWorkRoot,
    protectedNames: PROTECTED_WORK_NAMES,
    protectedPrefixes: PROTECTED_WORK_PREFIXES,
    extraProtectedName: resolveProtectedTopLevelName(canonicalWorkRoot, currentWorkDir),
    cutoffMs,
  });
  const distSummary = cleanupRoot({
    rootDir: canonicalDistRoot,
    protectedNames: PROTECTED_DIST_NAMES,
    extraProtectedName: resolveProtectedTopLevelName(canonicalDistRoot, currentDistDir),
    cutoffMs,
  });

  const removedCount = workSummary.removed.length + distSummary.removed.length;
  if (removedCount > 0) {
    writeSuccess(
      `Artifact cleanup: removed=${removedCount} work=${workSummary.removed.length} dist=${distSummary.removed.length}`,
    );
  }
  for (const skipped of [...workSummary.skipped, ...distSummary.skipped]) {
    writeWarn(`Artifact cleanup skipped: ${skipped}`);
  }
}
