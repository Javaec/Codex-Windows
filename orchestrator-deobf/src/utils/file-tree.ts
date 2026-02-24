import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

async function visitDirectory(baseDirectory: string, currentDirectory: string, sink: FileEntry[]): Promise<void> {
  const nodes = await fs.readdir(currentDirectory, { withFileTypes: true });
  const orderedNodes = nodes.sort((left, right) => left.name.localeCompare(right.name));

  for (const node of orderedNodes) {
    const absolutePath = path.join(currentDirectory, node.name);
    if (node.isDirectory()) {
      await visitDirectory(baseDirectory, absolutePath, sink);
      continue;
    }
    if (!node.isFile()) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    const relativePath = path.relative(baseDirectory, absolutePath).split(path.sep).join("/");
    sink.push({
      absolutePath,
      relativePath,
      size: stat.size,
    });
  }
}

export async function listFilesRecursive(baseDirectory: string): Promise<FileEntry[]> {
  const sink: FileEntry[] = [];
  await visitDirectory(baseDirectory, baseDirectory, sink);
  return sink;
}

export function isJavascriptFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs");
}
