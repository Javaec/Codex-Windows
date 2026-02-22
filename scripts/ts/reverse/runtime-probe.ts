import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { ensureDir, removePath } from "../lib/exec";
import type { ProbeLineClass } from "./rpc-schema";

export interface RuntimeProbeResult {
  attempted: boolean;
  success: boolean;
  forcedStop: boolean;
  skippedReason: string;
  electronExe: string;
  userDataDir: string;
  durationMs: number;
  exitCode: number;
  signal: string;
  stdoutLines: number;
  stderrLines: number;
  warnings: string[];
  errors: string[];
  warningClassification: {
    system: string[];
    logic: string[];
    unknown: string[];
  };
  errorClassification: {
    system: string[];
    logic: string[];
    unknown: string[];
  };
  capturedLines: string[];
  logPath: string;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

export function findElectronExecutableCandidates(appDir: string, explicitPath: string): string[] {
  const repoRoot = path.resolve(appDir, "..", "..");
  const workRoot = path.resolve(appDir, "..");
  const candidates = [
    explicitPath,
    path.join(workRoot, "native-builds", "node_modules", "electron", "dist", "electron.exe"),
    path.join(repoRoot, "work", "native-builds", "node_modules", "electron", "dist", "electron.exe"),
    path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe"),
  ];
  return Array.from(
    new Set(
      candidates
        .filter((item) => !!item)
        .map((item) => path.resolve(item))
        .filter((item) => fs.existsSync(item) && fs.statSync(item).isFile()),
    ),
  );
}

export function classifyProbeLine(line: string): ProbeLineClass {
  const lower = line.toLowerCase();
  if (lower.length === 0) return "unknown";

  const logicPatterns = [
    /\btypeerror\b/,
    /\breferenceerror\b/,
    /\brangeerror\b/,
    /\bsyntaxerror\b/,
    /\bipc\b/,
    /\brpc\b/,
    /\brouter?\b/,
    /\broute\b/,
    /\bstate\b/,
    /\bthread\b/,
    /\bsession\b/,
    /\bconversation\b/,
    /\bchat\b/,
    /\bturn\b/,
    /\bapproval\b/,
    /\bworkspace\b/,
    /\bworktree\b/,
    /\bsettings?\b/,
    /\bmodel\b/,
    /\bauth\b/,
    /\blogin\b/,
    /\bmcp\b/,
    /\bautomation\b/,
    /\bstatsig\b/,
    /\bgate\b/,
    /\bundefined\b/,
    /cannot read (?:properties|property)/,
    /\bunhandled(?:rejection)?\b/,
  ];
  if (logicPatterns.some((pattern) => pattern.test(lower))) {
    return "logic";
  }

  const systemPatterns = [
    /\bcache\b/,
    /\bprofile\b/,
    /\buser-data-dir\b/,
    /\bgpu\b/,
    /\bwebgl\b/,
    /\bvulkan\b/,
    /\bd3d\b/,
    /\bnvidia\b/,
    /\bdmabuf\b/,
    /\bcompositor\b/,
    /\bwebkit\b/,
    /\bchromium\b/,
    /\bnetwork\b/,
    /\bdns\b/,
    /\bsocket\b/,
    /\btls\b/,
    /\bssl\b/,
    /\bcertificate\b/,
    /\bproxy\b/,
    /\bfirewall\b/,
    /\bpermission denied\b/,
    /\baccess denied\b/,
    /\bepipe\b/,
    /\beconnrefused\b/,
    /\betimedout\b/,
    /\benotfound\b/,
    /\bcrashpad\b/,
    /\bsandbox\b/,
    /\bfilesystem\b/,
    /\bdisk\b/,
    /\benoent\b/,
    /\bpath does not exist\b/,
    /\bfirst[-_ ]party sets?\b/,
    /\bfirst_party_sets\b/,
  ];
  if (systemPatterns.some((pattern) => pattern.test(lower))) {
    return "system";
  }

  return "unknown";
}

function classifyProbeLines(lines: string[], maxPerBucket: number): {
  system: string[];
  logic: string[];
  unknown: string[];
} {
  const buckets: { system: string[]; logic: string[]; unknown: string[] } = {
    system: [],
    logic: [],
    unknown: [],
  };
  for (const line of lines) {
    const kind = classifyProbeLine(line);
    if (buckets[kind].length >= maxPerBucket) continue;
    buckets[kind].push(line);
  }
  return buckets;
}

export async function runRuntimeProbe(input: {
  appDir: string;
  reportDir: string;
  electronExe: string;
  durationMs: number;
}): Promise<RuntimeProbeResult> {
  const logPath = path.join(input.reportDir, "runtime-probe.log");
  const userDataDir = path.join(input.reportDir, "runtime-probe-profile");
  if (!input.electronExe) {
    const skipped: RuntimeProbeResult = {
      attempted: false,
      success: false,
      forcedStop: false,
      skippedReason: "Electron executable not found.",
      electronExe: "",
      userDataDir: toPosixPath(userDataDir),
      durationMs: 0,
      exitCode: -1,
      signal: "",
      stdoutLines: 0,
      stderrLines: 0,
      warnings: [],
      errors: [],
      warningClassification: { system: [], logic: [], unknown: [] },
      errorClassification: { system: [], logic: [], unknown: [] },
      capturedLines: [],
      logPath: toPosixPath(logPath),
    };
    fs.writeFileSync(logPath, "Runtime probe skipped: Electron executable not found.\n", "utf8");
    return skipped;
  }

  const start = Date.now();
  removePath(userDataDir);
  ensureDir(userDataDir);

  const args = [
    input.appDir,
    "--enable-logging",
    "--v=1",
    "--log-level=0",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
  ];
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1",
    NODE_ENV: "production",
  };

  const child = spawn(input.electronExe, args, {
    cwd: path.dirname(input.appDir),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk: Buffer | string) => stdoutChunks.push(String(chunk)));
  child.stderr.on("data", (chunk: Buffer | string) => stderrChunks.push(String(chunk)));

  let exitCode = -1;
  let exitSignal = "";
  let spawnErrorMessage = "";
  let forcedStop = false;
  child.once("error", (error) => {
    spawnErrorMessage = error instanceof Error ? error.message : String(error);
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitCode = typeof code === "number" ? code : -1;
      exitSignal = signal ?? "";
      resolve();
    });
  });

  await new Promise((resolve) => setTimeout(resolve, input.durationMs));

  if (child.exitCode === null && child.pid) {
    forcedStop = true;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }

  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  const stdoutText = stdoutChunks.join("");
  const stderrText = stderrChunks.join("");
  const combined = `${stdoutText}\n${stderrText}`.trim();
  fs.writeFileSync(logPath, `${combined}\n`, "utf8");

  const lines = combined.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const warnings = lines
    .filter((line) => /\bwarn(?:ing)?\b/i.test(line))
    .slice(0, 120);
  const errors = lines
    .filter((line) => /\berror\b|\bexception\b|\bfailed\b|uncaught|unhandled/i.test(line))
    .slice(0, 120);
  if (spawnErrorMessage) errors.unshift(`spawn-error: ${spawnErrorMessage}`);
  const warningClassification = classifyProbeLines(warnings, 120);
  const errorClassification = classifyProbeLines(errors, 120);
  const capturedLines = lines.slice(0, 8000);

  const spawned = !!child.pid && !spawnErrorMessage;

  return {
    attempted: true,
    success: spawned && (forcedStop || exitCode === 0 || exitSignal.length > 0),
    forcedStop,
    skippedReason: spawnErrorMessage ? spawnErrorMessage : "",
    electronExe: toPosixPath(input.electronExe),
    userDataDir: toPosixPath(userDataDir),
    durationMs: Date.now() - start,
    exitCode,
    signal: exitSignal,
    stdoutLines: stdoutText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
    stderrLines: stderrText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
    warnings,
    errors,
    warningClassification,
    errorClassification,
    capturedLines,
    logPath: toPosixPath(logPath),
  };
}
