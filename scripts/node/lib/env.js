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
exports.ensureWindowsEnvironment = ensureWindowsEnvironment;
exports.ensureRipgrepInPath = ensureRipgrepInPath;
exports.invokeEnvironmentContractChecks = invokeEnvironmentContractChecks;
exports.writeEnvironmentContractSummary = writeEnvironmentContractSummary;
exports.assertEnvironmentContract = assertEnvironmentContract;
exports.invokeElectronChildEnvironmentContract = invokeElectronChildEnvironmentContract;
const path = __importStar(require("node:path"));
const exec_1 = require("./exec");
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
    }
    if (process.env["ProgramFiles(x86)"]) {
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "cmd"));
        defaults.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin"));
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
}
async function downloadFile(url, outputPath) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed (${response.status}) for ${url}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    await Promise.resolve().then(() => __importStar(require("node:fs/promises"))).then((fsp) => fsp.writeFile(outputPath, data));
}
function addUserPathEntry(entry) {
    const pwsh = resolvePwshPath();
    if (!pwsh)
        return;
    const escaped = entry.replace(/'/g, "''");
    const script = `$entry='${escaped}';$cur=[Environment]::GetEnvironmentVariable('Path','User');if(-not $cur){$cur=''};$parts=$cur -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ };$exists=$false;foreach($p in $parts){if($p.ToLowerInvariant() -eq $entry.ToLowerInvariant()){$exists=$true;break}};if(-not $exists){$new=if($cur){$cur+';'+$entry}else{$entry};[Environment]::SetEnvironmentVariable('Path',$new,'User')}`;
    (0, exec_1.runCommand)(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        allowNonZero: true,
        capture: true,
    });
}
async function ensureRipgrepInPath(workDir, persistUserPath) {
    const existing = (0, exec_1.resolveCommand)("rg.exe") ?? (0, exec_1.resolveCommand)("rg");
    if (existing)
        return { installed: false, path: existing, source: "path" };
    const winget = (0, exec_1.resolveCommand)("winget.exe") ?? (0, exec_1.resolveCommand)("winget");
    if (winget) {
        (0, exec_1.runCommand)(winget, [
            "install",
            "--id",
            "BurntSushi.ripgrep",
            "-e",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--silent",
        ], { allowNonZero: true, capture: true });
        ensureWindowsEnvironment();
        const afterWinget = (0, exec_1.resolveCommand)("rg.exe") ?? (0, exec_1.resolveCommand)("rg");
        if (afterWinget)
            return { installed: true, path: afterWinget, source: "winget" };
    }
    const toolsDir = (0, exec_1.ensureDir)(path.join(workDir, "tools"));
    const rgRoot = (0, exec_1.ensureDir)(path.join(toolsDir, "ripgrep"));
    const version = "14.1.1";
    const zipName = `ripgrep-${version}-x86_64-pc-windows-msvc.zip`;
    const zipPath = path.join(rgRoot, zipName);
    const extractDir = path.join(rgRoot, `ripgrep-${version}-x86_64-pc-windows-msvc`);
    const rgExe = path.join(extractDir, "rg.exe");
    if (!(0, exec_1.fileExists)(rgExe)) {
        if (!(0, exec_1.fileExists)(zipPath)) {
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${zipName}`;
            await downloadFile(url, zipPath);
        }
        const pwsh = resolvePwshPath();
        if (!pwsh)
            return { installed: false, path: null, source: "unavailable" };
        (0, exec_1.runCommand)(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${rgRoot.replace(/'/g, "''")}' -Force`], { capture: true, allowNonZero: false });
    }
    if ((0, exec_1.fileExists)(rgExe)) {
        process.env.PATH = mergePathEntries([extractDir, ...(process.env.PATH || "").split(";")]).join(";");
        process.env.Path = process.env.PATH;
        if (persistUserPath)
            addUserPathEntry(extractDir);
        return { installed: true, path: rgExe, source: "portable" };
    }
    return { installed: false, path: null, source: "unavailable" };
}
function runCmdCheck(cmdPath, command) {
    return (0, exec_1.runCommand)(cmdPath, ["/d", "/s", "/c", command], {
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
    const nodePath = (0, exec_1.resolveCommand)("node.exe") ?? (0, exec_1.resolveCommand)("node");
    checks.push(newContractCheck("node available in host process", Boolean(nodePath), nodePath || "node not found in current PATH"));
    const pwshPath = resolvePwshPath();
    checks.push(newContractCheck("pwsh/powershell resolver", Boolean(pwshPath), pwshPath || "pwsh and fallback powershell not found"));
    const rgPath = (0, exec_1.resolveCommand)("rg.exe") ?? (0, exec_1.resolveCommand)("rg");
    checks.push(newContractCheck("rg (ripgrep) available", Boolean(rgPath), rgPath || "rg not found in current PATH"));
    if (cmdPath) {
        const whereNode = runCmdCheck(cmdPath, "where node");
        checks.push(newContractCheck("cmd where node", whereNode === 0, `exit=${whereNode}`));
        const nodeV = runCmdCheck(cmdPath, "node -v");
        checks.push(newContractCheck("cmd node -v", nodeV === 0, `exit=${nodeV}`));
        const wherePwsh = runCmdCheck(cmdPath, "where powershell");
        checks.push(newContractCheck("cmd where powershell", wherePwsh === 0, `exit=${wherePwsh}`));
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
const cp=require('node:child_process');
function run(command){
  try{
    cp.execSync(command,{stdio:'pipe'});
    return true;
  }catch{
    return false;
  }
}
const checks=[
  ['child cmd where node','cmd.exe /d /s /c "where node"'],
  ['child cmd node -v','cmd.exe /d /s /c "node -v"'],
  ['child cmd where powershell','cmd.exe /d /s /c "where powershell"']
];
let ok=true;
for(const [name,cmd] of checks){
  const passed=run(cmd);
  process.stdout.write('[electron-env] '+(passed?'OK':'FAIL')+' '+name+'\\n');
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
