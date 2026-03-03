import * as path from "node:path";
import { runManualHotRescue } from "./hot-rescue";

interface CliOptions {
  manualProjectPath: string;
  candidatesPath: string;
  topN: number;
  namespaceImportCap: number;
  longFunctionLineThreshold: number;
  outputPath: string;
}

function parseIntegerOption(flag: string, value: string, minimum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCli(argv: readonly string[], projectRoot: string): CliOptions {
  let manualProjectPath = path.join(projectRoot, "..", "manual-codex-app");
  let candidatesPath = path.join(projectRoot, "regression", "manual-refactor-candidates.json");
  let topN = 10;
  let namespaceImportCap = 8;
  let longFunctionLineThreshold = 120;
  let outputPath = path.join(projectRoot, "shared", "manual-sync", "manual-hot-rescue-last-report.json");
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--manual-project": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--manual-project requires a value");
        }
        manualProjectPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--candidates": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--candidates requires a value");
        }
        candidatesPath = path.resolve(value);
        index += 1;
        break;
      }
      case "--top-n": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--top-n requires a value");
        }
        topN = parseIntegerOption("--top-n", value, 1);
        index += 1;
        break;
      }
      case "--namespace-cap": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--namespace-cap requires a value");
        }
        namespaceImportCap = parseIntegerOption("--namespace-cap", value, 1);
        index += 1;
        break;
      }
      case "--long-function-lines": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--long-function-lines requires a value");
        }
        longFunctionLineThreshold = parseIntegerOption("--long-function-lines", value, 20);
        index += 1;
        break;
      }
      case "--output": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("--output requires a value");
        }
        outputPath = path.resolve(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }
  return {
    manualProjectPath,
    candidatesPath,
    topN,
    namespaceImportCap,
    longFunctionLineThreshold,
    outputPath,
  };
}

async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const cli = parseCli(process.argv.slice(2), projectRoot);
  const report = await runManualHotRescue({
    manualProjectPath: cli.manualProjectPath,
    candidatesPath: cli.candidatesPath,
    topN: cli.topN,
    namespaceImportCap: cli.namespaceImportCap,
    longFunctionLineThreshold: cli.longFunctionLineThreshold,
    outputPath: cli.outputPath,
  });
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: cli.outputPath }, null, 2)}\n`);
  if (report.violationCount > 0) {
    const violationSummary = report.targets
      .flatMap((target) =>
        target.violations.map((violation) => `${target.manualFilePath} [rank ${target.rank}] -> ${violation}`),
      )
      .join("\n");
    throw new Error(`manual hot rescue gate failed:\n${violationSummary}`);
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
