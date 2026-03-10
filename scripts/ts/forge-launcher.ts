import { writeError } from "./lib/exec";
import { ensureForgeWorkspace, resolveForgePaths } from "./lib/forge/paths";
import { getForgeState } from "./lib/forge/state";

type CliOptions = {
  printState: boolean;
};

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    printState: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token.toLowerCase()) {
      case "--print-state":
        options.printState = true;
        break;
      default:
        throw new Error(`Unknown Codex Forge option: ${token}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const paths = resolveForgePaths();
  const config = ensureForgeWorkspace(paths);
  if (!options.printState) {
    throw new Error("Codex Forge browser launcher was removed. Use Launch-Codex-Forge.cmd or npm run forge:electron.");
  }
  process.stdout.write(`${JSON.stringify(getForgeState(paths, config), null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`[ERROR] ${message}`);
  process.exit(1);
});
