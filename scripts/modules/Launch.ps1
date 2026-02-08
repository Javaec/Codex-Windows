Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Ensure-GitOnPath() {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Git\cmd\git.exe"),
    (Join-Path $env:ProgramFiles "Git\bin\git.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Git\bin\git.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }
  if (-not $candidates -or $candidates.Count -eq 0) { return }
  $gitDir = Split-Path $candidates[0] -Parent
  if ($env:PATH -notlike "*$gitDir*") {
    $env:PATH = "$gitDir;$env:PATH"
  }
}

function Patch-Preload([string]$AppDir) {
  $preload = Join-Path $AppDir ".vite\build\preload.js"
  if (-not (Test-Path $preload)) { return }
  $raw = Get-Content -Raw $preload
  $processExpose = 'const P={env:process.env,platform:process.platform,versions:process.versions,arch:process.arch,cwd:()=>process.env.PWD,argv:process.argv,pid:process.pid};n.contextBridge.exposeInMainWorld("process",P);'
  if ($raw -notlike "*$processExpose*") {
    $re = 'n\.contextBridge\.exposeInMainWorld\("codexWindowType",[A-Za-z0-9_$]+\);n\.contextBridge\.exposeInMainWorld\("electronBridge",[A-Za-z0-9_$]+\);'
    $m = [regex]::Match($raw, $re)
    if (-not $m.Success) { throw "preload patch point not found." }
    $raw = $raw.Replace($m.Value, "$processExpose$m")
    Set-Content -NoNewline -Path $preload -Value $raw
  }
}

function Patch-MainForWindowsEnvironment([string]$AppDir, [string]$BuildNumber, [string]$BuildFlavor) {
  $mainJs = Join-Path $AppDir ".vite\build\main.js"
  if (-not (Test-Path $mainJs)) { return }
  $raw = Get-Content -Raw $mainJs
  $raw = [regex]::Replace($raw, '(?s)/\* CODEX-WINDOWS-ENV-SHIM-V[234] \*/.*?\}\)\;\s*', '', 1)
  $marker = "/* CODEX-WINDOWS-ENV-SHIM-V4 */"
  if ($raw -like "*$marker*") {
    Set-Content -NoNewline -Path $mainJs -Value $raw
    return
  }

  $safeBuildNumber = Escape-JsString $BuildNumber
  $safeBuildFlavor = Escape-JsString $BuildFlavor

  $shimTemplate = @'
/* CODEX-WINDOWS-ENV-SHIM-V4 */
(function () {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const url = require("node:url");
    const cp = require("node:child_process");
    const winRoot = process.env.SystemRoot || "C:\\Windows";

    function normalizePathEnv(baseEnv) {
      const env = Object.assign({}, process.env, baseEnv || {});
      const parts = [];
      const seen = new Set();

      const include = (candidate, prepend) => {
        if (!candidate || typeof candidate !== "string") return;
        const value = candidate.trim().replace(/^"+|"+$/g, "");
        if (!value) return;
        let exists = false;
        try {
          exists = fs.existsSync(value);
        } catch {
          exists = false;
        }
        if (!exists) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (prepend) parts.unshift(value);
        else parts.push(value);
      };

      const includeList = (value, prepend) => {
        if (!value || typeof value !== "string") return;
        for (const p of value.split(";")) include(p, prepend);
      };

      includeList(env.PATH, false);
      includeList(env.Path, false);
      includeList(process.env.PATH, false);
      includeList(process.env.Path, false);

      const preferred = [
        path.join(winRoot, "System32"),
        path.join(winRoot, "System32", "Wbem"),
        path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
        path.join(winRoot, "System32", "OpenSSH"),
        winRoot,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "PowerShell", "7") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "cmd") : "",
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin") : "",
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7") : "",
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : "",
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "cmd") : "",
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin") : "",
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "",
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "fnm") : "",
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Volta", "bin") : "",
        process.env.NVM_SYMLINK || ""
      ];
      for (const p of preferred) include(p, true);

      const fullPath = parts.join(";");
      env.PATH = fullPath;
      env.Path = fullPath;

      if (!env.PATHEXT) {
        env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
      }

      if (!env.COMSPEC) {
        const cmd = path.join(winRoot, "System32", "cmd.exe");
        if (fs.existsSync(cmd)) env.COMSPEC = cmd;
      }

      const pwshCandidates = [
        env.CODEX_PWSH_PATH,
        process.env.CODEX_PWSH_PATH,
        path.join(process.env.ProgramFiles || "", "PowerShell", "7", "pwsh.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "", "PowerShell", "7", "pwsh.exe"),
        path.join(winRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      ].filter(Boolean);
      for (const c of pwshCandidates) {
        if (fs.existsSync(c)) {
          env.CODEX_PWSH_PATH = c;
          break;
        }
      }

      return env;
    }

    const normalizedProcessEnv = normalizePathEnv(process.env);
    for (const [k, v] of Object.entries(normalizedProcessEnv)) {
      if (typeof v === "string") process.env[k] = v;
    }

    if (!globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__) {
      globalThis.__CODEX_WINDOWS_CHILD_ENV_PATCHED__ = true;

      const patchOptionsEnv = (options) => {
        if (!options || typeof options !== "object") options = {};
        options.env = normalizePathEnv(options.env || process.env);
        return options;
      };

      const origSpawn = cp.spawn;
      cp.spawn = function patchedSpawn(file, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        return origSpawn.call(this, file, args, options);
      };

      const origSpawnSync = cp.spawnSync;
      cp.spawnSync = function patchedSpawnSync(file, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        return origSpawnSync.call(this, file, args, options);
      };

      const origExec = cp.exec;
      cp.exec = function patchedExec(command, options, callback) {
        if (typeof options === "function") {
          callback = options;
          options = {};
        }
        options = patchOptionsEnv(options);
        if (typeof callback === "function") {
          return origExec.call(this, command, options, callback);
        }
        return origExec.call(this, command, options);
      };

      const origExecSync = cp.execSync;
      cp.execSync = function patchedExecSync(command, options) {
        options = patchOptionsEnv(options);
        return origExecSync.call(this, command, options);
      };

      const origExecFile = cp.execFile;
      cp.execFile = function patchedExecFile(file, args, options, callback) {
        if (typeof args === "function") {
          callback = args;
          args = [];
          options = {};
        } else if (!Array.isArray(args)) {
          callback = options;
          options = args;
          args = [];
        }
        if (typeof options === "function") {
          callback = options;
          options = {};
        }
        options = patchOptionsEnv(options);
        if (typeof callback === "function") {
          return origExecFile.call(this, file, args, options, callback);
        }
        return origExecFile.call(this, file, args, options);
      };

      const origExecFileSync = cp.execFileSync;
      cp.execFileSync = function patchedExecFileSync(file, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        return origExecFileSync.call(this, file, args, options);
      };

      const origFork = cp.fork;
      cp.fork = function patchedFork(modulePath, args, options) {
        if (!Array.isArray(args)) {
          options = args;
          args = [];
        }
        options = patchOptionsEnv(options);
        return origFork.call(this, modulePath, args, options);
      };
    }

    if (!process.env.ELECTRON_RENDERER_URL) {
      const unpacked = path.join(__dirname, "..", "..", "webview", "index.html");
      const packaged = path.join(process.resourcesPath || path.join(__dirname, "..", "..", ".."), "app", "webview", "index.html");
      const chosen = fs.existsSync(unpacked) ? unpacked : (fs.existsSync(packaged) ? packaged : null);
      if (chosen) {
        process.env.ELECTRON_RENDERER_URL = url.pathToFileURL(chosen).toString();
      }
    }
    if (!process.env.ELECTRON_FORCE_IS_PACKAGED) process.env.ELECTRON_FORCE_IS_PACKAGED = "1";
    if (!process.env.CODEX_BUILD_NUMBER) process.env.CODEX_BUILD_NUMBER = "__BUILD_NUMBER__";
    if (!process.env.CODEX_BUILD_FLAVOR) process.env.CODEX_BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.BUILD_FLAVOR) process.env.BUILD_FLAVOR = "__BUILD_FLAVOR__";
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
  } catch {
    // no-op
  }
})();
'@

  $shim = $shimTemplate.Replace("__BUILD_NUMBER__", $safeBuildNumber).Replace("__BUILD_FLAVOR__", $safeBuildFlavor)
  $raw = $shim + "`n" + $raw
  Set-Content -NoNewline -Path $mainJs -Value $raw
}

function Start-CodexDirectLaunch(
  [string]$ElectronExe,
  [string]$AppDir,
  [string]$UserDataDir,
  [string]$CacheDir,
  [string]$CodexCliPath,
  [string]$BuildNumber,
  [string]$BuildFlavor
) {
  if (-not (Test-Path $ElectronExe)) {
    throw "electron.exe not found: $ElectronExe"
  }

  $rendererUrl = (New-Object System.Uri (Join-Path $AppDir "webview\index.html")).AbsoluteUri
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:ELECTRON_RENDERER_URL = $rendererUrl
  $env:ELECTRON_FORCE_IS_PACKAGED = "1"
  $env:CODEX_BUILD_NUMBER = $BuildNumber
  $env:CODEX_BUILD_FLAVOR = $BuildFlavor
  $env:BUILD_FLAVOR = $BuildFlavor
  $env:NODE_ENV = "production"
  $env:CODEX_CLI_PATH = $CodexCliPath
  $env:PWD = $AppDir

  New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

  Start-Process -FilePath $ElectronExe -ArgumentList "$AppDir", "--enable-logging", "--user-data-dir=`"$UserDataDir`"", "--disk-cache-dir=`"$CacheDir`"" -NoNewWindow -Wait
}
