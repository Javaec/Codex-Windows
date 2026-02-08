Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ValidationRuntime(
  [string]$ElectronExe,
  [switch]$AllowNodeFallback
) {
  if ($ElectronExe -and (Test-Path $ElectronExe)) {
    return [pscustomobject]@{
      exe = $ElectronExe
      mode = "electron"
    }
  }

  if ($AllowNodeFallback) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node -and $node.Path) {
      return [pscustomobject]@{
        exe = $node.Path
        mode = "node"
      }
    }
  }

  return $null
}

function Test-ElectronRequire(
  [string]$ElectronExe,
  [string]$WorkingDir,
  [string]$RequireTarget,
  [string]$Label,
  [switch]$AllowNodeFallback
) {
  $runtime = Resolve-ValidationRuntime -ElectronExe $ElectronExe -AllowNodeFallback:$AllowNodeFallback
  if (-not $runtime) {
    Write-Host "${Label}: runtime not available for validation." -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-Path $WorkingDir)) {
    Write-Host "${Label}: working dir not found at $WorkingDir" -ForegroundColor Yellow
    return $false
  }

  $exitCode = 1
  Push-Location $WorkingDir
  try {
    if ($runtime.mode -eq "electron") {
      $env:ELECTRON_RUN_AS_NODE = "1"
    }
    $script = "try{require('$RequireTarget');process.exit(0)}catch(e){console.error(e&&e.stack?e.stack:e);process.exit(1)}"
    & $runtime.exe -e $script | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    if ($runtime.mode -eq "electron") {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
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
  [string]$Label,
  [switch]$AllowNodeFallback
) {
  $runtime = Resolve-ValidationRuntime -ElectronExe $ElectronExe -AllowNodeFallback:$AllowNodeFallback
  if (-not $runtime) {
    Write-Host "${Label}: runtime not available for validation." -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-Path $WorkingDir)) {
    Write-Host "${Label}: working dir not found at $WorkingDir" -ForegroundColor Yellow
    return $false
  }

  $exitCode = 1
  Push-Location $WorkingDir
  try {
    if ($runtime.mode -eq "electron") {
      $env:ELECTRON_RUN_AS_NODE = "1"
    }
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
    & $runtime.exe -e $script | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    if ($runtime.mode -eq "electron") {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Host "$Label failed (exit code $exitCode)." -ForegroundColor Yellow
    return $false
  }
  return $true
}

function Copy-NativeFile(
  [string]$SourcePath,
  [string]$DestinationPath,
  [string]$Label
) {
  New-Item -ItemType Directory -Force -Path (Split-Path $DestinationPath -Parent) | Out-Null
  try {
    Copy-Item -Force $SourcePath $DestinationPath
  } catch [System.IO.IOException] {
    if (Test-Path $DestinationPath) {
      throw "$Label is locked by another process at $DestinationPath. Close running Codex and rerun."
    }
    throw
  }
}

function Copy-NativeArtifactsFromAppLayout(
  [string]$SourceAppDir,
  [string]$AppDir,
  [string]$NativeDir,
  [string]$Arch
) {
  $bsSrc = Join-Path $SourceAppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  if (-not (Test-Path $bsSrc)) { return $false }

  $ptySrcDir = Join-Path $SourceAppDir "node_modules\node-pty\prebuilds\$Arch"
  if (-not (Test-Path (Join-Path $ptySrcDir "pty.node"))) {
    $ptySrcDir = Join-Path $SourceAppDir "node_modules\node-pty\build\Release"
  }
  if (-not (Test-Path (Join-Path $ptySrcDir "pty.node"))) { return $false }

  $bsAppDst = Join-Path $AppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $bsNativeDst = Join-Path $NativeDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  Copy-NativeFile -SourcePath $bsSrc -DestinationPath $bsAppDst -Label "better-sqlite3 app artifact"
  Copy-NativeFile -SourcePath $bsSrc -DestinationPath $bsNativeDst -Label "better-sqlite3 native cache artifact"

  foreach ($f in @("pty.node", "conpty.node", "conpty_console_list.node")) {
    $src = Join-Path $ptySrcDir $f
    if (-not (Test-Path $src)) { continue }
    Copy-NativeFile -SourcePath $src -DestinationPath (Join-Path $AppDir "node_modules\node-pty\prebuilds\$Arch\$f") -Label "node-pty app prebuild artifact"
    Copy-NativeFile -SourcePath $src -DestinationPath (Join-Path $AppDir "node_modules\node-pty\build\Release\$f") -Label "node-pty app release artifact"
    Copy-NativeFile -SourcePath $src -DestinationPath (Join-Path $NativeDir "node_modules\node-pty\prebuilds\$Arch\$f") -Label "node-pty native cache artifact"
  }

  return $true
}

function Get-NativeDonorAppDirs([string]$WorkDir) {
  $dirs = New-Object System.Collections.Generic.List[string]
  $repoRoot = Split-Path $WorkDir -Parent

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Codex\resources\app"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI Codex\resources\app"),
    (Join-Path $env:LOCALAPPDATA "Programs\codex\resources\app")
  )

  if ($repoRoot) {
    $distRoot = Join-Path $repoRoot "dist"
    if (Test-Path $distRoot) {
      $candidates += (
        Get-ChildItem -Path $distRoot -Directory -ErrorAction SilentlyContinue |
          ForEach-Object { Join-Path $_.FullName "resources\app" }
      )
    }
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path $candidate)) {
      $dirs.Add((Resolve-Path $candidate).Path)
    }
  }

  return $dirs
}

function Get-NativeSeedAppDirs(
  [string]$WorkDir,
  [string]$Arch
) {
  $dirs = New-Object System.Collections.Generic.List[string]
  $repoRoot = Split-Path $WorkDir -Parent
  if (-not $repoRoot) { return $dirs }

  $candidates = @(
    (Join-Path $repoRoot "scripts\native-seeds\$Arch\app"),
    (Join-Path $repoRoot "native-seeds\$Arch\app")
  )

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path $candidate)) {
      $dirs.Add((Resolve-Path $candidate).Path)
    }
  }

  return $dirs
}

function Ensure-ElectronRuntime(
  [string]$NativeDir,
  [string]$ElectronVersion,
  [string[]]$SourceAppDirs
) {
  $electronExe = Join-Path $NativeDir "node_modules\electron\dist\electron.exe"
  if (Test-Path $electronExe) {
    return (Resolve-Path $electronExe).Path
  }

  foreach ($sourceAppDir in $SourceAppDirs) {
    $srcDist = Join-Path $sourceAppDir "node_modules\electron\dist"
    $srcExe = Join-Path $srcDist "electron.exe"
    if (-not (Test-Path $srcExe)) { continue }

    $dstDist = Join-Path $NativeDir "node_modules\electron\dist"
    New-Item -ItemType Directory -Force -Path $dstDist | Out-Null
    & robocopy $srcDist $dstDist /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    if (Test-Path $electronExe) {
      Write-Host "Using Electron runtime from donor: $sourceAppDir" -ForegroundColor Cyan
      return (Resolve-Path $electronExe).Path
    }
  }

  New-Item -ItemType Directory -Force -Path $NativeDir | Out-Null
  Push-Location $NativeDir
  try {
    if (-not (Test-Path (Join-Path $NativeDir "package.json"))) {
      $npmInitExit = Invoke-Npm -NpmArgs @("init", "-y")
      if ($npmInitExit -ne 0) { throw "npm init failed while preparing Electron runtime." }
    }
    $npmInstallExit = Invoke-Npm -NpmArgs @("install", "--no-save", "electron@$ElectronVersion")
    if ($npmInstallExit -ne 0) {
      throw "npm install electron@$ElectronVersion failed."
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path $electronExe)) {
    throw "electron.exe not found after runtime preparation: $electronExe"
  }
  return (Resolve-Path $electronExe).Path
}

function Try-RecoverNativeFromCandidateDirs(
  [string[]]$CandidateDirs,
  [string]$CandidateKind,
  [string]$AppDir,
  [string]$NativeDir,
  [string]$Arch,
  [string]$ElectronExe
) {
  foreach ($candidate in $CandidateDirs) {
    if (-not $candidate -or -not (Test-Path $candidate)) { continue }
    $copied = Copy-NativeArtifactsFromAppLayout -SourceAppDir $candidate -AppDir $AppDir -NativeDir $NativeDir -Arch $Arch
    if (-not $copied) { continue }

    Write-Host "Trying native $CandidateKind artifacts from: $candidate" -ForegroundColor Yellow
    $betterOk = Test-BetterSqlite3Usable -ElectronExe $ElectronExe -WorkingDir $AppDir -Label "App better-sqlite3 $CandidateKind validation"
    $ptyOk = Test-ElectronRequire -ElectronExe $ElectronExe -WorkingDir $AppDir -RequireTarget "./node_modules/node-pty" -Label "App node-pty $CandidateKind validation"
    if ($betterOk -and $ptyOk) {
      Write-Host "Recovered native modules from $CandidateKind artifacts." -ForegroundColor Green
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
  $allowNativeRebuild = ($env:CODEX_ENABLE_NATIVE_REBUILD -eq "1")

  $donorDirs = Get-NativeDonorAppDirs -WorkDir $workDir
  $seedDirs = Get-NativeSeedAppDirs -WorkDir $workDir -Arch $Arch
  $electronSourceDirs = @()
  if ($donorDirs) { $electronSourceDirs += $donorDirs }
  if ($seedDirs) { $electronSourceDirs += $seedDirs }

  $electronExe = Ensure-ElectronRuntime -NativeDir $NativeDir -ElectronVersion $ElectronVersion -SourceAppDirs $electronSourceDirs

  $bsApp = Join-Path $AppDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  $ptyAppPre = Join-Path $AppDir "node_modules\node-pty\prebuilds\$Arch\pty.node"
  $ptyAppRel = Join-Path $AppDir "node_modules\node-pty\build\Release\pty.node"
  $appArtifactsPresent = (Test-Path $bsApp) -and ((Test-Path $ptyAppPre) -or (Test-Path $ptyAppRel))

  $appReady = $false
  if ($appArtifactsPresent) {
    $appBetterOk = Test-BetterSqlite3Usable -ElectronExe $electronExe -WorkingDir $AppDir -Label "App better-sqlite3 usability test (cache)"
    $appPtyOk = Test-ElectronRequire -ElectronExe $electronExe -WorkingDir $AppDir -RequireTarget "./node_modules/node-pty" -Label "App node-pty smoke test (cache)"
    if ($appBetterOk -and $appPtyOk) {
      Write-Host "Native cache hit: reusing validated app binaries." -ForegroundColor Cyan
      $appReady = $true
    }
  }

  if (-not $appReady) {
    $recoveredFromDonor = Try-RecoverNativeFromCandidateDirs -CandidateDirs $donorDirs -CandidateKind "donor" -AppDir $AppDir -NativeDir $NativeDir -Arch $Arch -ElectronExe $electronExe
    if (-not $recoveredFromDonor) {
      $recoveredFromSeed = Try-RecoverNativeFromCandidateDirs -CandidateDirs $seedDirs -CandidateKind "bundled seed" -AppDir $AppDir -NativeDir $NativeDir -Arch $Arch -ElectronExe $electronExe
      $appReady = $recoveredFromSeed
    } else {
      $appReady = $true
    }
  }

  if (-not $appReady) {
    if ($allowNativeRebuild) {
      throw "No usable native artifacts found. Rebuild path is explicitly enabled, but this script no longer performs node-gyp builds. Provide prebuilt artifacts in scripts/native-seeds/$Arch/app or donor install."
    }

    throw "No usable native artifacts found for better-sqlite3/node-pty, and native rebuild is disabled by policy. Use a donor installation or provide bundled seeds under scripts/native-seeds/$Arch/app."
  }

  if (-not (Test-BetterSqlite3Usable -ElectronExe $electronExe -WorkingDir $AppDir -Label "App better-sqlite3 usability validation")) {
    throw "better-sqlite3 failed final validation in app directory."
  }
  if (-not (Test-ElectronRequire -ElectronExe $electronExe -WorkingDir $AppDir -RequireTarget "./node_modules/node-pty" -Label "App node-pty validation")) {
    throw "node-pty failed final validation in app directory."
  }

  Set-ManifestStepState -Manifest $Manifest -StepName "native" -Signature $NativeSignature -Status "ok" -Meta @{
    electronVersion = $ElectronVersion
    betterSqlite3 = $BetterVersion
    nodePty = $PtyVersion
    arch = $Arch
    rebuildEnabled = $allowNativeRebuild
  }
  Write-StateManifest -Path $ManifestPath -Manifest $Manifest

  return [pscustomobject]@{
    electronExe = $electronExe
    performed = $true
  }
}
