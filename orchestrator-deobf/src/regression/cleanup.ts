import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Entry {
  name: string;
  modifiedMs: number;
}

export async function cleanupKeepLastN(rootDirectory: string, keepLastN: number): Promise<void> {
  if (keepLastN < 1) {
    throw new Error("cleanupKeepLastN: keepLastN must be >= 1");
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
  const stale = directories.slice(keepLastN);
  for (const entry of stale) {
    await fs.rm(path.join(rootDirectory, entry.name), { recursive: true, force: true });
  }
}
