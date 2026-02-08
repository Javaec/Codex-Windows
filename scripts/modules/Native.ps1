Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-VisualStudioForNodeGyp() {
  $candidates = New-Object System.Collections.Generic.List[string]

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    try {
      $installPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
      if ($installPath) { $candidates.Add($installPath) }
    } catch {}
  }

  foreach ($edition in @("BuildTools", "Community", "Professional", "Enterprise")) {
    $path2022 = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2022\$edition"
    if (Test-Path $path2022) { $candidates.Add($path2022) }
  }

  foreach ($root in ($candidates | Select-Object -Unique)) {
    $msbuild = Join-Path $root "MSBuild\Current\Bin\MSBuild.exe"
    if (-not (Test-Path $msbuild)) { continue }
    $vcvars = Join-Path $root "VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path $vcvars)) { continue }
    return [pscustomobject]@{
      root = (Resolve-Path $root).Path
      msbuild = (Resolve-Path $msbuild).Path
      vcvars = (Resolve-Path $vcvars).Path
    }
  }

  return $null
}

function Ensure-VisualStudioForNodeGyp() {
  $vs = Resolve-VisualStudioForNodeGyp
  if (-not $vs) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      Write-Host "Visual Studio Build Tools not found. Trying to install via winget..." -ForegroundColor Yellow
      try {
        & $winget.Path install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-package-agreements --accept-source-agreements --silent --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64.Spectre" | Out-Null
      } catch {}
      $vs = Resolve-VisualStudioForNodeGyp
    }
  }

  if (-not $vs) {
    throw "Visual Studio C++ Build Tools are required for native rebuild (node-gyp). Install 'Visual Studio 2022 Build Tools' with C++ workload and rerun."
  }

  $env:GYP_MSVS_VERSION = "2022"
  $env:npm_config_msvs_version = "2022"
  Write-Host "Using Visual Studio for node-gyp: $($vs.root)" -ForegroundColor DarkGray
  return $vs
}

function Resolve-PythonForNodeGyp() {
  $candidates = New-Object System.Collections.Generic.List[string]

  if ($env:PYTHON) { $candidates.Add($env:PYTHON) }
  foreach ($name in @("python.exe", "python3.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $candidates.Add($cmd.Path) }
  }

  $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    try {
      $pyExe = (& $pyLauncher.Path -3 -c "import sys; print(sys.executable)").Trim()
      if ($pyExe) { $candidates.Add($pyExe) }
    } catch {}
  }

  $commonLocations = @(
    (Join-Path $env:LocalAppData "Programs\Python\Python312\python.exe"),
    (Join-Path $env:LocalAppData "Programs\Python\Python311\python.exe"),
    (Join-Path $env:ProgramFiles "Python312\python.exe"),
    (Join-Path $env:ProgramFiles "Python311\python.exe")
  )
  foreach ($location in $commonLocations) {
    if ($location) { $candidates.Add($location) }
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not $candidate -or -not (Test-Path $candidate)) { continue }
    try {
      & $candidate -c "import sys; print(sys.version_info[0])" | Out-Null
      if ($LASTEXITCODE -eq 0) {
        return (Resolve-Path $candidate).Path
      }
    } catch {}
  }

  return $null
}

function Ensure-PythonForNodeGyp([string]$WorkDir) {
  $python = Resolve-PythonForNodeGyp
  if (-not $python) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      Write-Host "Python not found for node-gyp. Trying to install via winget..." -ForegroundColor Yellow
      try {
        & $winget.Path install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
      } catch {}
      $python = Resolve-PythonForNodeGyp
    }
  }

  if (-not $python -and $WorkDir) {
    $toolsDir = Join-Path $WorkDir "tools"
    $pythonRoot = Join-Path $toolsDir "python"
    New-Item -ItemType Directory -Force -Path $pythonRoot | Out-Null

    $isArm64 = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64")
    $archTag = if ($isArm64) { "arm64" } else { "amd64" }
    $versions = @("3.12.8", "3.12.7", "3.12.6")
    $portablePython = $null

    foreach ($version in $versions) {
      $zipName = "python-$version-embed-$archTag.zip"
      $zipPath = Join-Path $pythonRoot $zipName
      $extractDir = Join-Path $pythonRoot "python-$version-embed-$archTag"
      $candidate = Join-Path $extractDir "python.exe"
      if (Test-Path $candidate) {
        $portablePython = $candidate
        break
      }

      $url = "https://www.python.org/ftp/python/$version/$zipName"
      Write-Host "Python not found. Trying portable Python: $url" -ForegroundColor Yellow
      try {
        if (-not (Test-Path $zipPath)) {
          Invoke-WebRequest -Uri $url -OutFile $zipPath
        }
        if (Test-Path $extractDir) {
          Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
        }
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        if (Test-Path $candidate) {
          $portablePython = $candidate
          break
        }
      } catch {
        # Try next version candidate.
      }
    }

    if ($portablePython) {
      $python = (Resolve-Path $portablePython).Path
    }
  }

  if (-not $python) {
    throw "Python 3 is required for native module rebuild (node-gyp). Install Python or allow script internet access for portable Python fallback."
  }

  $env:PYTHON = $python
  $env:npm_config_python = $python
  Write-Host "Using Python for node-gyp: $python" -ForegroundColor DarkGray
  return $python
}

function Test-ElectronRequire(
  [string]$ElectronExe,
  [string]$WorkingDir,
  [string]$RequireTarget,
  [string]$Label
) {
  if (-not (Test-Path $ElectronExe)) {
    Write-Host "${Label}: electron runtime not found at $ElectronExe" -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-Path $WorkingDir)) {
    Write-Host "${Label}: working dir not found at $WorkingDir" -ForegroundColor Yellow
    return $false
  }

  $exitCode = 1
  Push-Location $WorkingDir
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $script = "try{require('$RequireTarget');process.exit(0)}catch(e){console.error(e&&e.stack?e.stack:e);process.exit(1)}"
    & $ElectronExe -e $script | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Host "$Label failed (exit code $exitCode)." -ForegroundColor Yellow
    return $false
  }
  return $true
}

function Test-BetterSqlite3Usable(
  [string]$ElectronExe,
  [string]$WorkingDir,
  [string]$Label
) {
  if (-not (Test-Path $ElectronExe)) {
    Write-Host "${Label}: electron runtime not found at $ElectronExe" -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-Path $WorkingDir)) {
    Write-Host "${Label}: working dir not found at $WorkingDir" -ForegroundColor Yellow
    return $false
  }

  $exitCode = 1
  Push-Location $WorkingDir
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $script = @'
try {
  const Database = require('./node_modules/better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('select 1 as ok').get();
  db.close();
  process.exit(0);
} catch (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
'@
    & $ElectronExe -e $script | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Host "$Label failed (exit code $exitCode)." -ForegroundColor Yellow
    return $false
  }
  return $true
}

function Get-NativeDonorAppDirs([string]$WorkDir) {
  $dirs = New-Object System.Collections.Generic.List[string]

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Codex\resources\app"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI Codex\resources\app"),
    (Join-Path $env:LOCALAPPDATA "Programs\codex\resources\app")
  )

  $repoRoot = Split-Path $WorkDir -Parent
  if ($repoRoot) {
    $distRoot = Join-Path $repoRoot "dist"
    if (Test-Path $distRoot) {
      $distApps = Get-ChildItem -Path $distRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "resources\app" }
      $candidates += $distApps
    }
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path $candidate)) {
      $dirs.Add((Resolve-Path $candidate).Path)
    }
  }

  return $dirs
}

function Try-RecoverNativeFromDonors(
  [string]$AppDir,
  [string]$NativeDir,
  [string]$Arch,
  [string]$ElectronExe,
  [string]$WorkDir
) {
  $donors = Get-NativeDonorAppDirs $WorkDir
  if (-not $donors -or $donors.Count -eq 0) { return $false }

  $bsDstApp = Join-Path $AppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $ptyDstAppPre = Join-Path $AppDir "node_modules\node-pty\prebuilds\$Arch"
  $ptyDstAppRel = Join-Path $AppDir "node_modules\node-pty\build\Release"

  $bsDstNative = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $ptyDstNative = Join-Path $NativeDir "node_modules\node-pty\prebuilds\$Arch"

  foreach ($donorAppDir in $donors) {
    $donorBs = Join-Path $donorAppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
    if (-not (Test-Path $donorBs)) { continue }

    $donorPtyDir = Join-Path $donorAppDir "node_modules\node-pty\prebuilds\$Arch"
    if (-not (Test-Path (Join-Path $donorPtyDir "pty.node"))) {
      $donorPtyDir = Join-Path $donorAppDir "node_modules\node-pty\build\Release"
    }
    if (-not (Test-Path (Join-Path $donorPtyDir "pty.node"))) { continue }

    Write-Host "Trying native donor artifacts from: $donorAppDir" -ForegroundColor Yellow

    New-Item -ItemType Directory -Force -Path (Split-Path $bsDstApp -Parent) | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path $bsDstNative -Parent) | Out-Null
    Copy-Item -Force $donorBs $bsDstApp
    Copy-Item -Force $donorBs $bsDstNative

    New-Item -ItemType Directory -Force -Path $ptyDstAppPre | Out-Null
    New-Item -ItemType Directory -Force -Path $ptyDstAppRel | Out-Null
    New-Item -ItemType Directory -Force -Path $ptyDstNative | Out-Null
    foreach ($f in @("pty.node", "conpty.node", "conpty_console_list.node")) {
      $src = Join-Path $donorPtyDir $f
      if (-not (Test-Path $src)) { continue }
      Copy-Item -Force $src (Join-Path $ptyDstAppPre $f)
      Copy-Item -Force $src (Join-Path $ptyDstAppRel $f)
      Copy-Item -Force $src (Join-Path $ptyDstNative $f)
    }

    $betterOk = Test-BetterSqlite3Usable $ElectronExe $AppDir "App better-sqlite3 donor validation"
    $ptyOk = Test-ElectronRequire $ElectronExe $AppDir "./node_modules/node-pty" "App node-pty donor validation"
    if ($betterOk -and $ptyOk) {
      Write-Host "Recovered native modules from donor artifacts." -ForegroundColor Green
      return $true
    }
  }

  return $false
}

function Invoke-NativeStage(
  [string]$AppDir,
  [string]$NativeDir,
  [string]$ElectronVersion,
  [string]$BetterVersion,
  [string]$PtyVersion,
  [string]$Arch,
  [switch]$Reuse,
  [object]$Manifest,
  [string]$ManifestPath,
  [string]$NativeSignature
) {
  $workDir = Split-Path $NativeDir -Parent

  function Invoke-PrebuiltInstall(
    [string]$ModuleDir,
    [string]$ModuleName,
    [string]$ElectronVersion,
    [string]$NativeDir
  ) {
    if (-not (Test-Path $ModuleDir)) { return $false }
    $prebuildCli = Join-Path $NativeDir "node_modules\prebuild-install\bin.js"
    if (-not (Test-Path $prebuildCli)) {
      Write-Host "prebuild-install not found; cannot fetch prebuilt for $ModuleName." -ForegroundColor Yellow
      return $false
    }

    Write-Host "Trying prebuilt Electron binaries for $ModuleName..." -ForegroundColor Yellow
    $ok = $true
    Push-Location $ModuleDir
    try {
      & node $prebuildCli -r electron -t $ElectronVersion --tag-prefix=electron-v | Out-Null
      if ($LASTEXITCODE -ne 0) { $ok = $false }
    } catch {
      $ok = $false
    } finally {
      Pop-Location
    }
    return $ok
  }

  $bsDst = Join-Path $AppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $ptyDstPre = Join-Path $AppDir "node_modules\node-pty\prebuilds\$Arch"
  $ptyDstRel = Join-Path $AppDir "node_modules\node-pty\build\Release"
  $electronExe = Join-Path $NativeDir "node_modules\electron\dist\electron.exe"

  $appArtifactsPresent = (Test-Path $bsDst) -and ((Test-Path (Join-Path $ptyDstPre "pty.node")) -or (Test-Path (Join-Path $ptyDstRel "pty.node"))) -and (Test-Path $electronExe)
  $manifestCurrent = Test-ManifestStepCurrent -Manifest $Manifest -StepName "native" -Signature $NativeSignature
  $appPtyAnyBefore = (Test-Path (Join-Path $ptyDstPre "pty.node")) -or (Test-Path (Join-Path $ptyDstRel "pty.node"))
  $appNodePtyWasWorking = $false
  if ($appPtyAnyBefore -and (Test-Path $electronExe)) {
    $appNodePtyWasWorking = Test-ElectronRequire $electronExe $AppDir "./node_modules/node-pty" "App node-pty baseline validation"
  }

  $skipNative = $false
  if ($appArtifactsPresent) {
    $appBetterOk = Test-BetterSqlite3Usable $electronExe $AppDir "App better-sqlite3 usability test (cache)"
    $appPtyOk = Test-ElectronRequire $electronExe $AppDir "./node_modules/node-pty" "App node-pty smoke test (cache)"
    if ($appBetterOk -and $appPtyOk) {
      Write-Host "Native cache hit: reusing existing binaries and syncing them into app." -ForegroundColor Cyan
      $skipNative = $true
    } else {
      $recovered = Try-RecoverNativeFromDonors -AppDir $AppDir -NativeDir $NativeDir -Arch $Arch -ElectronExe $electronExe -WorkDir $workDir
      if ($recovered) {
        $skipNative = $true
      } else {
        Write-Host "Native cache signature matches but smoke check failed; forcing rebuild." -ForegroundColor Yellow
      }
    }
  }

  if (-not $skipNative) {
    New-Item -ItemType Directory -Force -Path $NativeDir | Out-Null
    [void](Ensure-PythonForNodeGyp -WorkDir $workDir)
    [void](Ensure-VisualStudioForNodeGyp)
    Push-Location $NativeDir
    try {
      if (-not (Test-Path (Join-Path $NativeDir "package.json"))) {
        $npmInitExit = Invoke-Npm -NpmArgs @("init", "-y")
        if ($npmInitExit -ne 0) { throw "npm init failed." }
      }

      $bsSrcProbe = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
      $ptySrcProbe = Join-Path $NativeDir "node_modules\node-pty\prebuilds\$Arch\pty.node"
      $haveNative = (Test-Path $bsSrcProbe) -and (Test-Path $ptySrcProbe) -and (Test-Path $electronExe)

      if ($haveNative) {
        $nativeBetterOk = Test-BetterSqlite3Usable $electronExe $NativeDir "Native cached better-sqlite3 usability test"
        $nativePtyOk = Test-ElectronRequire $electronExe $NativeDir "./node_modules/node-pty" "Native cached node-pty smoke test"
        $haveNative = $nativeBetterOk -and $nativePtyOk
      }

      if (-not $haveNative) {
        $deps = @(
          "better-sqlite3@$BetterVersion",
          "node-pty@$PtyVersion",
          "@electron/rebuild",
          "prebuild-install",
          "electron@$ElectronVersion"
        )
        $npmInstallExit = Invoke-Npm -NpmArgs (@("install", "--no-save") + $deps)
        if ($npmInstallExit -ne 0) { throw "npm install failed." }

        Write-Host "Rebuilding native modules for Electron $ElectronVersion..." -ForegroundColor Cyan
        $rebuildOk = $true
        $rebuildCli = Join-Path $NativeDir "node_modules\@electron\rebuild\lib\cli.js"
        if (-not (Test-Path $rebuildCli)) { throw "electron-rebuild not found." }
        & node $rebuildCli -v $ElectronVersion -w "better-sqlite3,node-pty" | Out-Host
        if ($LASTEXITCODE -ne 0) {
          $rebuildOk = $false
          Write-Host "electron-rebuild failed with exit code $LASTEXITCODE." -ForegroundColor Yellow
        }

        if (-not $rebuildOk) {
          $bsDir = Join-Path $NativeDir "node_modules\better-sqlite3"
          $ptyDir = Join-Path $NativeDir "node_modules\node-pty"
          [void](Invoke-PrebuiltInstall -ModuleDir $bsDir -ModuleName "better-sqlite3" -ElectronVersion $ElectronVersion -NativeDir $NativeDir)
          [void](Invoke-PrebuiltInstall -ModuleDir $ptyDir -ModuleName "node-pty" -ElectronVersion $ElectronVersion -NativeDir $NativeDir)
        }
      } else {
        Write-Host "Native build cache in native-builds is valid; skipping rebuild." -ForegroundColor Cyan
      }

      if (-not (Test-Path $electronExe)) { throw "electron.exe not found." }
      if (-not (Test-BetterSqlite3Usable $electronExe $NativeDir "Native better-sqlite3 usability validation")) {
        throw "better-sqlite3 failed to load from native-builds."
      }
      $nativePtyReady = Test-ElectronRequire $electronExe $NativeDir "./node_modules/node-pty" "Native node-pty validation"
      if (-not $nativePtyReady) {
        Write-Host "Native node-pty validation failed; trying to continue with existing app node-pty if available." -ForegroundColor Yellow
      }
    } finally {
      Pop-Location
    }
  } else {
    if (-not (Test-Path $electronExe)) {
      throw "electron.exe not found for cached native artifacts: $electronExe"
    }
  }

  $bsCopySkippedDueToLock = $false
  $ptyCopied = $false
  $ptyCopySkippedDueToLock = $false

  if (-not $skipNative) {
    $bsSrc = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
    if (-not (Test-Path $bsSrc)) {
      $bsPrebuild = Get-ChildItem -Path (Join-Path $NativeDir "node_modules\better-sqlite3") -Filter "better_sqlite3.node" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($bsPrebuild) { $bsSrc = $bsPrebuild.FullName }
    }
    if (-not (Test-Path $bsSrc)) { throw "better_sqlite3.node not found after native build." }

    $bsDstDir = Split-Path $bsDst -Parent
    New-Item -ItemType Directory -Force -Path $bsDstDir | Out-Null
    $bsDstFile = Join-Path $bsDstDir "better_sqlite3.node"
    try {
      Copy-Item -Force $bsSrc $bsDstFile
    } catch [System.IO.IOException] {
      if (Test-Path $bsDstFile) {
        Write-Host "better-sqlite3 artifact is currently locked; keeping existing app copy." -ForegroundColor Yellow
        $bsCopySkippedDueToLock = $true
      } else {
        throw
      }
    }

    $ptySrcDir = Join-Path $NativeDir "node_modules\node-pty\prebuilds\$Arch"
    if (-not (Test-Path (Join-Path $ptySrcDir "pty.node"))) {
      $ptyAny = Get-ChildItem -Path (Join-Path $NativeDir "node_modules\node-pty\prebuilds") -Filter "pty.node" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($ptyAny) { $ptySrcDir = Split-Path $ptyAny.FullName -Parent }
    }
    if (Test-Path (Join-Path $ptySrcDir "pty.node")) {
      New-Item -ItemType Directory -Force -Path $ptyDstPre | Out-Null
      New-Item -ItemType Directory -Force -Path $ptyDstRel | Out-Null
      foreach ($f in @("pty.node", "conpty.node", "conpty_console_list.node")) {
        $src = Join-Path $ptySrcDir $f
        if (Test-Path $src) {
          $dstPreFile = Join-Path $ptyDstPre $f
          $dstRelFile = Join-Path $ptyDstRel $f
          $copiedThisFile = $false
          try {
            Copy-Item -Force $src $dstPreFile
            $copiedThisFile = $true
          } catch [System.IO.IOException] {
            if (Test-Path $dstPreFile) {
              $ptyCopySkippedDueToLock = $true
            } else {
              throw
            }
          }
          try {
            Copy-Item -Force $src $dstRelFile
            $copiedThisFile = $true
          } catch [System.IO.IOException] {
            if (Test-Path $dstRelFile) {
              $ptyCopySkippedDueToLock = $true
            } else {
              throw
            }
          }
          if ($copiedThisFile) { $ptyCopied = $true }
        }
      }
    } elseif ($appNodePtyWasWorking) {
      Write-Host "Keeping existing app node-pty binaries because rebuild/prebuild was unavailable, but baseline app node-pty works." -ForegroundColor Yellow
    } else {
      throw "node-pty prebuilt/rebuilt binary (pty.node) not found. Install Spectre-mitigated MSVC libs or use a version with prebuilt binaries."
    }
  } else {
    Write-Host "Skip sync from native-builds in cache mode; keeping validated app native binaries." -ForegroundColor DarkGray
  }

  if (-not (Test-BetterSqlite3Usable $electronExe $AppDir "App better-sqlite3 usability validation")) {
    if ($bsCopySkippedDueToLock) {
      throw "better-sqlite3 app artifact is locked by another process and current in-app copy failed validation. Close running Codex and rerun."
    }
    throw "better-sqlite3 failed to load from app directory."
  }
  if (-not (Test-ElectronRequire $electronExe $AppDir "./node_modules/node-pty" "App node-pty validation")) {
    if ($ptyCopySkippedDueToLock) {
      throw "node-pty app artifact is locked by another process and current in-app copy failed validation. Close running Codex and rerun."
    }
    if ($appNodePtyWasWorking -and -not $ptyCopied) {
      Write-Host "App node-pty validation regressed after native step; keep previous working state by restoring app from backup or rerunning with -Reuse." -ForegroundColor Yellow
    }
    throw "node-pty failed to load from app directory."
  }

  Set-ManifestStepState -Manifest $Manifest -StepName "native" -Signature $NativeSignature -Status "ok" -Meta @{
    electronVersion = $ElectronVersion
    betterSqlite3 = $BetterVersion
    nodePty = $PtyVersion
    arch = $Arch
  }
  Write-StateManifest -Path $ManifestPath -Manifest $Manifest

  return [pscustomobject]@{
    electronExe = $electronExe
    performed = $true
  }
}
