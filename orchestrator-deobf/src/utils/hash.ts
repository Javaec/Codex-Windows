import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

export interface FileDigest {
  sha256: string;
  bytes: number;
}

export async function hashFileSha256(filePath: string): Promise<FileDigest> {
  const content = await fs.readFile(filePath);
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    sha256: digest,
    bytes: content.byteLength,
  };
}
