import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Entry {
  name: string;
  modifiedMs: number;
}

export async function cleanupKeepLastN(rootDirectory: string, keepLastN: number, maxAgeHours = 6): Promise<void> {
  if (keepLastN < 1) {
    throw new Error("cleanupKeepLastN: keepLastN must be >= 1");
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1) {
    throw new Error("cleanupKeepLastN: maxAgeHours must be >= 1");
  }
  const entries = await fs.readdir(rootDirectory, { withFileTypes: true }).catch(() => []);
  const directories: Entry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(rootDirectory, entry.name);
    const stats = await fs.stat(entryPath);
    directories.push({
      name: entry.name,
      modifiedMs: stats.mtimeMs,
    });
  }
  directories.sort((left, right) => right.modifiedMs - left.modifiedMs);
  const nowMs = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const staleByCount = directories.slice(keepLastN).map((entry) => entry.name);
  const staleByAge = directories
    .filter((entry) => nowMs - entry.modifiedMs > maxAgeMs)
    .map((entry) => entry.name);
  const stale = new Set<string>([...staleByCount, ...staleByAge]);
  for (const entryName of stale) {
    await fs.rm(path.join(rootDirectory, entryName), { recursive: true, force: true });
  }
}
