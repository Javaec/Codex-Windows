import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compactNamingMemoryFile, MAX_NAMING_MEMORY_FILE_BYTES } from "./compact";

interface CliOptions {
  projectRoot: string;
  includeRuns: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  let includeRuns = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--include-runs") {
      includeRuns = true;
      continue;
    }
    throw new Error(`compact-naming-memory: unknown argument ${token}`);
  }
  return {
    projectRoot: path.resolve(__dirname, "..", ".."),
    includeRuns,
  };
}

async function collectTargets(projectRoot: string, includeRuns: boolean): Promise<string[]> {
  const targets: string[] = [];
  const rootNamingMemoryPath = path.join(projectRoot, "naming-memory.json");
  try {
    await fs.access(rootNamingMemoryPath);
    targets.push(rootNamingMemoryPath);
  } catch {
    // intentionally empty
  }

  const snapshotsDirectory = path.join(projectRoot, "naming-memory-store", "snapshots");
  try {
    const entries = await fs.readdir(snapshotsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("snapshot-") || !entry.name.endsWith(".json")) continue;
      targets.push(path.join(snapshotsDirectory, entry.name));
    }
  } catch {
    // intentionally empty
  }

  if (includeRuns) {
    const runsDirectory = path.join(projectRoot, "runs");
    try {
      const runEntries = await fs.readdir(runsDirectory, { withFileTypes: true });
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        const snapshotPath = path.join(runsDirectory, runEntry.name, "naming-memory.snapshot.json");
        try {
          await fs.access(snapshotPath);
          targets.push(snapshotPath);
        } catch {
          // intentionally empty
        }
      }
    } catch {
      // intentionally empty
    }
  }

  return [...new Set(targets)].sort((left, right) => left.localeCompare(right));
}

async function run(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const targets = await collectTargets(cli.projectRoot, cli.includeRuns);
  const results = [];
  for (const target of targets) {
    results.push(await compactNamingMemoryFile(target));
  }

  const oversized = results.filter((result) => result.afterBytes > MAX_NAMING_MEMORY_FILE_BYTES);
  if (oversized.length > 0) {
    const detail = oversized.map((result) => `${result.filePath} (${result.afterBytes})`).join("; ");
    throw new Error(`compact-naming-memory: files still exceed 100MB after compaction: ${detail}`);
  }

  const summary = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    targetCount: results.length,
    totalBeforeBytes: results.reduce((sum, result) => sum + result.beforeBytes, 0),
    totalAfterBytes: results.reduce((sum, result) => sum + result.afterBytes, 0),
    reducedBytes: results.reduce((sum, result) => sum + (result.beforeBytes - result.afterBytes), 0),
    results,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
