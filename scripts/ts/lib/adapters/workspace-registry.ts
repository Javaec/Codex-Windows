import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists } from "../exec";

export interface WorkspaceSanitizerResult {
  scannedFiles: number;
  updatedFiles: number;
  removedEntries: number;
  reportPath: string;
}

interface SanitizedNodeResult {
  value: unknown;
  removedEntries: number;
}

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_DEPTH = 3;
const PATH_KEY_HINT = /(workspace|worktree|cwd|repo|root|folder|directory|project|recent|path)s?/i;
const CANDIDATE_NAME = /(workspace|worktree|recent|registry|preference|local state|config|project|repo).*\.(json|jsn)$/i;

const SKIP_DIRS = new Set<string>([
  "cache",
  "code cache",
  "gpucache",
  "dawngraphitecache",
  "indexeddb",
  "blob_storage",
  "session storage",
  "local storage",
  "shared dictionary",
  "crashpad",
  "sentry",
]);

function isPathLike(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^\\\\[^\\]/.test(value)) return true;
  if (/^file:\/\//i.test(value)) return true;
  return false;
}

function normalizeCandidatePath(raw: string): string {
  let value = raw.trim().replace(/^"+|"+$/g, "");
  if (/^file:\/\//i.test(value)) {
    try {
      const urlValue = new URL(value);
      value = decodeURIComponent(urlValue.pathname || value);
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    } catch {
      return "";
    }
  }

  value = value.replace(/%([^%]+)%/g, (all, name: string) => {
    const envValue = process.env[name];
    return envValue ? envValue : all;
  });

  if (value.includes("%")) return "";
  return path.normalize(value);
}

function isPathKey(keyHint: string): boolean {
  return PATH_KEY_HINT.test(keyHint);
}

function collectCandidateFiles(rootDir: string): string[] {
  if (!fileExists(rootDir)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      const lowerName = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH) continue;
        if (SKIP_DIRS.has(lowerName)) continue;
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      const explicitCandidate = lowerName === "preferences" || lowerName === "local state";
      const jsonCandidate = CANDIDATE_NAME.test(lowerName);
      if (!explicitCandidate && !jsonCandidate) continue;

      const key = path.resolve(fullPath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fullPath);
    }
  }

  return out;
}

function sanitizeNode(value: unknown, keyHint: string): SanitizedNodeResult {
  if (typeof value === "string") {
    if (!isPathKey(keyHint) || !isPathLike(value)) {
      return { value, removedEntries: 0 };
    }

    const normalized = normalizeCandidatePath(value);
    if (!normalized || !fileExists(normalized)) {
      return { value: undefined, removedEntries: 1 };
    }
    return { value: normalized, removedEntries: 0 };
  }

  if (Array.isArray(value)) {
    const values = value;
    const pathLikeCount = values.filter((item) => typeof item === "string" && isPathLike(item)).length;
    const treatAsPathArray = isPathKey(keyHint) || pathLikeCount >= Math.max(1, Math.floor(values.length / 2));

    const next: unknown[] = [];
    const seen = new Set<string>();
    let removedEntries = 0;

    for (const item of values) {
      if (treatAsPathArray && typeof item === "string" && isPathLike(item)) {
        const normalized = normalizeCandidatePath(item);
        if (!normalized || !fileExists(normalized)) {
          removedEntries += 1;
          continue;
        }
        const dedupeKey = normalized.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        next.push(normalized);
        continue;
      }

      const child = sanitizeNode(item, keyHint);
      removedEntries += child.removedEntries;
      if (typeof child.value === "undefined") continue;
      next.push(child.value);
    }

    return { value: next, removedEntries };
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    let removedEntries = 0;

    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      const child = sanitizeNode(childValue, key);
      removedEntries += child.removedEntries;
      if (typeof child.value === "undefined") continue;
      next[key] = child.value;
    }

    return { value: next, removedEntries };
  }

  return { value, removedEntries: 0 };
}

function sanitizeJsonFile(filePath: string): { changed: boolean; removedEntries: number } {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return { changed: false, removedEntries: 0 };
  }

  if (!raw.trim()) return { changed: false, removedEntries: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { changed: false, removedEntries: 0 };
  }

  const result = sanitizeNode(parsed, "root");
  const nextRaw = `${JSON.stringify(result.value, null, 2)}\n`;
  const changed = nextRaw !== raw;
  if (changed) {
    fs.writeFileSync(filePath, nextRaw, "utf8");
  }

  return { changed, removedEntries: result.removedEntries };
}

export function sanitizeWorkspaceRegistry(userDataDir: string, diagnosticsDir: string): WorkspaceSanitizerResult {
  const reportDir = ensureDir(diagnosticsDir);
  const reportPath = path.join(reportDir, "workspace-sanitizer-report.json");

  if (!fileExists(userDataDir)) {
    const emptyResult: WorkspaceSanitizerResult = {
      scannedFiles: 0,
      updatedFiles: 0,
      removedEntries: 0,
      reportPath,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...emptyResult, atUtc: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return emptyResult;
  }

  const candidateFiles = collectCandidateFiles(userDataDir);
  let scannedFiles = 0;
  let updatedFiles = 0;
  let removedEntries = 0;

  for (const filePath of candidateFiles) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    scannedFiles += 1;
    const sanitizeResult = sanitizeJsonFile(filePath);
    if (sanitizeResult.changed) updatedFiles += 1;
    removedEntries += sanitizeResult.removedEntries;
  }

  const result: WorkspaceSanitizerResult = { scannedFiles, updatedFiles, removedEntries, reportPath };
  const report = {
    atUtc: new Date().toISOString(),
    userDataDir: path.resolve(userDataDir),
    ...result,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return result;
}

