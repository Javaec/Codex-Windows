import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDirectory } from "../utils/fs-json";

export type NamingMemorySeedSource = "existing" | "legacy" | "latest-snapshot" | "empty";

export interface NamingMemoryProfileResolution {
  profilePath: string;
  legacyPath: string;
  seededFrom: NamingMemorySeedSource;
  seededFromSnapshotKey: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

export async function resolveNamingMemoryProfilePath(
  projectRoot: string,
  snapshotKey: string,
): Promise<NamingMemoryProfileResolution> {
  const legacyPath = path.join(projectRoot, "naming-memory.json");
  const profilesDirectory = path.join(projectRoot, "naming-memory-store", "snapshots");
  await ensureDirectory(profilesDirectory);
  const profilePath = path.join(profilesDirectory, `snapshot-${snapshotKey}.json`);
  const hasProfile = await fileExists(profilePath);
  let seededFrom: NamingMemorySeedSource = hasProfile ? "existing" : "empty";
  let seededFromSnapshotKey = snapshotKey;

  if (!hasProfile) {
    const hasLegacy = await fileExists(legacyPath);
    if (hasLegacy) {
      await fs.copyFile(legacyPath, profilePath);
      seededFrom = "legacy";
    } else {
      const entries = await fs.readdir(profilesDirectory, { withFileTypes: true });
      const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.startsWith("snapshot-") || !entry.name.endsWith(".json")) {
          continue;
        }
        const candidatePath = path.join(profilesDirectory, entry.name);
        if (candidatePath === profilePath) {
          continue;
        }
        const stat = await fs.stat(candidatePath);
        candidates.push({
          filePath: candidatePath,
          mtimeMs: stat.mtimeMs,
        });
      }
      candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const latestSnapshotProfile = candidates[0];
      if (latestSnapshotProfile) {
        await fs.copyFile(latestSnapshotProfile.filePath, profilePath);
        seededFrom = "latest-snapshot";
        const baseName = path.basename(latestSnapshotProfile.filePath, ".json");
        const seededKey = baseName.replace(/^snapshot-/, "");
        if (seededKey.length > 0) {
          seededFromSnapshotKey = seededKey;
        }
      }
    }
  }

  return {
    profilePath,
    legacyPath,
    seededFrom,
    seededFromSnapshotKey,
  };
}

