import * as path from "node:path";
import { executeRegressionSuite } from "./execute-suite";
import { cleanupKeepLastN } from "./cleanup";
import { loadRegressionSuite } from "./suite-loader";
import { ensureDirectory, writeJsonFile } from "../utils/fs-json";

interface CliOptions {
  snapshotAsarPath: string;
  suiteConfigPath: string;
  weightsConfigPath: string;
  outputRoot: string;
  baselinePath: string;
  keepLastN: number;
  suiteRunId: string;
}

function buildRunId(prefix: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${prefix}-${y}${m}${d}-${hh}${mm}${ss}`;
}

function parseIntegerOption(token: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Invalid ${token} value: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[], projectRoot: string): CliOptions {
  let snapshotAsarPath = "";
  let suiteConfigPath = path.join(projectRoot, "config", "regression-suite.json");
  let weightsConfigPath = path.join(projectRoot, "config", "tool-weights.json");
  let outputRoot = path.join(projectRoot, "regression", "runs");
  let baselinePath = path.join(projectRoot, "regression", "baseline-metrics.json");
  let keepLastN = 8;
  let suiteRunId = buildRunId("suite");

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--snapshot": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --snapshot");
        }
        snapshotAsarPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--suite-config": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --suite-config");
        }
        suiteConfigPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--weights-config": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --weights-config");
        }
        weightsConfigPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--output-root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-root");
        }
        outputRoot = path.resolve(value);
        index += 1;
        break;
      }
      case "--baseline-path": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --baseline-path");
        }
        baselinePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--keep-last-n": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --keep-last-n");
        }
        keepLastN = parseIntegerOption("--keep-last-n", value);
        index += 1;
        break;
      }
      case "--suite-run-id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --suite-run-id");
        }
        suiteRunId = value;
        index += 1;
        break;
      }
      case "--help": {
        const usage = [
          "Usage:",
          "  node dist/regression/run-regression-suite.js --snapshot <path-to-app.asar>",
          "",
          "Options:",
          "  --suite-config <path>",
          "  --weights-config <path>",
          "  --output-root <path>",
          "  --baseline-path <path>",
          "  --keep-last-n <n>",
          "  --suite-run-id <id>",
        ].join("\n");
        process.stdout.write(`${usage}\n`);
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (snapshotAsarPath.length === 0) {
    throw new Error("Argument --snapshot is required");
  }

  return {
    snapshotAsarPath,
    suiteConfigPath,
    weightsConfigPath,
    outputRoot,
    baselinePath,
    keepLastN,
    suiteRunId,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const suite = await loadRegressionSuite(cli.suiteConfigPath);
  await ensureDirectory(cli.outputRoot);

  const execution = await executeRegressionSuite({
    projectRoot,
    snapshotAsarPath: cli.snapshotAsarPath,
    suite,
    weightsConfigPath: cli.weightsConfigPath,
    suiteRunId: cli.suiteRunId,
    outputProfile: "regression-latest",
    outputDirectory: cli.outputRoot,
  });

  await writeJsonFile(cli.baselinePath, execution);
  await cleanupKeepLastN(cli.outputRoot, cli.keepLastN);
  process.stdout.write(`${JSON.stringify(execution, null, 2)}\n`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
