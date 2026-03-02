import * as path from "node:path";
import { defaultManualSyncRootPath } from "./contracts";
import { validateManualSyncContracts } from "./validator";

interface CliOptions {
  projectRoot: string;
  manualSyncRootPath: string;
  requireFiles: boolean;
}

function printUsage(): void {
  const usage = [
    "Usage:",
    "  node dist/manual-sync/validate-contracts.js [options]",
    "",
    "Options:",
    "  --manual-sync-root <path>   default: shared/manual-sync",
    "  --require-files             fail if contract files are missing (default: on)",
    "",
    "Example:",
    "  node dist/manual-sync/validate-contracts.js --require-files",
  ].join("\n");
  process.stdout.write(`${usage}\n`);
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let manualSyncRootPath = defaultManualSyncRootPath(projectRoot);
  let requireFiles = true;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
    if (token === "--manual-sync-root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --manual-sync-root");
      }
      manualSyncRootPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === "--require-files") {
      requireFiles = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return {
    projectRoot,
    manualSyncRootPath,
    requireFiles,
  };
}

async function run(): Promise<void> {
  const projectRoot = process.cwd();
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const result = await validateManualSyncContracts(cli.projectRoot, cli.manualSyncRootPath, {
    requireFiles: cli.requireFiles,
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  if (result.warnings.length > 0) {
    process.stdout.write("Warnings:\n");
    for (const warning of result.warnings) {
      process.stdout.write(`- [${warning.source}] ${warning.message}\n`);
    }
  }
  if (result.errors.length > 0) {
    process.stdout.write("Errors:\n");
    for (const error of result.errors) {
      process.stdout.write(`- [${error.source}] ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
