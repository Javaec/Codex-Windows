"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCmdPath = resolveCmdPath;
exports.resolveWindowsPowerShellPath = resolveWindowsPowerShellPath;
exports.resolvePwshPath = resolvePwshPath;
exports.resolveSshPath = resolveSshPath;
exports.resolveNodePath = resolveNodePath;
exports.ensureWindowsEnvironment = ensureWindowsEnvironment;
exports.ensureRipgrepInPath = ensureRipgrepInPath;
exports.invokeEnvironmentContractChecks = invokeEnvironmentContractChecks;
exports.writeEnvironmentContractSummary = writeEnvironmentContractSummary;
exports.assertEnvironmentContract = assertEnvironmentContract;
exports.invokeElectronChildEnvironmentContract = invokeElectronChildEnvironmentContract;
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
const windows_apps_1 = require("./runtime-donor/windows-apps");
function isWindowsRuntimeDonorExecutable(filePath) {
    const normalized = path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
    return normalized.includes("\\program files\\windowsapps\\openai.codex_");
}
function isStalePortableExecutable(filePath) {
    let currentDir = path.dirname(path.resolve(filePath));
    for (let depth = 0; depth < 6; depth += 1) {
        const dirName = path.basename(currentDir).toLowerCase();
        if (dirName.startsWith("codex-win32-") && (dirName.endsWith("-work") || dirName.includes("-next"))) {
            return true;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir)
            break;
        currentDir = parentDir;
    }
    return false;
}
function resolveCmdPath() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    for (const candidate of [
        path.join(systemRoot, "System32", "cmd.exe"),
        path.join(systemRoot, "Sysnative", "cmd.exe"),
    ]) {
        if ((0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return null;
}
function resolveWindowsPowerShellPath() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return (0, exec_1.fileExists)(candidate) ? path.resolve(candidate) : null;
}
function resolvePwshPath() {
    const candidates = [];
    if (process.env.CODEX_PWSH_PATH)
        candidates.push(process.env.CODEX_PWSH_PATH);
    const wherePwsh = (0, exec_1.resolveCommand)("pwsh.exe");
    if (wherePwsh)
        candidates.push(wherePwsh);
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
        candidates.push(path.join(process.env.ProgramFiles, "PowerShell", "7-preview", "pwsh.exe"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe"));
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7-preview", "pwsh.exe"));
    }
    for (const candidate of candidates) {
        if (candidate && (0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return resolveWindowsPowerShellPath();
}
function resolveSshPath() {
    const candidates = [];
    if (process.env.CODEX_SSH_PATH)
        candidates.push(process.env.CODEX_SSH_PATH);
    const whereSsh = (0, exec_1.resolveCommand)("ssh.exe") ?? (0, exec_1.resolveCommand)("ssh");
    if (whereSsh)
        candidates.push(whereSsh);
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    candidates.push(path.join(systemRoot, "System32", "OpenSSH", "ssh.exe"));
    candidates.push(path.join(systemRoot, "Sysnative", "OpenSSH", "ssh.exe"));
    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, "Git", "usr", "bin", "ssh.exe"));
        candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "ssh.exe"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "ssh.exe"));
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "ssh.exe"));
    }
    for (const candidate of candidates) {
        if (candidate && (0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return null;
}
function resolveNodePath() {
    const candidates = [];
    if (process.env.CODEX_NODE_PATH)
        candidates.push(process.env.CODEX_NODE_PATH);
    if (process.env.NVM_SYMLINK)
        candidates.push(path.join(process.env.NVM_SYMLINK, "node.exe"));
    if (process.env.ProgramFiles)
        candidates.push(path.join(process.env.ProgramFiles, "nodejs", "node.exe"));
    if (process.env["ProgramFiles(x86)"]) {
        candidates.push(path.join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe"));
    }
    const whereNode = (0, exec_1.resolveCommand)("node.exe") ?? (0, exec_1.resolveCommand)("node");
    if (whereNode)
        candidates.push(whereNode);
    for (const candidate of candidates) {
        if (candidate && (0, exec_1.fileExists)(candidate))
            return path.resolve(candidate);
    }
    return null;
}
function mergePathEntries(entries) {
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
        if (!entry)
            continue;
        const cleaned = entry.trim().replace(/^"+|"+$/g, "");
        if (!cleaned)
            continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
    }
    return out;
}
function ensureWindowsEnvironment() {
    const current = (process.env.PATH || process.env.Path || "").split(";");
    const defaults = [];
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
        defaults.push(path.join(process.env.ProgramFiles, "Git", "usr", "bin"));
    }
    if (process.env["ProgramFiles(x86)"]) {
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin"));
    }
    if (process.env.APPDATA)
        defaults.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) {
        defaults.push(path.join(process.env.LOCALAPPDATA, "fnm"));
        defaults.push(path.join(process.env.LOCALAPPDATA, "Volta", "bin"));
    }
    if (process.env.NVM_SYMLINK)
        defaults.push(process.env.NVM_SYMLINK);
    const existing = [...current, ...defaults].filter((entry) => entry && (0, exec_1.fileExists)(entry));
    const merged = mergePathEntries(existing);
    process.env.PATH = merged.join(";");
    process.env.Path = process.env.PATH;
    if (!process.env.PATHEXT) {
        process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
    }
    const cmdPath = resolveCmdPath();
    if (cmdPath)
        process.env.COMSPEC = cmdPath;
    const pwsh = resolvePwshPath();
    if (pwsh)
        process.env.CODEX_PWSH_PATH = pwsh;
    const node = resolveNodePath();
    if (node)
        process.env.CODEX_NODE_PATH = node;
}
async function ensureRipgrepInPath(workDir) {
    const existing = (0, exec_1.resolveCommand)("rg.exe") ?? (0, exec_1.resolveCommand)("rg");
    if (existing && !isWindowsRuntimeDonorExecutable(existing) && !isStalePortableExecutable(existing)) {
        return { installed: false, path: existing, source: "path" };
    }
    const donorRipgrep = existing && isWindowsRuntimeDonorExecutable(existing) ? existing : (0, windows_apps_1.getWindowsRuntimeDonorRipgrepPath)();
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
    const rgExe = portableCandidates.find((candidate) => (0, exec_1.fileExists)(candidate)) || "";
    if ((0, exec_1.fileExists)(rgExe)) {
        process.env.PATH = mergePathEntries([path.dirname(rgExe), ...(process.env.PATH || "").split(";")]).join(";");
        process.env.Path = process.env.PATH;
        return { installed: true, path: rgExe, source: "portable" };
    }
    throw new Error("rg.exe not found. Allowed sources: PATH, Windows runtime donor, repo-local work/tools/ripgrep.");
}
function runCmdCheck(cmdPath, args) {
    return (0, exec_1.runCommand)(cmdPath, ["/d", "/c", ...args], {
        capture: true,
        allowNonZero: true,
    }).status;
}
function newContractCheck(name, passed, details) {
    return { name, passed, details };
}
function invokeEnvironmentContractChecks() {
    const checks = [];
    const cmdPath = resolveCmdPath();
    checks.push(newContractCheck("cmd.exe available", Boolean(cmdPath), cmdPath || "cmd.exe not found"));
    const nodePath = resolveNodePath();
    checks.push(newContractCheck("node available in host process", Boolean(nodePath), nodePath || "node not found in current PATH"));
    const pwshPath = resolvePwshPath();
    checks.push(newContractCheck("pwsh/powershell resolver", Boolean(pwshPath), pwshPath || "pwsh and fallback powershell not found"));
    const sshPath = resolveSshPath();
    checks.push(newContractCheck("ssh client available", Boolean(sshPath), sshPath || "ssh.exe not found in current PATH or known Windows locations"));
    const rgPath = (0, exec_1.resolveCommand)("rg.exe") ?? (0, exec_1.resolveCommand)("rg");
    checks.push(newContractCheck("rg (ripgrep) available", Boolean(rgPath), rgPath || "rg not found in current PATH"));
    if (cmdPath) {
        const whereNode = runCmdCheck(cmdPath, ["where", "node"]);
        checks.push(newContractCheck("cmd where node", whereNode === 0, `exit=${whereNode}`));
        const nodeV = runCmdCheck(cmdPath, ["node", "-v"]);
        if (nodeV === 0) {
            checks.push(newContractCheck("cmd node -v", true, "exit=0 via PATH"));
        }
        else if (nodePath) {
            const nodeVByPath = runCmdCheck(cmdPath, [nodePath, "-v"]);
            checks.push(newContractCheck("cmd node -v", nodeVByPath === 0, nodeVByPath === 0 ? `exit=0 via ${nodePath}` : `exit=${nodeV} via PATH; exit=${nodeVByPath} via ${nodePath}`));
        }
        else {
            checks.push(newContractCheck("cmd node -v", false, `exit=${nodeV}`));
        }
        const wherePwsh = runCmdCheck(cmdPath, ["where", "powershell"]);
        checks.push(newContractCheck("cmd where powershell", wherePwsh === 0, `exit=${wherePwsh}`));
        const whereSsh = runCmdCheck(cmdPath, ["where", "ssh"]);
        checks.push(newContractCheck("cmd where ssh", whereSsh === 0, `exit=${whereSsh}`));
    }
    return { passed: checks.every((check) => check.passed), checks };
}
function writeEnvironmentContractSummary(result) {
    for (const check of result.checks) {
        if (check.passed)
            (0, exec_1.writeSuccess)(`[env] OK    ${check.name} :: ${check.details}`);
        else
            (0, exec_1.writeError)(`[env] FAIL  ${check.name} :: ${check.details}`);
    }
}
function assertEnvironmentContract(strict) {
    const result = invokeEnvironmentContractChecks();
    writeEnvironmentContractSummary(result);
    if (!result.passed) {
        const message = "Windows environment contract check failed.";
        if (strict)
            throw new Error(message);
        (0, exec_1.writeWarn)(`${message} Continuing in non-strict mode.`);
    }
    return result;
}
function invokeElectronChildEnvironmentContract(electronExe, workingDir, strict) {
    if (!(0, exec_1.fileExists)(electronExe)) {
        const message = "Electron child environment check skipped: electron runtime not found.";
        if (strict)
            throw new Error(message);
        (0, exec_1.writeWarn)(message);
        return false;
    }
    if (!(0, exec_1.fileExists)(workingDir)) {
        const message = "Electron child environment check skipped: working dir not found.";
        if (strict)
            throw new Error(message);
        (0, exec_1.writeWarn)(message);
        return false;
    }
    const script = String.raw `
const cp=require("node:child_process");
function run(file,args){
  const result = cp.spawnSync(file,args,{stdio:"pipe",windowsHide:true});
  if(result.error) return false;
  return result.status===0;
}
const checks=[
  ["child where node","where.exe",["node"]],
  ["child node -v","node.exe",["-v"]],
  ["child where powershell","where.exe",["powershell"]],
  ["child where ssh","where.exe",["ssh"]]
];
let ok=true;
for(const [name,file,args] of checks){
  const passed=run(file,args);
  process.stdout.write("[electron-env] "+(passed?"OK":"FAIL")+" "+name+"\\n");
  if(!passed) ok=false;
}
process.exit(ok?0:1);
`;
    const result = (0, exec_1.runCommand)(electronExe, ["-e", script], {
        cwd: workingDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        capture: false,
        allowNonZero: true,
    });
    if (result.status !== 0) {
        const message = `Electron child environment contract check failed (exit=${result.status}).`;
        if (strict)
            throw new Error(message);
        (0, exec_1.writeWarn)(message);
        return false;
    }
    return true;
}
