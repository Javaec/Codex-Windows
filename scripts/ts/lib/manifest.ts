import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists } from "./exec";

export interface FileDescriptor {
  path: string;
  size: number;
  lastWriteUtc: string;
  sha256: string;
}

export interface ManifestStep {
  status: string;
  signature: string;
  atUtc: string;
  meta: Record<string, unknown>;
}

export interface StateManifest {
  schemaVersion: number;
  updatedAtUtc: string;
  dmg: FileDescriptor | null;
  steps: {
    extract: ManifestStep | null;
    native: ManifestStep | null;
  };
}

export function newEmptyStateManifest(): StateManifest {
  return {
    schemaVersion: 1,
    updatedAtUtc: new Date().toISOString(),
    dmg: null,
    steps: { extract: null, native: null },
  };
}

export function readStateManifest(manifestPath: string): StateManifest {
  if (!fileExists(manifestPath)) return newEmptyStateManifest();
  try {
    const raw = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<StateManifest>;
    const manifest = newEmptyStateManifest();
    if (parsed.schemaVersion) manifest.schemaVersion = parsed.schemaVersion;
    if (parsed.updatedAtUtc) manifest.updatedAtUtc = parsed.updatedAtUtc;
    if (parsed.dmg) manifest.dmg = parsed.dmg;
    if (parsed.steps?.extract) manifest.steps.extract = parsed.steps.extract;
    if (parsed.steps?.native) manifest.steps.native = parsed.steps.native;
    return manifest;
  } catch {
    return newEmptyStateManifest();
  }
}

export function writeStateManifest(manifestPath: string, manifest: StateManifest): void {
  manifest.updatedAtUtc = new Date().toISOString();
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function getFileSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function getFileDescriptorWithCache(filePath: string, previous?: FileDescriptor | null): FileDescriptor {
  if (!fileExists(filePath)) throw new Error(`File not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const lastWriteUtc = new Date(stat.mtimeMs).toISOString();

  const sha256 =
    previous &&
    previous.size === size &&
    previous.lastWriteUtc === lastWriteUtc &&
    typeof previous.sha256 === "string" &&
    previous.sha256
      ? previous.sha256
      : getFileSha256(filePath);

  return {
    path: path.resolve(filePath),
    size,
    lastWriteUtc,
    sha256,
  };
}

export function getStepSignature(fields: Record<string, string>): string {
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("|");
}

export function testManifestStepCurrent(
  manifest: StateManifest,
  stepName: "extract" | "native",
  signature: string,
): boolean {
  const step = manifest.steps[stepName];
  return Boolean(step && step.signature === signature);
}

export function setManifestStepState(
  manifest: StateManifest,
  stepName: "extract" | "native",
  signature: string,
  status: string,
  meta: Record<string, unknown>,
): void {
  manifest.steps[stepName] = {
    status,
    signature,
    atUtc: new Date().toISOString(),
    meta,
  };
}
