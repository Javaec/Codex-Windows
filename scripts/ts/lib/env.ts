import * as path from "node:path";
import { ensureDir, fileExists, resolveCommand, runCommand, writeError, writeSuccess, writeWarn } from "./exec";
import { getWindowsRuntimeDonorRipgrepPath } from "./runtime-donor/windows-apps";

export interface RipgrepResult {
  installed: boolean;
  path: string;
  source: "path" | "windows-runtime-donor" | "portable";
}

export interface ContractCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface ContractResult {
  passed: boolean;
  checks: ContractCheck[];
}

function isWindowsRuntimeDonorExecutable(filePath: string): boolean {
  const normalized = path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
  return normalized.includes("\\program files\\windowsapps\\openai.codex_");
}

export function resolveCmdPath(): string | null {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  for (const candidate of [
    path.join(systemRoot, "System32", "cmd.exe"),
    path.join(systemRoot, "Sysnative", "cmd.exe"),
  ]) {
    if (fileExists(candidate)) return path.resolve(candidate);
  }
  return null;
}

export function resolveWindowsPowerShellPath(): string | null {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fileExists(candidate) ? path.resolve(candidate) : null;
}

export function resolvePwshPath(): string | null {
  const candidates: string[] = [];
  if (process.env.CODEX_PWSH_PATH) candidates.push(process.env.CODEX_PWSH_PATH);
  const wherePwsh = resolveCommand("pwsh.exe");
  if (wherePwsh) candidates.push(wherePwsh);
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
    candidates.push(path.join(process.env.ProgramFiles, "PowerShell", "7-preview", "pwsh.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe"));
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7-preview", "pwsh.exe"));
  }
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return path.resolve(candidate);
  }
  return resolveWindowsPowerShellPath();
}

function mergePathEntries(entries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const cleaned = entry.trim().replace(/^"+|"+$/g, "");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function ensureWindowsEnvironment(): void {
  const current = (process.env.PATH || process.env.Path || "").split(";");
  const defaults: string[] = [];
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  defaults.push(systemRoot);
  defaults.push(path.join(systemRoot, "System32"));
  defaults.push(path.join(systemRoot, "System32", "Wbem"));
  defaults.push(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"));
  defaults.push(path.join(systemRoot, "System32", "OpenSSH"));

  if (process.env.ProgramFiles) {
    defaults.push(path.join(process.env.ProgramFiles, "PowerShell", "7"));
    defaults.push(path.join(process.env.ProgramFiles, "nodejs"));
    defaults.push(path.join(process.env.ProgramFiles, "Git", "cmd"));
    defaults.push(path.join(process.env.ProgramFiles, "Git", "bin"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    defaults.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7"));
    defaults.push(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
    defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd"));
    defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin"));
  }
  if (process.env.APPDATA) defaults.push(path.join(process.env.APPDATA, "npm"));
  if (process.env.LOCALAPPDATA) {
    defaults.push(path.join(process.env.LOCALAPPDATA, "fnm"));
    defaults.push(path.join(process.env.LOCALAPPDATA, "Volta", "bin"));
  }
  if (process.env.NVM_SYMLINK) defaults.push(process.env.NVM_SYMLINK);

  const existing = [...current, ...defaults].filter((entry) => entry && fileExists(entry));
  const merged = mergePathEntries(existing);
  process.env.PATH = merged.join(";");
  process.env.Path = process.env.PATH;

  if (!process.env.PATHEXT) {
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  }
  const cmdPath = resolveCmdPath();
  if (cmdPath) process.env.COMSPEC = cmdPath;
  const pwsh = resolvePwshPath();
  if (pwsh) process.env.CODEX_PWSH_PATH = pwsh;
}

export async function ensureRipgrepInPath(workDir: string): Promise<RipgrepResult> {
  const existing = resolveCommand("rg.exe") ?? resolveCommand("rg");
  if (existing && !isWindowsRuntimeDonorExecutable(existing)) {
    return { installed: false, path: existing, source: "path" };
  }

  const donorRipgrep = existing && isWindowsRuntimeDonorExecutable(existing) ? existing : getWindowsRuntimeDonorRipgrepPath();
  if (donorRipgrep) {
    const donorDir = path.dirname(donorRipgrep);
    process.env.PATH = mergePathEntries([donorDir, ...(process.env.PATH || "").split(";")]).join(";");
    process.env.Path = process.env.PATH;
    return { installed: false, path: donorRipgrep, source: "windows-runtime-donor" };
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const portableCandidates = [
    path.join(workDir, "tools", "ripgrep", "ripgrep-14.1.1-x86_64-pc-windows-msvc", "rg.exe"),
    path.join(repoRoot, "work", "tools", "ripgrep", "ripgrep-14.1.1-x86_64-pc-windows-msvc", "rg.exe"),
  ];
  const rgExe = portableCandidates.find((candidate) => fileExists(candidate)) || "";
  if (fileExists(rgExe)) {
    process.env.PATH = mergePathEntries([path.dirname(rgExe), ...(process.env.PATH || "").split(";")]).join(";");
    process.env.Path = process.env.PATH;
    return { installed: true, path: rgExe, source: "portable" };
  }

  throw new Error("rg.exe not found. Allowed sources: PATH, Windows runtime donor, repo-local work/tools/ripgrep.");
}

function runCmdCheck(cmdPath: string, args: string[]): number {
  return runCommand(cmdPath, ["/d", "/c", ...args], {
    capture: true,
    allowNonZero: true,
  }).status;
}

function newContractCheck(name: string, passed: boolean, details: string): ContractCheck {
  return { name, passed, details };
}

export function invokeEnvironmentContractChecks(): ContractResult {
  const checks: ContractCheck[] = [];
  const cmdPath = resolveCmdPath();
  checks.push(newContractCheck("cmd.exe available", Boolean(cmdPath), cmdPath || "cmd.exe not found"));

  const nodePath = resolveCommand("node.exe") ?? resolveCommand("node");
  checks.push(newContractCheck("node available in host process", Boolean(nodePath), nodePath || "node not found in current PATH"));

  const pwshPath = resolvePwshPath();
  checks.push(newContractCheck("pwsh/powershell resolver", Boolean(pwshPath), pwshPath || "pwsh and fallback powershell not found"));

  const rgPath = resolveCommand("rg.exe") ?? resolveCommand("rg");
  checks.push(newContractCheck("rg (ripgrep) available", Boolean(rgPath), rgPath || "rg not found in current PATH"));

  if (cmdPath) {
    const whereNode = runCmdCheck(cmdPath, ["where", "node"]);
    checks.push(newContractCheck("cmd where node", whereNode === 0, `exit=${whereNode}`));
    const nodeV = runCmdCheck(cmdPath, ["node", "-v"]);
    checks.push(newContractCheck("cmd node -v", nodeV === 0, `exit=${nodeV}`));
    const wherePwsh = runCmdCheck(cmdPath, ["where", "powershell"]);
    checks.push(newContractCheck("cmd where powershell", wherePwsh === 0, `exit=${wherePwsh}`));
  }

  return { passed: checks.every((check) => check.passed), checks };
}

export function writeEnvironmentContractSummary(result: ContractResult): void {
  for (const check of result.checks) {
    if (check.passed) writeSuccess(`[env] OK    ${check.name} :: ${check.details}`);
    else writeError(`[env] FAIL  ${check.name} :: ${check.details}`);
  }
}

export function assertEnvironmentContract(strict: boolean): ContractResult {
  const result = invokeEnvironmentContractChecks();
  writeEnvironmentContractSummary(result);
  if (!result.passed) {
    const message = "Windows environment contract check failed.";
    if (strict) throw new Error(message);
    writeWarn(`${message} Continuing in non-strict mode.`);
  }
  return result;
}

export function invokeElectronChildEnvironmentContract(
  electronExe: string,
  workingDir: string,
  strict: boolean,
): boolean {
  if (!fileExists(electronExe)) {
    const message = "Electron child environment check skipped: electron runtime not found.";
    if (strict) throw new Error(message);
    writeWarn(message);
    return false;
  }
  if (!fileExists(workingDir)) {
    const message = "Electron child environment check skipped: working dir not found.";
    if (strict) throw new Error(message);
    writeWarn(message);
    return false;
  }

  const script = String.raw`
const cp=require("node:child_process");
function run(file,args){
  const result = cp.spawnSync(file,args,{stdio:"pipe",windowsHide:true});
  if(result.error) return false;
  return result.status===0;
}
const checks=[
  ["child where node","where.exe",["node"]],
  ["child node -v","node.exe",["-v"]],
  ["child where powershell","where.exe",["powershell"]]
];
let ok=true;
for(const [name,file,args] of checks){
  const passed=run(file,args);
  process.stdout.write("[electron-env] "+(passed?"OK":"FAIL")+" "+name+"\\n");
  if(!passed) ok=false;
}
process.exit(ok?0:1);
`;

  const result = runCommand(electronExe, ["-e", script], {
    cwd: workingDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    capture: false,
    allowNonZero: true,
  });

  if (result.status !== 0) {
    const message = `Electron child environment contract check failed (exit=${result.status}).`;
    if (strict) throw new Error(message);
    writeWarn(message);
    return false;
  }
  return true;
}
