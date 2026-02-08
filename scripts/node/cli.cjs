#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const adapterScript = path.join(repoRoot, "scripts", "adapters", "legacy-pipeline.ps1");

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/node/cli.cjs run [options]");
  console.log("  node scripts/node/cli.cjs build [options]");
  console.log("");
  console.log("Modes:");
  console.log("  run    direct launch flow");
  console.log("  build  portable build flow (injects -BuildPortable)");
  console.log("");
  console.log("Options are passed through to the legacy pipeline as-is.");
}

function resolvePowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const winPs = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(winPs)) {
    return winPs;
  }
  return "powershell.exe";
}

function runAdapter(mode, forwardedArgs) {
  if (!fs.existsSync(adapterScript)) {
    console.error(`[ERROR] Missing adapter script: ${adapterScript}`);
    return 1;
  }

  const psExe = resolvePowerShellExecutable();
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    adapterScript,
    "-Mode",
    mode,
    ...forwardedArgs,
  ];

  const result = spawnSync(psExe, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`[ERROR] PowerShell not found: ${psExe}`);
    } else {
      console.error(`[ERROR] Failed to execute adapter: ${result.error.message}`);
    }
    return 1;
  }

  return typeof result.status === "number" ? result.status : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printUsage();
    return 0;
  }

  const mode = argv[0];
  if (mode !== "run" && mode !== "build") {
    console.error(`[ERROR] Unsupported mode: ${mode}`);
    printUsage();
    return 1;
  }

  if (argv.length > 1 && (argv[1] === "-h" || argv[1] === "--help")) {
    printUsage();
    return 0;
  }

  const forwardedArgs = argv.slice(1);
  return runAdapter(mode, forwardedArgs);
}

process.exit(main());