import { writeError } from "./lib/exec";
import { ensureForgeWorkspace, resolveForgePaths } from "./lib/forge/paths";
import { activateForgeRuntimeInstall, captureActiveForgeRuntime, ensureForgeRuntimeRegistry } from "./lib/forge/runtime-registry";
import { syncForgeRuntimeLayer } from "./lib/forge/runtime-sync";
import { discoverForgeRuntimeSources, importForgeRuntimeDirectory, importForgeRuntimeSource } from "./lib/forge/runtime-sources";

function usage(): never {
  throw new Error("Usage: forge-runtime <list|sources|capture-current|import-source <sourceId>|import-dir <runtimeDir>|import-official|activate <installId>|activate-repo-dist>");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) usage();

  const paths = resolveForgePaths();
  const config = ensureForgeWorkspace(paths);

  switch (String(command).toLowerCase()) {
    case "list": {
      const ensured = ensureForgeRuntimeRegistry(paths, config);
      process.stdout.write(`${JSON.stringify(ensured.registry, null, 2)}\n`);
      return;
    }
    case "capture-current": {
      const result = captureActiveForgeRuntime(paths, config);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "sources": {
      const result = discoverForgeRuntimeSources(paths, config);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "import-source": {
      const sourceId = process.argv[3];
      if (!sourceId) usage();
      const result = importForgeRuntimeSource(paths, config, sourceId);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "import-dir": {
      const runtimeDir = process.argv[3];
      if (!runtimeDir) usage();
      const result = importForgeRuntimeDirectory(paths, config, runtimeDir);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    case "import-official": {
      const sources = discoverForgeRuntimeSources(paths, config);
      const source = sources.find((entry) => entry.kind === "windows-runtime-donor");
      if (!source) {
        throw new Error("No official Windows Codex runtime source was found.");
      }
      const result = importForgeRuntimeSource(paths, config, source.id);
      process.stdout.write(`${JSON.stringify({ source, result }, null, 2)}\n`);
      return;
    }
    case "activate": {
      const installId = process.argv[3];
      if (!installId) usage();
      const result = activateForgeRuntimeInstall(paths, config, installId);
      const syncResult = syncForgeRuntimeLayer(paths, result.config);
      process.stdout.write(`${JSON.stringify({ result, syncResult }, null, 2)}\n`);
      return;
    }
    case "activate-repo-dist": {
      const result = activateForgeRuntimeInstall(paths, config, "repo-dist-current");
      const syncResult = syncForgeRuntimeLayer(paths, result.config);
      process.stdout.write(`${JSON.stringify({ result, syncResult }, null, 2)}\n`);
      return;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`[ERROR] ${message}`);
  process.exit(1);
});
