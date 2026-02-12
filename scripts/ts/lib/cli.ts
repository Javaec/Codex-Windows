import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, fileExists, resolveCommand, runCommand, uniqueExistingDirs } from "./exec";
import { invokeNpmCapture } from "./npm";

export interface CliResolution {
  found: boolean;
  path: string | null;
  source: string | null;
  preferredArch: string;
  trace: string[];
}

export interface CliProbeResult {
  ok: boolean;
  details: string;
}

function newCliResolveResult(preferredArch: string): CliResolution {
  return {
    found: false,
    path: null,
    source: null,
    preferredArch,
    trace: [],
  };
}

function addCliTrace(result: CliResolution, message: string): void {
  result.trace.push(message);
}

function getNpmGlobalRoots(): string[] {
  const roots: string[] = [];
  try {
    const npmRoot = invokeNpmCapture(["root", "-g"]).trim();
    if (npmRoot) roots.push(npmRoot);
  } catch {
    // ignore
  }
  try {
    const prefix = invokeNpmCapture(["prefix", "-g"]).trim();
    if (prefix) roots.push(path.join(prefix, "node_modules"));
  } catch {
    // ignore
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  return uniqueExistingDirs(roots);
}

function findCodexVendorExeInRoot(root: string, preferredArch: string): string | null {
  const packageFolderOrder =
    preferredArch === "aarch64-pc-windows-msvc"
      ? ["codex-win32-arm64", "codex-win32-x64"]
      : ["codex-win32-x64", "codex-win32-arm64"];
  const archOrder =
    preferredArch === "aarch64-pc-windows-msvc"
      ? ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"]
      : ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];

  const candidates: string[] = [];
  for (const arch of archOrder) {
    // Legacy layout (0.98 and earlier):
    // <root>/@openai/codex/vendor/<triple>/codex/codex.exe
    candidates.push(path.join(root, "@openai", "codex", "vendor", arch, "codex", "codex.exe"));

    // Optional package layout (0.99+), hoisted dependency:
    // <root>/@openai/codex-win32-x64/vendor/<triple>/codex/codex.exe
    // <root>/@openai/codex-win32-arm64/vendor/<triple>/codex/codex.exe
    for (const packageFolder of packageFolderOrder) {
      candidates.push(path.join(root, "@openai", packageFolder, "vendor", arch, "codex", "codex.exe"));

      // Optional package nested under @openai/codex/node_modules (npm 0.99 observed layout):
      // <root>/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/<triple>/codex/codex.exe
      candidates.push(
        path.join(
          root,
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          packageFolder,
          "vendor",
          arch,
          "codex",
          "codex.exe",
        ),
      );
    }
  }

  for (const candidate of candidates) {
    if (fileExists(candidate)) return path.resolve(candidate);
  }
  return null;
}

function resolveNpmShimToVendorExe(shimPath: string, preferredArch: string, result: CliResolution): string | null {
  if (!shimPath || !fileExists(shimPath)) return null;
  const shimDir = path.dirname(shimPath);
  const roots = uniqueExistingDirs([path.join(shimDir, "node_modules"), ...getNpmGlobalRoots()]);
  for (const root of roots) {
    const resolved = findCodexVendorExeInRoot(root, preferredArch);
    if (resolved) {
      addCliTrace(result, `Resolved shim [${shimPath}] via root [${root}] -> [${resolved}]`);
      return resolved;
    }
  }
  addCliTrace(result, `Shim [${shimPath}] did not resolve to vendor codex.exe`);
  return null;
}

export function resolveCodexCliPathContract(explicit: string | undefined, throwOnFailure: boolean): CliResolution {
  const preferredArch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const result = newCliResolveResult(preferredArch);

  const resolveCandidate = (candidate: string | undefined, source: string): string | null => {
    if (!candidate) return null;
    const resolvedCandidate = path.resolve(candidate);
    if (!fileExists(resolvedCandidate)) {
      addCliTrace(result, `Candidate missing [${source}] -> [${resolvedCandidate}]`);
      return null;
    }

    const ext = path.extname(resolvedCandidate).toLowerCase();
    if (ext === ".exe") {
      addCliTrace(result, `Accepted executable [${source}] -> [${resolvedCandidate}]`);
      return resolvedCandidate;
    }
    if (ext === ".cmd" || ext === ".ps1" || !ext) {
      addCliTrace(result, `Candidate is shim/non-exe [${source}] -> [${resolvedCandidate}]`);
      return resolveNpmShimToVendorExe(resolvedCandidate, preferredArch, result);
    }
    addCliTrace(result, `Rejected unsupported extension [${source}] -> [${resolvedCandidate}]`);
    return null;
  };

  if (explicit) {
    const resolvedExplicit = resolveCandidate(explicit, "explicit");
    if (resolvedExplicit) {
      result.found = true;
      result.path = resolvedExplicit;
      result.source = "explicit";
      return result;
    }
    if (throwOnFailure) {
      throw new Error(`Codex CLI not found from explicit path [${explicit}]. Trace: ${result.trace.join(" | ")}`);
    }
    return result;
  }

  if (process.env.CODEX_CLI_PATH) {
    const resolvedEnv = resolveCandidate(process.env.CODEX_CLI_PATH, "env:CODEX_CLI_PATH");
    if (resolvedEnv) {
      result.found = true;
      result.path = resolvedEnv;
      result.source = "env:CODEX_CLI_PATH";
      return result;
    }
  }

  for (const root of getNpmGlobalRoots()) {
    const vendorExe = findCodexVendorExeInRoot(root, preferredArch);
    if (vendorExe) {
      addCliTrace(result, `Detected vendor exe in npm root [${root}] -> [${vendorExe}]`);
      result.found = true;
      result.path = vendorExe;
      result.source = "npm-vendor";
      return result;
    }
    addCliTrace(result, `No vendor exe in npm root [${root}]`);
  }

  const whereCandidates = uniqueExistingDirs(
    [resolveCommand("codex.exe"), resolveCommand("codex.cmd"), resolveCommand("codex")].filter(Boolean) as string[],
  );
  for (const candidate of whereCandidates) {
    const resolved = resolveCandidate(candidate, "where");
    if (resolved) {
      result.found = true;
      result.path = resolved;
      result.source = "where";
      return result;
    }
  }

  if (throwOnFailure) {
    throw new Error(`codex.exe not found. Trace: ${result.trace.join(" | ")}`);
  }
  return result;
}

export function writeCliResolutionTrace(resolution: CliResolution, tracePath: string): void {
  ensureDir(path.dirname(tracePath));
  const lines: string[] = [];
  lines.push(`timestampUtc=${new Date().toISOString()}`);
  lines.push(`found=${resolution.found}`);
  lines.push(`path=${resolution.path ?? ""}`);
  lines.push(`source=${resolution.source ?? ""}`);
  lines.push(`preferredArch=${resolution.preferredArch}`);
  for (const entry of resolution.trace) lines.push(`trace=${entry}`);
  fs.writeFileSync(tracePath, `${lines.join("\n")}\n`, "utf8");
}

export function probeCodexCliExecutable(exePath: string): CliProbeResult {
  if (!exePath) return { ok: false, details: "Empty CLI path." };
  if (!fileExists(exePath)) return { ok: false, details: `CLI path does not exist: ${exePath}` };
  try {
    const result = runCommand(exePath, ["--version"], {
      capture: true,
      allowNonZero: true,
    });
    const out = (result.stdout || result.stderr || "").trim();
    if (result.status !== 0) {
      return { ok: false, details: `Exit=${result.status}; output=${out}` };
    }
    return { ok: true, details: out || "version command succeeded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, details: message };
  }
}
