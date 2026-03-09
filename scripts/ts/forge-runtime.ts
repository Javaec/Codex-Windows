import { writeError } from "./lib/exec";
import { ensureForgeWorkspace, resolveForgePaths } from "./lib/forge/paths";
import { activateForgeRuntimeInstall, captureActiveForgeRuntime, ensureForgeRuntimeRegistry } from "./lib/forge/runtime-registry";
import { syncForgeRuntimeLayer } from "./lib/forge/runtime-sync";

function usage(): never {
  throw new Error("Usage: forge-runtime <list|capture-current|activate <installId>>");
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
    case "activate": {
      const installId = process.argv[3];
      if (!installId) usage();
      const result = activateForgeRuntimeInstall(paths, config, installId);
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
