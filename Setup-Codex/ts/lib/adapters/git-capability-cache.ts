import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists } from "../exec";

export interface GitCapabilityCacheEntry {
  firstSeenUtc: string;
  lastSeenUtc: string;
  expiresUtc: string;
  failCount: number;
}

export interface GitCapabilityCacheDocument {
  schemaVersion: number;
  updatedAtUtc: string;
  missingRefs: Record<string, GitCapabilityCacheEntry>;
  invalidCwds: Record<string, GitCapabilityCacheEntry>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newEntry(ttlHours: number): GitCapabilityCacheEntry {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  return {
    firstSeenUtc: now.toISOString(),
    lastSeenUtc: now.toISOString(),
    expiresUtc: expires.toISOString(),
    failCount: 1,
  };
}

function emptyCache(): GitCapabilityCacheDocument {
  return {
    schemaVersion: 1,
    updatedAtUtc: nowIso(),
    missingRefs: {},
    invalidCwds: {},
  };
}

function pruneExpired(map: Record<string, GitCapabilityCacheEntry>, now: Date): Record<string, GitCapabilityCacheEntry> {
  const out: Record<string, GitCapabilityCacheEntry> = {};
  for (const [key, value] of Object.entries(map)) {
    const expires = new Date(value.expiresUtc).getTime();
    if (!Number.isFinite(expires) || expires <= now.getTime()) continue;
    out[key] = value;
  }
  return out;
}

function capEntries(
  map: Record<string, GitCapabilityCacheEntry>,
  maxEntries: number,
): Record<string, GitCapabilityCacheEntry> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return map;
  entries.sort((a, b) => {
    const aTime = new Date(a[1].lastSeenUtc).getTime();
    const bTime = new Date(b[1].lastSeenUtc).getTime();
    return bTime - aTime;
  });
  return Object.fromEntries(entries.slice(0, maxEntries));
}

function readCache(cachePath: string): GitCapabilityCacheDocument {
  if (!fileExists(cachePath)) return emptyCache();
  try {
    const raw = fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<GitCapabilityCacheDocument>;
    return {
      schemaVersion: parsed.schemaVersion || 1,
      updatedAtUtc: parsed.updatedAtUtc || nowIso(),
      missingRefs: parsed.missingRefs || {},
      invalidCwds: parsed.invalidCwds || {},
    };
  } catch {
    return emptyCache();
  }
}

function writeCache(cachePath: string, cache: GitCapabilityCacheDocument): void {
  cache.updatedAtUtc = nowIso();
  ensureDir(path.dirname(cachePath));
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

export function ensureGitCapabilityCachePath(workDir: string, profileName: string): string {
  const diagnosticsDir = ensureDir(path.join(workDir, "diagnostics", profileName));
  const cachePath = path.join(diagnosticsDir, "git-capability-cache.json");
  const now = new Date();
  const cache = readCache(cachePath);
  cache.missingRefs = capEntries(pruneExpired(cache.missingRefs, now), 2000);
  cache.invalidCwds = capEntries(pruneExpired(cache.invalidCwds, now), 1000);
  writeCache(cachePath, cache);
  return cachePath;
}

export function rememberGitMissingRef(
  cachePath: string,
  cwd: string,
  ref: string,
  ttlHours = 6,
): void {
  const key = `${path.resolve(cwd).toLowerCase()}|${ref.trim().toLowerCase()}`;
  if (!key) return;
  const cache = readCache(cachePath);
  const existing = cache.missingRefs[key];
  if (existing) {
    const updated = newEntry(ttlHours);
    updated.firstSeenUtc = existing.firstSeenUtc;
    updated.failCount = existing.failCount + 1;
    cache.missingRefs[key] = updated;
  } else {
    cache.missingRefs[key] = newEntry(ttlHours);
  }
  writeCache(cachePath, cache);
}

export function rememberGitInvalidCwd(cachePath: string, cwd: string, ttlHours = 12): void {
  const key = path.resolve(cwd).toLowerCase();
  if (!key) return;
  const cache = readCache(cachePath);
  const existing = cache.invalidCwds[key];
  if (existing) {
    const updated = newEntry(ttlHours);
    updated.firstSeenUtc = existing.firstSeenUtc;
    updated.failCount = existing.failCount + 1;
    cache.invalidCwds[key] = updated;
  } else {
    cache.invalidCwds[key] = newEntry(ttlHours);
  }
  writeCache(cachePath, cache);
}

