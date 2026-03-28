import * as fs from "node:fs";
import * as path from "node:path";
import { copyFileSafe, ensureDir, fileExists, writeWarn } from "./exec";

interface AsarDirectoryNode {
  files: Record<string, AsarNode>;
}

interface AsarFileNode {
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
}

type AsarNode = AsarDirectoryNode | AsarFileNode;

function isDirectoryNode(node: AsarNode): node is AsarDirectoryNode {
  return typeof node === "object" && node !== null && "files" in node;
}

function isFileNode(node: AsarNode): node is AsarFileNode {
  return (
    typeof node === "object" &&
    node !== null &&
    !("files" in node) &&
    ("offset" in node || "unpacked" in node || "link" in node)
  );
}

function sanitizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const safeParts: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(`Unsafe path segment in ASAR entry: ${relativePath}`);
    }
    safeParts.push(part);
  }
  return safeParts.join(path.sep);
}

function copyByteRange(fd: number, sourceStart: number, destinationPath: string, totalBytes: number): void {
  ensureDir(path.dirname(destinationPath));
  const out = fs.openSync(destinationPath, "w");
  try {
    const chunkSize = 1024 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let remaining = totalBytes;
    let offset = sourceStart;
    while (remaining > 0) {
      const readLength = Math.min(chunkSize, remaining);
      const bytesRead = fs.readSync(fd, buffer, 0, readLength, offset);
      if (bytesRead <= 0) {
        throw new Error(`Unexpected EOF while reading ASAR payload at offset ${offset}.`);
      }
      fs.writeSync(out, buffer, 0, bytesRead);
      remaining -= bytesRead;
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(out);
  }
}

function traverseAsarTree(
  rootNode: AsarDirectoryNode,
  visit: (relativePath: string, fileNode: AsarFileNode) => void,
  current = "",
): void {
  for (const [name, node] of Object.entries(rootNode.files)) {
    const relativePath = current ? `${current}/${name}` : name;
    if (isDirectoryNode(node)) {
      traverseAsarTree(node, visit, relativePath);
      continue;
    }
    if (isFileNode(node)) {
      visit(relativePath, node);
      continue;
    }
    throw new Error(`Unsupported ASAR node at ${relativePath}`);
  }
}

export function extractAsarArchive(asarPath: string, outputDir: string): void {
  if (!fileExists(asarPath)) throw new Error(`ASAR file not found: ${asarPath}`);
  ensureDir(outputDir);

  const fd = fs.openSync(asarPath, "r");
  try {
    const fixedHeader = Buffer.allocUnsafe(16);
    const fixedRead = fs.readSync(fd, fixedHeader, 0, 16, 0);
    if (fixedRead !== 16) throw new Error("Failed to read ASAR fixed header.");

    const headerObjectSize = fixedHeader.readUInt32LE(4);
    const headerJsonSize = fixedHeader.readUInt32LE(12);
    const payloadBaseOffset = 8 + headerObjectSize;
    const headerBuffer = Buffer.allocUnsafe(headerJsonSize);
    const headerRead = fs.readSync(fd, headerBuffer, 0, headerJsonSize, 16);
    if (headerRead !== headerJsonSize) throw new Error("Failed to read ASAR JSON header.");

    const header = JSON.parse(headerBuffer.toString("utf8")) as AsarDirectoryNode;
    if (!isDirectoryNode(header)) throw new Error("Invalid ASAR header shape.");

    const unpackedRoot = `${asarPath}.unpacked`;
    traverseAsarTree(header, (relativePath, fileNode) => {
      if (fileNode.link) {
        writeWarn(`Skipping ASAR link entry: ${relativePath} -> ${fileNode.link}`);
        return;
      }
      const safeRelative = sanitizeRelativePath(relativePath);
      const destination = path.join(outputDir, safeRelative);
      if (fileNode.unpacked) {
        const unpackedSource = path.join(unpackedRoot, safeRelative);
        if (!fileExists(unpackedSource)) {
          throw new Error(`ASAR unpacked source missing: ${unpackedSource}`);
        }
        copyFileSafe(unpackedSource, destination);
        return;
      }

      if (typeof fileNode.offset !== "string") {
        throw new Error(`Missing ASAR offset for packed file: ${relativePath}`);
      }
      const relativeOffset = Number.parseInt(fileNode.offset, 10);
      if (!Number.isFinite(relativeOffset) || relativeOffset < 0) {
        throw new Error(`Invalid ASAR offset for ${relativePath}: ${fileNode.offset}`);
      }
      const size = Number(fileNode.size ?? 0);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`Invalid ASAR size for ${relativePath}: ${fileNode.size}`);
      }

      copyByteRange(fd, payloadBaseOffset + relativeOffset, destination, size);
    });
  } finally {
    fs.closeSync(fd);
  }
}
