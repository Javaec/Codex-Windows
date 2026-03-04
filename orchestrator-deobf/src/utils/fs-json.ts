import * as fs from "node:fs/promises";
import * as path from "node:path";

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableClone(item));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const next: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      next[key] = stableClone(nested);
    }
    return next;
  }
  return value;
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function removeDirectoryWithRetry(directoryPath: string): Promise<void> {
  const retryableErrorCodes = new Set<string>(["EBUSY", "EPERM", "ENOTEMPTY"]);
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? ((error as { code: string }).code ?? "")
          : "";
      if (!retryableErrorCodes.has(errorCode) || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = attempt * 120;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

export async function ensureCleanDirectory(directoryPath: string): Promise<void> {
  await removeDirectoryWithRetry(directoryPath);
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  const stableValue = stableClone(value);
  const payload = `${JSON.stringify(stableValue, null, 2)}\n`;
  await fs.writeFile(filePath, payload, "utf8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const payload = await fs.readFile(filePath, "utf8");
  return JSON.parse(payload) as T;
}
