import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const SERVICE_PATH_PATTERN = /^\.vite\/build\/codex-micro-service-[^/]+\.js$/;
const WORKLOUDER_MODULE = "@worklouder/device-kit-oai";
const PATCH_MARKER = "/* CODEX-WORKLOUDER-PERSISTENT-V1 */";

interface AsarDirectoryNode {
  files: Record<string, AsarNode>;
}

interface AsarFileNode {
  size?: number;
  offset?: string;
  unpacked?: boolean;
}

type AsarNode = AsarDirectoryNode | AsarFileNode;

interface PackedEntry {
  relativePath: string;
  absoluteOffset: number;
  size: number;
  bytes: Buffer;
}

interface PatchRecord {
  schemaVersion: 1;
  packageName: string;
  packageVersion: string;
  asarPath: string;
  entryPath: string;
  absoluteOffset: number;
  size: number;
  originalSha256: string;
  patchedSha256: string;
  originalBase64: string;
  createdAtIso: string;
}

export interface PersistentPatchTarget {
  name: string;
  version: string;
  asarPath: string;
}

export type PersistentPatchStatus = "not-patched" | "patched" | "modified" | "patched-without-backup";

export interface PersistentPatchInspection {
  status: PersistentPatchStatus;
  entryPath: string;
  recordPath: string;
}

function isDirectoryNode(node: AsarNode): node is AsarDirectoryNode {
  return typeof node === "object" && node !== null && "files" in node;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function backupRoot(override?: string): string {
  if (override) return path.resolve(override);
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const base = localAppData || path.join(homedir(), "AppData", "Local");
  return path.join(base, "CodexWorkLouderBypass", "patches");
}

function recordPath(target: PersistentPatchTarget, override?: string): string {
  const version = target.version.replace(/[^0-9A-Za-z._-]/g, "_");
  const pathId = createHash("sha256").update(path.resolve(target.asarPath).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(backupRoot(override), `${version}-${pathId}.json`);
}

export function isSignedAppxTarget(target: PersistentPatchTarget): boolean {
  const packageRoot = path.dirname(path.dirname(path.dirname(path.resolve(target.asarPath))));
  const hasBlockMap = fs.existsSync(path.join(packageRoot, "AppxBlockMap.xml"));
  const hasSignature = fs.existsSync(path.join(packageRoot, "AppxSignature.p7x"));
  return hasBlockMap && hasSignature;
}

function assertTargetIsNotSignedAppx(target: PersistentPatchTarget): void {
  if (isSignedAppxTarget(target)) {
    throw new Error(
      "Refusing to modify app.asar inside a signed AppX package; use the non-persistent inspector launcher.",
    );
  }
}

function readAsarHeader(asarPath: string): { fd: number; payloadBaseOffset: number; header: AsarDirectoryNode } {
  const fd = fs.openSync(asarPath, "r");
  try {
    const fixedHeader = Buffer.allocUnsafe(16);
    if (fs.readSync(fd, fixedHeader, 0, fixedHeader.length, 0) !== fixedHeader.length) {
      throw new Error("Failed to read ASAR fixed header.");
    }
    const headerObjectSize = fixedHeader.readUInt32LE(4);
    const headerJsonSize = fixedHeader.readUInt32LE(12);
    if (headerObjectSize < 8 || headerJsonSize < 2 || headerJsonSize > 32 * 1024 * 1024) {
      throw new Error("Invalid ASAR header sizes.");
    }
    const headerBytes = Buffer.allocUnsafe(headerJsonSize);
    if (fs.readSync(fd, headerBytes, 0, headerJsonSize, 16) !== headerJsonSize) {
      throw new Error("Failed to read ASAR JSON header.");
    }
    const header = JSON.parse(headerBytes.toString("utf8")) as AsarDirectoryNode;
    if (!isDirectoryNode(header)) throw new Error("Invalid ASAR header shape.");
    return { fd, payloadBaseOffset: 8 + headerObjectSize, header };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function collectServiceNodes(
  node: AsarDirectoryNode,
  output: Array<{ relativePath: string; node: AsarFileNode }>,
  currentPath = "",
): void {
  for (const [name, child] of Object.entries(node.files)) {
    const relativePath = currentPath ? `${currentPath}/${name}` : name;
    if (isDirectoryNode(child)) {
      collectServiceNodes(child, output, relativePath);
      continue;
    }
    if (SERVICE_PATH_PATTERN.test(relativePath)) output.push({ relativePath, node: child });
  }
}

function readPackedEntry(fd: number, payloadBaseOffset: number, relativePath: string, node: AsarFileNode): PackedEntry {
  if (node.unpacked || typeof node.offset !== "string") {
    throw new Error(`Persistent patch target is not packed: ${relativePath}`);
  }
  const relativeOffset = Number.parseInt(node.offset, 10);
  const size = Number(node.size ?? -1);
  if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`Invalid ASAR entry metadata: ${relativePath}`);
  }
  const absoluteOffset = payloadBaseOffset + relativeOffset;
  const bytes = Buffer.allocUnsafe(size);
  if (fs.readSync(fd, bytes, 0, size, absoluteOffset) !== size) {
    throw new Error(`Failed to read ASAR entry: ${relativePath}`);
  }
  return { relativePath, absoluteOffset, size, bytes };
}

function locateServiceEntry(asarPath: string): PackedEntry {
  const asar = readAsarHeader(asarPath);
  try {
    const nodes: Array<{ relativePath: string; node: AsarFileNode }> = [];
    collectServiceNodes(asar.header, nodes);
    const entries = nodes.map(({ relativePath, node }) =>
      readPackedEntry(asar.fd, asar.payloadBaseOffset, relativePath, node),
    );
    const compatible = entries.filter((entry) => {
      const source = entry.bytes.toString("utf8");
      return source.includes(WORKLOUDER_MODULE) || source.includes(PATCH_MARKER);
    });
    if (compatible.length !== 1) {
      throw new Error(`Expected one compatible Codex Micro service, found ${compatible.length}.`);
    }
    return compatible[0];
  } finally {
    fs.closeSync(asar.fd);
  }
}

export function buildPersistentServiceStub(size: number): Buffer {
  const source = `"use strict";${PATCH_MARKER}class CodexMicroService{constructor(options){this.options=options;this.state={status:"not-detected",error:null,battery:null}}getState(){return this.state}start(){}async updateLighting(){return false}async stop(){}dispose(){return this.stop()}}exports.CodexMicroService=CodexMicroService;\n`;
  const sourceBytes = Buffer.from(source, "utf8");
  if (sourceBytes.length > size) {
    throw new Error(`Codex Micro service entry is too small for persistent stub (${size} bytes).`);
  }
  const output = Buffer.alloc(size, 0x20);
  sourceBytes.copy(output);
  return output;
}

function readRecord(filePath: string): PatchRecord | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as PatchRecord;
    if (record.schemaVersion !== 1 || !record.originalBase64 || !record.originalSha256 || !record.patchedSha256) {
      throw new Error("invalid shape");
    }
    return record;
  } catch {
    throw new Error(`Persistent patch backup is invalid: ${filePath}`);
  }
}

function writeRecord(filePath: string, record: PatchRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.rmSync(filePath, { force: true });
  fs.renameSync(temporaryPath, filePath);
}

function writeEntry(asarPath: string, entry: PackedEntry, bytes: Buffer): void {
  if (bytes.length !== entry.size) throw new Error("Persistent patch must preserve ASAR entry size.");
  let fd: number | null = null;
  try {
    fd = fs.openSync(asarPath, "r+");
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written, entry.absoluteOffset + written);
      if (count <= 0) throw new Error("Failed to write persistent ASAR patch.");
      written += count;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EACCES" || code === "EPERM") {
      throw new Error("Persistent patch requires elevated write access to the installed AppX package.");
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function verifyEntry(asarPath: string, expectedSha256: string): void {
  const entry = locateServiceEntry(asarPath);
  if (sha256(entry.bytes) !== expectedSha256) {
    throw new Error("Persistent ASAR patch verification failed.");
  }
}

export function inspectPersistentPatch(
  target: PersistentPatchTarget,
  backupOverride?: string,
): PersistentPatchInspection {
  const entry = locateServiceEntry(target.asarPath);
  const filePath = recordPath(target, backupOverride);
  const record = readRecord(filePath);
  const currentHash = sha256(entry.bytes);
  if (!record) {
    return {
      status: entry.bytes.toString("utf8").includes(PATCH_MARKER) ? "patched-without-backup" : "not-patched",
      entryPath: entry.relativePath,
      recordPath: filePath,
    };
  }
  const status: PersistentPatchStatus =
    currentHash === record.patchedSha256
      ? "patched"
      : currentHash === record.originalSha256
        ? "not-patched"
        : "modified";
  return { status, entryPath: entry.relativePath, recordPath: filePath };
}

export function installPersistentPatch(target: PersistentPatchTarget, backupOverride?: string): PersistentPatchInspection {
  assertTargetIsNotSignedAppx(target);
  const entry = locateServiceEntry(target.asarPath);
  const filePath = recordPath(target, backupOverride);
  const existingRecord = readRecord(filePath);
  const currentHash = sha256(entry.bytes);
  if (existingRecord && currentHash === existingRecord.patchedSha256) {
    return { status: "patched", entryPath: entry.relativePath, recordPath: filePath };
  }
  if (entry.bytes.toString("utf8").includes(PATCH_MARKER) && !existingRecord) {
    throw new Error("Persistent patch is present but its restore backup is missing.");
  }
  if (existingRecord && currentHash !== existingRecord.originalSha256) {
    throw new Error("Codex Micro service changed since the persistent patch backup was created.");
  }
  const originalBytes = existingRecord ? Buffer.from(existingRecord.originalBase64, "base64") : entry.bytes;
  const patchedBytes = buildPersistentServiceStub(entry.size);
  const record: PatchRecord = existingRecord
    ? { ...existingRecord, patchedSha256: sha256(patchedBytes) }
    : {
        schemaVersion: 1,
        packageName: target.name,
        packageVersion: target.version,
        asarPath: path.resolve(target.asarPath),
        entryPath: entry.relativePath,
        absoluteOffset: entry.absoluteOffset,
        size: entry.size,
        originalSha256: sha256(originalBytes),
        patchedSha256: sha256(patchedBytes),
        originalBase64: originalBytes.toString("base64"),
        createdAtIso: new Date().toISOString(),
      };
  writeRecord(filePath, record);
  try {
    writeEntry(target.asarPath, entry, patchedBytes);
    verifyEntry(target.asarPath, record.patchedSha256);
  } catch (error) {
    try {
      writeEntry(target.asarPath, entry, originalBytes);
    } catch {
      // Preserve the original failure; the backup record still permits an explicit restore.
    }
    throw error;
  }
  return { status: "patched", entryPath: entry.relativePath, recordPath: filePath };
}

export function restorePersistentPatch(target: PersistentPatchTarget, backupOverride?: string): PersistentPatchInspection {
  const entry = locateServiceEntry(target.asarPath);
  const filePath = recordPath(target, backupOverride);
  const record = readRecord(filePath);
  if (!record) {
    if (entry.bytes.toString("utf8").includes(PATCH_MARKER)) {
      throw new Error("Persistent patch backup is missing; automatic restore is unavailable.");
    }
    return { status: "not-patched", entryPath: entry.relativePath, recordPath: filePath };
  }
  const currentHash = sha256(entry.bytes);
  if (currentHash === record.originalSha256) {
    return { status: "not-patched", entryPath: entry.relativePath, recordPath: filePath };
  }
  if (currentHash !== record.patchedSha256) {
    throw new Error("Codex Micro service changed after patching; refusing to overwrite it.");
  }
  const originalBytes = Buffer.from(record.originalBase64, "base64");
  if (originalBytes.length !== entry.size || sha256(originalBytes) !== record.originalSha256) {
    throw new Error("Persistent patch backup content is invalid.");
  }
  writeEntry(target.asarPath, entry, originalBytes);
  verifyEntry(target.asarPath, record.originalSha256);
  return { status: "not-patched", entryPath: entry.relativePath, recordPath: filePath };
}
