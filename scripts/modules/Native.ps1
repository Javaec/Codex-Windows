Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
  if ($manifestCurrent -and $appArtifactsPresent) {
    $appBetterOk = Test-ElectronRequire $electronExe $AppDir "./node_modules/better-sqlite3" "App better-sqlite3 smoke test (cache)"
    $appPtyOk = Test-ElectronRequire $electronExe $AppDir "./node_modules/node-pty" "App node-pty smoke test (cache)"
    if ($appBetterOk -and $appPtyOk) {
      Write-Host "Native cache hit: reusing existing binaries and syncing them into app." -ForegroundColor Cyan
      $skipNative = $true
    } else {
      Write-Host "Native cache signature matches but smoke check failed; forcing rebuild." -ForegroundColor Yellow
    }
  }

  if (-not $skipNative) {
    New-Item -ItemType Directory -Force -Path $NativeDir | Out-Null
    Push-Location $NativeDir
    try {
      if (-not (Test-Path (Join-Path $NativeDir "package.json"))) {
        $npmInitExit = Invoke-Npm -Args @("init", "-y")
        if ($npmInitExit -ne 0) { throw "npm init failed." }
      }

      $bsSrcProbe = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
      $ptySrcProbe = Join-Path $NativeDir "node_modules\node-pty\prebuilds\$Arch\pty.node"
      $haveNative = (Test-Path $bsSrcProbe) -and (Test-Path $ptySrcProbe) -and (Test-Path $electronExe) -and $manifestCurrent

      if ($haveNative) {
        $nativeBetterOk = Test-ElectronRequire $electronExe $NativeDir "./node_modules/better-sqlite3" "Native cached better-sqlite3 smoke test"
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
        $npmInstallExit = Invoke-Npm -Args (@("install", "--no-save") + $deps)
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
      if (-not (Test-ElectronRequire $electronExe $NativeDir "./node_modules/better-sqlite3" "Native better-sqlite3 validation")) {
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

  $bsSrc = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  if (-not (Test-Path $bsSrc)) {
    $bsPrebuild = Get-ChildItem -Path (Join-Path $NativeDir "node_modules\better-sqlite3") -Filter "better_sqlite3.node" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bsPrebuild) { $bsSrc = $bsPrebuild.FullName }
  }
  if (-not (Test-Path $bsSrc)) { throw "better_sqlite3.node not found after native build." }

  $bsDstDir = Split-Path $bsDst -Parent
  New-Item -ItemType Directory -Force -Path $bsDstDir | Out-Null
  $bsDstFile = Join-Path $bsDstDir "better_sqlite3.node"
  $bsCopySkippedDueToLock = $false
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

  $ptyCopied = $false
  $ptyCopySkippedDueToLock = $false
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

  if (-not (Test-ElectronRequire $electronExe $AppDir "./node_modules/better-sqlite3" "App better-sqlite3 validation")) {
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
