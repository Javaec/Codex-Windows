import * as fs from "node:fs/promises";
import * as path from "node:path";

interface CliOptions {
  sourceProjectPath: string;
  targetProjectPath: string;
  force: boolean;
}

interface ManualBootstrapManifest {
  generatedAtIso: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  transitionMode: "manual-first";
  reverseSyncPolicy: "shared/manual-sync/* only";
  structureContractPath: string;
  notes: string[];
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let sourceProjectPath = path.join(projectRoot, "output", "regression-latest", "project");
  let targetProjectPath = path.join(path.dirname(projectRoot), "manual-codex-app");
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--source": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--source requires a value");
        }
        sourceProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--target": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--target requires a value");
        }
        targetProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--force": {
        force = true;
        break;
      }
      default: {
        throw new Error(`Unknown option: ${token}`);
      }
    }
  }
  return {
    sourceProjectPath,
    targetProjectPath,
    force,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function removeIfExists(targetPath: string): Promise<void> {
  if (!(await pathExists(targetPath))) {
    return;
  }
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function pruneTechnicalSourcePaths(targetProjectPath: string): Promise<string[]> {
  const removed: string[] = [];
  const relativeTargets = [
    path.join("src", "chunks-ts"),
    path.join("src", "runtime"),
    path.join("src", "services", "store", "runtime"),
    path.join("src", "services", "store-sources"),
  ];
  for (const relativeTarget of relativeTargets) {
    const absoluteTarget = path.join(targetProjectPath, relativeTarget);
    if (!(await pathExists(absoluteTarget))) {
      continue;
    }
    await fs.rm(absoluteTarget, { recursive: true, force: true });
    removed.push(relativeTarget.split(path.sep).join("/"));
  }
  return removed;
}

async function writeManualProjectAgents(targetProjectPath: string): Promise<void> {
  const agentsPath = path.join(targetProjectPath, "AGENTS.md");
  const content = [
    "# Manual Codex Project",
    "",
    "- This project is a manual-first working slice copied from orchestrator output.",
    "- Keep architecture close to CodexMonitor (`src/main`, `src/renderer`, `src/services`, `src-tauri-adapter`).",
    "- Do not reintroduce technical layers under `src/*` (`chunks-ts`, `runtime`, `store-sources`).",
    "- Runtime/vendor/chunk payloads must stay in `artifacts/*`.",
    "- Reverse synchronization to generator is allowed only through `shared/manual-sync/*` contracts.",
    "",
  ].join("\n");
  await fs.writeFile(agentsPath, content, "utf8");
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const sourceExists = await pathExists(cli.sourceProjectPath);
  if (!sourceExists) {
    throw new Error(`Source project does not exist: ${cli.sourceProjectPath}`);
  }
  const targetExists = await pathExists(cli.targetProjectPath);
  if (targetExists && !cli.force) {
    throw new Error(`Target already exists: ${cli.targetProjectPath}. Use --force to overwrite.`);
  }
  await removeIfExists(cli.targetProjectPath);
  await fs.mkdir(path.dirname(cli.targetProjectPath), { recursive: true });
  await fs.cp(cli.sourceProjectPath, cli.targetProjectPath, { recursive: true, force: true, dereference: true });
  const prunedSourcePaths = await pruneTechnicalSourcePaths(cli.targetProjectPath);
  await writeManualProjectAgents(cli.targetProjectPath);

  const manifest: ManualBootstrapManifest = {
    generatedAtIso: new Date().toISOString(),
    sourceProjectPath: cli.sourceProjectPath,
    targetProjectPath: cli.targetProjectPath,
    transitionMode: "manual-first",
    reverseSyncPolicy: "shared/manual-sync/* only",
    structureContractPath: path.join(projectRoot, "config", "codexmonitor-structure-contract.json"),
    notes: [
      "Generator remains freeze-by-default. Use --allow-after-freeze for explicit reruns.",
      "Top-hot rescue constraints: top-10 worst only, namespace import cap <= 8.",
      ...prunedSourcePaths.map((entry) => `Pruned technical source path: ${entry}`),
    ],
  };
  await fs.writeFile(
    path.join(cli.targetProjectPath, "manual-ready-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        sourceProjectPath: cli.sourceProjectPath,
        targetProjectPath: cli.targetProjectPath,
        prunedSourcePaths,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
