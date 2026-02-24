import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureCleanDirectory, ensureDirectory } from "./fs-json";

async function copyDirectoryRecursive(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await ensureDirectory(destinationDirectory);
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await fs.copyFile(sourcePath, destinationPath);
  }
}

export async function copyTreeDeterministic(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await ensureCleanDirectory(destinationDirectory);
  await copyDirectoryRecursive(sourceDirectory, destinationDirectory);
}
