import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Mode = "run" | "build";

interface ParsedArgs {
  mode: Mode;
  showHelp: boolean;
  forwarded: string[];
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ADAPTER_SCRIPT = path.join(REPO_ROOT, "scripts", "adapters", "legacy-pipeline.ps1");

function printUsage(): void {
  console.log("Usage:");
  console.log("  node scripts/node/run.js run [options]");
  console.log("  node scripts/node/run.js build [options]");
  console.log("");
  console.log("Examples:");
  console.log("  node scripts/node/run.js run -DmgPath .\\Codex.dmg -Reuse");
  console.log("  node scripts/node/run.js build -DmgPath .\\Codex.dmg -Reuse -NoLaunch");
  console.log("");
  console.log("Options are passed through to the pipeline as-is.");
}

function resolvePowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const winPs = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(winPs)) {
    return winPs;
  }
  return "powershell.exe";
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { mode: "run", showHelp: true, forwarded: [] };
  }

  let mode: Mode = "run";
  let index = 0;
  const first = argv[0].toLowerCase();
  if (!first.startsWith("-")) {
    if (first === "run" || first === "build") {
      mode = first;
      index = 1;
    } else if (first === "help") {
      return { mode: "run", showHelp: true, forwarded: [] };
    } else {
      throw new Error(`Unsupported mode: ${argv[0]}`);
    }
  }

  const rest = argv.slice(index);
  const showHelp = rest.some((arg) => arg === "-h" || arg === "--help");
  return {
    mode,
    showHelp,
    forwarded: showHelp ? [] : rest,
  };
}

function runPipeline(mode: Mode, forwarded: string[]): number {
  if (!fs.existsSync(ADAPTER_SCRIPT)) {
    console.error(`[ERROR] Missing adapter script: ${ADAPTER_SCRIPT}`);
    return 1;
  }

  const psExe = resolvePowerShellExecutable();
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ADAPTER_SCRIPT,
    "-Mode",
    mode,
    ...forwarded,
  ];

  const result = spawnSync(psExe, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`[ERROR] PowerShell not found: ${psExe}`);
    } else {
      console.error(`[ERROR] Failed to execute adapter: ${result.error.message}`);
    }
    return 1;
  }

  if (typeof result.status === "number") {
    return result.status;
  }
  return 1;
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }
  return runPipeline(parsed.mode, parsed.forwarded);
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}
