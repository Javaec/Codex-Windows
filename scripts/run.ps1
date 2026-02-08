param(
  [string]$DmgPath,
  [string]$WorkDir = (Join-Path $PSScriptRoot "..\work"),
  [string]$DistDir = (Join-Path $PSScriptRoot "..\dist"),
  [string]$CodexCliPath,
  [switch]$Reuse,
  [switch]$NoLaunch,
  [switch]$BuildPortable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Header([string]$Text) {
  Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found."
  }
}

function Add-PathSegments(
  [System.Collections.Generic.List[string]]$Segments,
  [hashtable]$Seen,
  [string]$Value
) {
  if (-not $Value) { return }
  foreach ($part in ($Value -split ";")) {
    $expanded = [Environment]::ExpandEnvironmentVariables($part).Trim().Trim('"')
    if (-not $expanded) { continue }
    $key = $expanded.ToLowerInvariant()
    if (-not $Seen.ContainsKey($key)) {
      $Seen[$key] = $true
      $Segments.Add($expanded)
    }
  }
}

function Get-RegistryValue([string]$Path, [string]$Name) {
  try {
    $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
    return [string]$item.$Name
  } catch {
    return $null
  }
}

function Resolve-CmdPath() {
  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $candidates = @(
    (Join-Path $systemRoot "System32\cmd.exe"),
    (Join-Path $systemRoot "Sysnative\cmd.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Resolve-PwshPath() {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:CODEX_PWSH_PATH) { $candidates.Add($env:CODEX_PWSH_PATH) }
  try {
    $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($pwshCmd) { $candidates.Add($pwshCmd.Path) }
  } catch {}

  if ($env:ProgramFiles) {
    $candidates.Add((Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"))
    $candidates.Add((Join-Path $env:ProgramFiles "PowerShell\7-preview\pwsh.exe"))
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "PowerShell\7\pwsh.exe"))
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "PowerShell\7-preview\pwsh.exe"))
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Resolve-WindowsPowerShellPath() {
  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $candidate = Join-Path $systemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path $candidate) {
    return (Resolve-Path $candidate).Path
  }
  return $null
}

function Ensure-WindowsEnvironment() {
  $segments = New-Object 'System.Collections.Generic.List[string]'
  $seen = @{}

  Add-PathSegments $segments $seen $env:PATH

  $machinePath = Get-RegistryValue "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  $userPath = Get-RegistryValue "HKCU:\Environment" "Path"
  Add-PathSegments $segments $seen $machinePath
  Add-PathSegments $segments $seen $userPath

  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $defaults = @(
    $systemRoot,
    (Join-Path $systemRoot "System32"),
    (Join-Path $systemRoot "System32\Wbem"),
    (Join-Path $systemRoot "System32\WindowsPowerShell\v1.0"),
    (Join-Path $systemRoot "System32\OpenSSH")
  )
  if ($env:ProgramFiles) {
    $defaults += (Join-Path $env:ProgramFiles "PowerShell\7")
    $defaults += (Join-Path $env:ProgramFiles "nodejs")
    $defaults += (Join-Path $env:ProgramFiles "Git\cmd")
    $defaults += (Join-Path $env:ProgramFiles "Git\bin")
  }
  if (${env:ProgramFiles(x86)}) {
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "nodejs")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "Git\cmd")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "Git\bin")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "PowerShell\7")
  }
  if ($env:APPDATA) {
    $defaults += (Join-Path $env:APPDATA "npm")
  }
  if ($env:LOCALAPPDATA) {
    $defaults += (Join-Path $env:LOCALAPPDATA "fnm")
    $defaults += (Join-Path $env:LOCALAPPDATA "Volta\bin")
  }
  if ($env:NVM_SYMLINK) {
    $defaults += $env:NVM_SYMLINK
  }

  $nodeRegInstallPaths = @(
    (Get-RegistryValue "HKLM:\SOFTWARE\Node.js" "InstallPath"),
    (Get-RegistryValue "HKLM:\SOFTWARE\WOW6432Node\Node.js" "InstallPath"),
    (Get-RegistryValue "HKCU:\SOFTWARE\Node.js" "InstallPath")
  )
  foreach ($nodePath in $nodeRegInstallPaths) {
    Add-PathSegments $segments $seen $nodePath
  }
  foreach ($defaultPath in $defaults) {
    Add-PathSegments $segments $seen $defaultPath
  }

  $env:PATH = ($segments -join ";")

  if (-not $env:PATHEXT) {
    $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
  }

  $cmdPath = Resolve-CmdPath
  if ($cmdPath) {
    $env:COMSPEC = $cmdPath
  }

  $pwshPath = Resolve-PwshPath
  if ($pwshPath) {
    $env:CODEX_PWSH_PATH = $pwshPath
  } else {
    $windowsPowerShell = Resolve-WindowsPowerShellPath
    if ($windowsPowerShell) {
      $env:CODEX_PWSH_PATH = $windowsPowerShell
    }
  }
}

function Resolve-7z([string]$BaseDir) {
  $cmd = Get-Command 7z -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  $p1 = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
  $p2 = Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe"
  if (Test-Path $p1) { return $p1 }
  if (Test-Path $p2) { return $p2 }
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if ($wg) {
    & winget install --id 7zip.7zip -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
    if (Test-Path $p1) { return $p1 }
    if (Test-Path $p2) { return $p2 }
  }
  if (-not $BaseDir) { return $null }
  $tools = Join-Path $BaseDir "tools"
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $sevenZipDir = Join-Path $tools "7zip"
  New-Item -ItemType Directory -Force -Path $sevenZipDir | Out-Null
  $home = "https://www.7-zip.org/"
  try { $html = (Invoke-WebRequest -Uri $home -UseBasicParsing).Content } catch { return $null }
  $extra = [regex]::Match($html, 'href="a/(7z[0-9]+-extra\.7z)"').Groups[1].Value
  if (-not $extra) { return $null }
  $extraUrl = "https://www.7-zip.org/a/$extra"
  $sevenRUrl = "https://www.7-zip.org/a/7zr.exe"
  $sevenR = Join-Path $tools "7zr.exe"
  $extraPath = Join-Path $tools $extra
  if (-not (Test-Path $sevenR)) { Invoke-WebRequest -Uri $sevenRUrl -OutFile $sevenR }
  if (-not (Test-Path $extraPath)) { Invoke-WebRequest -Uri $extraUrl -OutFile $extraPath }
  & $sevenR x -y $extraPath -o"$sevenZipDir" | Out-Null
  $p3 = Join-Path $sevenZipDir "7z.exe"
  if (Test-Path $p3) { return $p3 }
  return $null
}

function Resolve-CodexCliPath([string]$Explicit) {
  function Get-NpmGlobalRoots() {
    $roots = @()
    try {
      $npmRoot = (npm root -g 2>$null).Trim()
      if ($npmRoot) { $roots += $npmRoot }
    } catch {}
    try {
      $prefix = (npm prefix -g 2>$null).Trim()
      if ($prefix) { $roots += (Join-Path $prefix "node_modules") }
    } catch {}
    if ($env:APPDATA) {
      $roots += (Join-Path $env:APPDATA "npm\node_modules")
    }
    $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
  }

  function Find-CodexVendorExe([string[]]$Roots, [string]$Arch) {
    foreach ($root in $Roots) {
      $archExe = Join-Path $root "@openai\codex\vendor\$Arch\codex\codex.exe"
      if (Test-Path $archExe) { return (Resolve-Path $archExe).Path }
      $x64Exe = Join-Path $root "@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe"
      if (Test-Path $x64Exe) { return (Resolve-Path $x64Exe).Path }
      $armExe = Join-Path $root "@openai\codex\vendor\aarch64-pc-windows-msvc\codex\codex.exe"
      if (Test-Path $armExe) { return (Resolve-Path $armExe).Path }
    }
    return $null
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
  $npmRoots = Get-NpmGlobalRoots
  $vendorExe = Find-CodexVendorExe $npmRoots $arch

  if ($Explicit) {
    if (Test-Path $Explicit) {
      $ext = [System.IO.Path]::GetExtension($Explicit)
      if ($ext -ne ".exe") {
        if ($vendorExe) { return $vendorExe }
      }
      return (Resolve-Path $Explicit).Path
    }
    throw "Codex CLI not found: $Explicit"
  }

  $envOverride = $env:CODEX_CLI_PATH
  if ($envOverride -and (Test-Path $envOverride)) {
    $ext = [System.IO.Path]::GetExtension($envOverride)
    if ($ext -ne ".exe") {
      if ($vendorExe) { return $vendorExe }
    }
    return (Resolve-Path $envOverride).Path
  }

  $candidates = @()

  if ($vendorExe) { $candidates += $vendorExe }
  foreach ($root in $npmRoots) {
    $candidates += (Join-Path $root "@openai\codex\vendor\$arch\codex\codex.exe")
    $candidates += (Join-Path $root "@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe")
    $candidates += (Join-Path $root "@openai\codex\vendor\aarch64-pc-windows-msvc\codex\codex.exe")
  }

  try {
    $whereExe = & where.exe codex.exe 2>$null
    if ($whereExe) { $candidates += $whereExe }
    $whereCmd = & where.exe codex 2>$null
    if ($whereCmd) { $candidates += $whereCmd }
  } catch {}

  foreach ($c in $candidates) {
    if (-not $c) { continue }
    $candidate = $c
    if (-not [System.IO.Path]::GetExtension($candidate)) {
      $exe = "$candidate.exe"
      $cmd = "$candidate.cmd"
      $ps1 = "$candidate.ps1"
      if (Test-Path $exe) { $candidate = $exe }
      elseif (Test-Path $cmd) { $candidate = $cmd }
      elseif (Test-Path $ps1) { $candidate = $ps1 }
      else { continue }
    }

    if ($candidate -match '\.(cmd|ps1)$' -and (Test-Path $candidate)) {
      if ($vendorExe) { return $vendorExe }
      continue
    }
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  return $null
}

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

function Escape-JsString([string]$Value) {
  if ($null -eq $Value) { return "" }
  return (($Value -replace '\\', '\\\\') -replace '"', '\"')
}

function Patch-MainForWindowsEnvironment([string]$AppDir, [string]$BuildNumber, [string]$BuildFlavor) {
  $mainJs = Join-Path $AppDir ".vite\build\main.js"
  if (-not (Test-Path $mainJs)) { return }
  $raw = Get-Content -Raw $mainJs
  $marker = "/* CODEX-WINDOWS-ENV-SHIM */"
  if ($raw -like "*$marker*") { return }

  $safeBuildNumber = Escape-JsString $BuildNumber
  $safeBuildFlavor = Escape-JsString $BuildFlavor

  $shimTemplate = @'
/* CODEX-WINDOWS-ENV-SHIM */
(function () {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const url = require("node:url");
    const winRoot = process.env.SystemRoot || "C:\\Windows";
    const parts = (process.env.PATH || "").split(";").filter(Boolean);
    const seen = new Set(parts.map((p) => p.toLowerCase()));
    const add = (p) => {
      if (!p) return;
      try {
        if (!fs.existsSync(p)) return;
      } catch {
        return;
      }
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        parts.unshift(p);
        seen.add(key);
      }
    };

    add(path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"));
    add(path.join(winRoot, "System32", "Wbem"));
    add(path.join(winRoot, "System32"));
    add(winRoot);
    if (process.env.ProgramFiles) {
      add(path.join(process.env.ProgramFiles, "PowerShell", "7"));
      add(path.join(process.env.ProgramFiles, "nodejs"));
    }
    if (process.env["ProgramFiles(x86)"]) {
      add(path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7"));
      add(path.join(process.env["ProgramFiles(x86)"], "nodejs"));
    }
    if (process.env.APPDATA) {
      add(path.join(process.env.APPDATA, "npm"));
    }
    process.env.PATH = parts.join(";");

    if (!process.env.COMSPEC) {
      const cmd = path.join(winRoot, "System32", "cmd.exe");
      if (fs.existsSync(cmd)) process.env.COMSPEC = cmd;
    }

    const pwshCandidates = [
      process.env.CODEX_PWSH_PATH,
      path.join(process.env.ProgramFiles || "", "PowerShell", "7", "pwsh.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "PowerShell", "7", "pwsh.exe"),
      path.join(winRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    ].filter(Boolean);
    for (const c of pwshCandidates) {
      if (fs.existsSync(c)) {
        process.env.CODEX_PWSH_PATH = c;
        break;
      }
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

function Write-PortableLauncher([string]$OutputDir) {
  $launcherPath = Join-Path $OutputDir "Launch-Codex.cmd"
  $launcher = @'
@echo off
setlocal

set "BASE=%~dp0"
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\Windows"

set "PATH=%WINROOT%\System32;%WINROOT%;%WINROOT%\System32\Wbem;%WINROOT%\System32\WindowsPowerShell\v1.0;%ProgramFiles%\PowerShell\7;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%APPDATA%\npm;%PATH%"
set "PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
set "COMSPEC=%WINROOT%\System32\cmd.exe"

if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%ProgramFiles(x86)%\PowerShell\7\pwsh.exe" set "CODEX_PWSH_PATH=%ProgramFiles(x86)%\PowerShell\7\pwsh.exe"
if not defined CODEX_PWSH_PATH if exist "%WINROOT%\System32\WindowsPowerShell\v1.0\powershell.exe" set "CODEX_PWSH_PATH=%WINROOT%\System32\WindowsPowerShell\v1.0\powershell.exe"

if exist "%BASE%resources\codex.exe" set "CODEX_CLI_PATH=%BASE%resources\codex.exe"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"

if not exist "%BASE%userdata" mkdir "%BASE%userdata" >nul 2>nul
if not exist "%BASE%cache" mkdir "%BASE%cache" >nul 2>nul

"%BASE%Codex.exe" --enable-logging --user-data-dir="%BASE%userdata" --disk-cache-dir="%BASE%cache"
exit /b %ERRORLEVEL%
'@
  Set-Content -Path $launcherPath -Encoding Ascii -NoNewline -Value $launcher
  return $launcherPath
}

Ensure-WindowsEnvironment

Ensure-Command node
Ensure-Command npm

foreach ($k in @("npm_config_runtime", "npm_config_target", "npm_config_disturl", "npm_config_arch", "npm_config_build_from_source")) {
  if (Test-Path "Env:$k") { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
}

if (-not $DmgPath) {
  $default = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "Codex.dmg"
  if (Test-Path $default) {
    $DmgPath = $default
  } else {
    $cand = Get-ChildItem -Path (Resolve-Path (Join-Path $PSScriptRoot "..")) -Filter "*.dmg" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) {
      $DmgPath = $cand.FullName
    } else {
      throw "No DMG found."
    }
  }
}

$DmgPath = (Resolve-Path $DmgPath).Path
$WorkDir = (Resolve-Path (New-Item -ItemType Directory -Force -Path $WorkDir)).Path
$DistDir = (Resolve-Path (New-Item -ItemType Directory -Force -Path $DistDir)).Path

$sevenZip = Resolve-7z $WorkDir
if (-not $sevenZip) { throw "7z not found." }

$extractedDir = Join-Path $WorkDir "extracted"
$electronDir = Join-Path $WorkDir "electron"
$appDir = Join-Path $WorkDir "app"
$nativeDir = Join-Path $WorkDir "native-builds"
$userDataDir = Join-Path $WorkDir "userdata"
$cacheDir = Join-Path $WorkDir "cache"
$electronExe = Join-Path $nativeDir "node_modules\electron\dist\electron.exe"

if (-not $Reuse) {
  Write-Header "Extracting DMG"
  New-Item -ItemType Directory -Force -Path $extractedDir | Out-Null
  & $sevenZip x -y $DmgPath -o"$extractedDir" | Out-Null

  Write-Header "Extracting app.asar"
  New-Item -ItemType Directory -Force -Path $electronDir | Out-Null
  $hfs = Join-Path $extractedDir "4.hfs"
  if (Test-Path $hfs) {
    & $sevenZip x -y $hfs "Codex Installer/Codex.app/Contents/Resources/app.asar" "Codex Installer/Codex.app/Contents/Resources/app.asar.unpacked" -o"$electronDir" | Out-Null
  } else {
    $directApp = Join-Path $extractedDir "Codex Installer\Codex.app\Contents\Resources\app.asar"
    if (-not (Test-Path $directApp)) {
      throw "app.asar not found."
    }
    $directUnpacked = Join-Path $extractedDir "Codex Installer\Codex.app\Contents\Resources\app.asar.unpacked"
    New-Item -ItemType Directory -Force -Path (Split-Path $directApp -Parent) | Out-Null
    $destBase = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources"
    New-Item -ItemType Directory -Force -Path $destBase | Out-Null
    Copy-Item -Force $directApp (Join-Path $destBase "app.asar")
    if (Test-Path $directUnpacked) {
      & robocopy $directUnpacked (Join-Path $destBase "app.asar.unpacked") /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    }
  }

  Write-Header "Unpacking app.asar"
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  $asar = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources\app.asar"
  if (-not (Test-Path $asar)) { throw "app.asar not found." }
  npm exec --yes --package @electron/asar -- asar extract $asar $appDir

  Write-Header "Syncing app.asar.unpacked"
  $unpacked = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources\app.asar.unpacked"
  if (Test-Path $unpacked) {
    & robocopy $unpacked $appDir /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  }
}

Write-Header "Patching preload"
Patch-Preload $appDir

Write-Header "Reading app metadata"
$pkgPath = Join-Path $appDir "package.json"
if (-not (Test-Path $pkgPath)) { throw "package.json not found." }
$pkg = Get-Content -Raw $pkgPath | ConvertFrom-Json
$electronVersion = $pkg.devDependencies.electron
$betterVersion = $pkg.dependencies."better-sqlite3"
$ptyVersion = $pkg.dependencies."node-pty"

if (-not $electronVersion) { throw "Electron version not found." }

$buildNumber = if ($pkg.PSObject.Properties.Name -contains "codexBuildNumber" -and $pkg.codexBuildNumber) { [string]$pkg.codexBuildNumber } else { "510" }
$buildFlavor = if ($pkg.PSObject.Properties.Name -contains "codexBuildFlavor" -and $pkg.codexBuildFlavor) { [string]$pkg.codexBuildFlavor } else { "prod" }

Write-Header "Preparing native modules"
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64" } else { "win32-x64" }
$bsDst = Join-Path $appDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
$ptyDstPre = Join-Path $appDir "node_modules\node-pty\prebuilds\$arch"
$skipNative = $NoLaunch -and $Reuse -and (Test-Path $bsDst) -and (Test-Path (Join-Path $ptyDstPre "pty.node")) -and (Test-Path $electronExe)
if ($skipNative) {
  Write-Host "Native modules already present in app. Skipping rebuild." -ForegroundColor Cyan
} else {
  New-Item -ItemType Directory -Force -Path $nativeDir | Out-Null
  Push-Location $nativeDir
  if (-not (Test-Path (Join-Path $nativeDir "package.json"))) {
    npm init -y | Out-Null
  }

  $bsSrcProbe = Join-Path $nativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $ptySrcProbe = Join-Path $nativeDir "node_modules\node-pty\prebuilds\$arch\pty.node"
  $haveNative = (Test-Path $bsSrcProbe) -and (Test-Path $ptySrcProbe) -and (Test-Path $electronExe)

  if (-not $haveNative) {
    $deps = @(
      "better-sqlite3@$betterVersion",
      "node-pty@$ptyVersion",
      "@electron/rebuild",
      "prebuild-install",
      "electron@$electronVersion"
    )
    npm install --no-save @deps
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  } else {
    Write-Host "Native modules already present. Skipping rebuild." -ForegroundColor Cyan
  }

  Write-Host "Rebuilding native modules for Electron $electronVersion..." -ForegroundColor Cyan
  $rebuildOk = $true
  if (-not $haveNative) {
    try {
      $rebuildCli = Join-Path $nativeDir "node_modules\@electron\rebuild\lib\cli.js"
      if (-not (Test-Path $rebuildCli)) { throw "electron-rebuild not found." }
      & node $rebuildCli -v $electronVersion -w "better-sqlite3,node-pty" | Out-Null
    } catch {
      $rebuildOk = $false
      Write-Host "electron-rebuild failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  if (-not $rebuildOk -and -not $haveNative) {
    Write-Host "Trying prebuilt Electron binaries for better-sqlite3..." -ForegroundColor Yellow
    $bsDir = Join-Path $nativeDir "node_modules\better-sqlite3"
    if (Test-Path $bsDir) {
      Push-Location $bsDir
      $prebuildCli = Join-Path $nativeDir "node_modules\prebuild-install\bin.js"
      if (-not (Test-Path $prebuildCli)) { throw "prebuild-install not found." }
      & node $prebuildCli -r electron -t $electronVersion --tag-prefix=electron-v | Out-Null
      Pop-Location
    }
  }

  $env:ELECTRON_RUN_AS_NODE = "1"
  if (-not (Test-Path $electronExe)) { throw "electron.exe not found." }
  if (-not (Test-Path (Join-Path $nativeDir "node_modules\better-sqlite3"))) {
    throw "better-sqlite3 not installed."
  }
  & $electronExe -e "try{require('./node_modules/better-sqlite3');process.exit(0)}catch(e){console.error(e);process.exit(1)}" | Out-Null
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 failed to load." }

  Pop-Location

  $bsSrc = Join-Path $nativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $bsDstDir = Split-Path $bsDst -Parent
  New-Item -ItemType Directory -Force -Path $bsDstDir | Out-Null
  if (-not (Test-Path $bsSrc)) { throw "better_sqlite3.node not found." }
  Copy-Item -Force $bsSrc (Join-Path $bsDstDir "better_sqlite3.node")

  $ptySrcDir = Join-Path $nativeDir "node_modules\node-pty\prebuilds\$arch"
  $ptyDstRel = Join-Path $appDir "node_modules\node-pty\build\Release"
  New-Item -ItemType Directory -Force -Path $ptyDstPre | Out-Null
  New-Item -ItemType Directory -Force -Path $ptyDstRel | Out-Null

  $ptyFiles = @("pty.node", "conpty.node", "conpty_console_list.node")
  foreach ($f in $ptyFiles) {
    $src = Join-Path $ptySrcDir $f
    if (Test-Path $src) {
      Copy-Item -Force $src (Join-Path $ptyDstPre $f)
      Copy-Item -Force $src (Join-Path $ptyDstRel $f)
    }
  }
}

Patch-MainForWindowsEnvironment $appDir $buildNumber $buildFlavor

if ($BuildPortable) {
  Write-Header "Packaging portable app"
  $packagerArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $electronDistDir = Join-Path $nativeDir "node_modules\electron\dist"
  if (-not (Test-Path $electronDistDir)) { throw "Electron runtime not found." }

  $outputDir = Join-Path $DistDir "Codex-win32-$packagerArch"
  if (Test-Path $outputDir) { Remove-Item -Recurse -Force $outputDir }
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

  Write-Host "Copying Electron runtime..." -ForegroundColor Cyan
  & robocopy $electronDistDir $outputDir /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null

  $srcExe = Join-Path $outputDir "electron.exe"
  $dstExe = Join-Path $outputDir "Codex.exe"
  if (Test-Path $srcExe) {
    Rename-Item -Path $srcExe -NewName "Codex.exe"
  } elseif (-not (Test-Path $dstExe)) {
    throw "electron.exe not found in Electron dist."
  }

  Write-Host "Copying app files..." -ForegroundColor Cyan
  $resourcesDir = Join-Path $outputDir "resources"
  New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
  $appDstDir = Join-Path $resourcesDir "app"
  & robocopy $appDir $appDstDir /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  $defaultAsar = Join-Path $resourcesDir "default_app.asar"
  if (Test-Path $defaultAsar) { Remove-Item -Force $defaultAsar }

  Patch-MainForWindowsEnvironment $appDstDir $buildNumber $buildFlavor

  Write-Header "Bundling Codex CLI"
  $cli = Resolve-CodexCliPath $CodexCliPath
  if ($cli) {
    $cliSrcDir = Split-Path $cli -Parent
    Copy-Item -Force $cli (Join-Path $resourcesDir "codex.exe")
    $cliSiblings = Get-ChildItem -Path $cliSrcDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne (Split-Path $cli -Leaf) }
    foreach ($sf in $cliSiblings) {
      Copy-Item -Force $sf.FullName (Join-Path $resourcesDir $sf.Name)
    }
    Write-Host "Bundled CLI from: $cli" -ForegroundColor Cyan
  } else {
    Write-Host "codex.exe not found; portable build will rely on PATH auto-detection." -ForegroundColor Yellow
  }

  $launcherPath = Write-PortableLauncher $outputDir

  Write-Host ""
  Write-Host "Portable build ready: $outputDir" -ForegroundColor Green
  Write-Host "Launcher: $launcherPath" -ForegroundColor Green

  if (-not $NoLaunch) {
    Write-Header "Launching portable build"
    Start-Process -FilePath $launcherPath -WorkingDirectory $outputDir -NoNewWindow -Wait
  }
  return
}

if (-not $NoLaunch) {
  Write-Header "Resolving Codex CLI"
  $cli = Resolve-CodexCliPath $CodexCliPath
  if (-not $cli) {
    throw "codex.exe not found."
  }
  Write-Host "Using Codex CLI: $cli" -ForegroundColor Cyan

  Write-Header "Launching Codex"
  Ensure-WindowsEnvironment
  Ensure-GitOnPath
  $rendererUrl = (New-Object System.Uri (Join-Path $appDir "webview\index.html")).AbsoluteUri
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:ELECTRON_RENDERER_URL = $rendererUrl
  $env:ELECTRON_FORCE_IS_PACKAGED = "1"
  $env:CODEX_BUILD_NUMBER = $buildNumber
  $env:CODEX_BUILD_FLAVOR = $buildFlavor
  $env:BUILD_FLAVOR = $buildFlavor
  $env:NODE_ENV = "production"
  $env:CODEX_CLI_PATH = $cli
  $env:PWD = $appDir

  New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

  if (-not (Test-Path $electronExe)) { throw "electron.exe not found: $electronExe" }
  Start-Process -FilePath $electronExe -ArgumentList "$appDir", "--enable-logging", "--user-data-dir=`"$userDataDir`"", "--disk-cache-dir=`"$cacheDir`"" -NoNewWindow -Wait
}
