import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compactNamingMemoryFile, MAX_NAMING_MEMORY_FILE_BYTES } from "../naming/compact";

interface CliOptions {
  includeRuns: boolean;
}

interface FileBudgetEntry {
  filePath: string;
  bytes: number;
}

interface NamingCompactionEntry {
  filePath: string;
  beforeBytes: number;
  afterBytes: number;
  changed: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  let includeRuns = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--include-runs") {
      includeRuns = true;
      continue;
    }
    throw new Error(`size-budget: unknown argument ${token}`);
  }
  return { includeRuns };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesByPredicate(
  directoryPath: string,
  includeFile: (fileName: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && includeFile(entry.name))
      .map((entry) => path.join(directoryPath, entry.name));
    files.sort((left, right) => left.localeCompare(right));
    return files;
  } catch {
    return [];
  }
}

async function listRunNamingSnapshots(runsDirectory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runsDirectory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidatePath = path.join(runsDirectory, entry.name, "naming-memory.snapshot.json");
      if (await fileExists(candidatePath)) {
        files.push(candidatePath);
      }
    }
    files.sort((left, right) => left.localeCompare(right));
    return files;
  } catch {
    return [];
  }
}

async function pruneLegacyBaselineJsonFiles(baselineDirectory: string): Promise<string[]> {
  const legacyFiles = await listFilesByPredicate(baselineDirectory, (fileName) => fileName.endsWith(".json"));
  for (const filePath of legacyFiles) {
    await fs.unlink(filePath);
  }
  return legacyFiles;
}

async function compactNamingTargets(targets: readonly string[]): Promise<NamingCompactionEntry[]> {
  const results: NamingCompactionEntry[] = [];
  for (const target of targets) {
    if (!(await fileExists(target))) {
      continue;
    }
    const result = await compactNamingMemoryFile(target);
    results.push({
      filePath: result.filePath,
      beforeBytes: result.beforeBytes,
      afterBytes: result.afterBytes,
      changed: result.changed,
    });
  }
  return results;
}

async function collectBudgetTargets(
  projectRoot: string,
  includeRuns: boolean,
): Promise<{ namingTargets: string[]; budgetTargets: string[] }> {
  const namingTargets: string[] = [];
  const budgetTargets: string[] = [];

  const rootNamingMemoryPath = path.join(projectRoot, "naming-memory.json");
  if (await fileExists(rootNamingMemoryPath)) {
    namingTargets.push(rootNamingMemoryPath);
    budgetTargets.push(rootNamingMemoryPath);
  }

  const snapshotsDirectory = path.join(projectRoot, "naming-memory-store", "snapshots");
  const snapshotFiles = await listFilesByPredicate(
    snapshotsDirectory,
    (fileName) => fileName.startsWith("snapshot-") && fileName.endsWith(".json"),
  );
  namingTargets.push(...snapshotFiles);
  budgetTargets.push(...snapshotFiles);

  const baselinesDirectory = path.join(projectRoot, "migration", "version-bridge", "baselines");
  const baselineArchives = await listFilesByPredicate(
    baselinesDirectory,
    (fileName) => fileName.endsWith(".json.gz"),
  );
  budgetTargets.push(...baselineArchives);

  if (includeRuns) {
    const runSnapshots = await listRunNamingSnapshots(path.join(projectRoot, "runs"));
    namingTargets.push(...runSnapshots);
    budgetTargets.push(...runSnapshots);
  }

  return {
    namingTargets: [...new Set(namingTargets)],
    budgetTargets: [...new Set(budgetTargets)],
  };
}

async function checkBudget(targets: readonly string[]): Promise<FileBudgetEntry[]> {
  const oversized: FileBudgetEntry[] = [];
  for (const filePath of targets) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_NAMING_MEMORY_FILE_BYTES) {
      oversized.push({ filePath, bytes: stat.size });
    }
  }
  oversized.sort((left, right) => right.bytes - left.bytes);
  return oversized;
}

async function run(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, "..", "..");
  const baselinesDirectory = path.join(projectRoot, "migration", "version-bridge", "baselines");
  const removedLegacyBaselineFiles = await pruneLegacyBaselineJsonFiles(baselinesDirectory);

  const { namingTargets, budgetTargets } = await collectBudgetTargets(projectRoot, cli.includeRuns);
  const compaction = await compactNamingTargets(namingTargets);
  const oversized = await checkBudget(budgetTargets);
  if (oversized.length > 0) {
    const detail = oversized.map((entry) => `${entry.filePath} (${entry.bytes} bytes)`).join("; ");
    throw new Error(`size-budget: generated artifacts exceed 100MB: ${detail}`);
  }

  const summary = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    includeRuns: cli.includeRuns,
    maxAllowedBytes: MAX_NAMING_MEMORY_FILE_BYTES,
    namingTargetCount: namingTargets.length,
    budgetTargetCount: budgetTargets.length,
    compaction,
    removedLegacyBaselineFiles,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
