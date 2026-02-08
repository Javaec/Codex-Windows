param(
  [string]$DmgPath,
  [string]$WorkDir = (Join-Path $PSScriptRoot "..\work"),
  [string]$DistDir = (Join-Path $PSScriptRoot "..\dist"),
  [string]$CodexCliPath,
  [switch]$Reuse,
  [switch]$NoLaunch,
  [switch]$BuildPortable,
  [switch]$DevProfile,
  [string]$ProfileName = "default",
  [switch]$StrictContract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$moduleRoot = Join-Path $PSScriptRoot "modules"
$requiredModules = @(
  "Common.ps1",
  "Environment.ps1",
  "Manifest.ps1",
  "CliResolver.ps1",
  "Extract.ps1",
  "Native.ps1",
  "Launch.ps1",
  "Portable.ps1"
)
foreach ($moduleName in $requiredModules) {
  $path = Join-Path $moduleRoot $moduleName
  if (-not (Test-Path $path)) {
    throw "Missing module: $path"
  }
  . $path
}

Ensure-WindowsEnvironment
Ensure-Command node
Ensure-Command npm

foreach ($k in @("npm_config_runtime", "npm_config_target", "npm_config_disturl", "npm_config_arch", "npm_config_build_from_source")) {
  if (Test-Path "Env:$k") { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedDmgPath = Resolve-DmgPath -Explicit $DmgPath -RepoRoot $repoRoot
$WorkDir = (Resolve-Path (New-Item -ItemType Directory -Force -Path $WorkDir)).Path
$DistDir = (Resolve-Path (New-Item -ItemType Directory -Force -Path $DistDir)).Path

$effectiveProfile = Normalize-ProfileName $ProfileName
if ($DevProfile -and $effectiveProfile -eq "default") {
  $effectiveProfile = "dev"
}
$isDefaultProfile = ($effectiveProfile -eq "default")
$env:CODEX_WINDOWS_PROFILE = $effectiveProfile

$manifestFileName = if ($isDefaultProfile) { "state.manifest.json" } else { "state.manifest.$effectiveProfile.json" }
$manifestPath = Join-Path $WorkDir $manifestFileName
$manifest = Read-StateManifest -Path $manifestPath

$dmgDescriptor = Get-FileDescriptorWithCache -Path $resolvedDmgPath -PreviousDescriptor $manifest.dmg
$manifest.dmg = $dmgDescriptor
Write-StateManifest -Path $manifestPath -Manifest $manifest

$extractSignature = Get-StepSignature @{
  dmgSha256 = $dmgDescriptor.sha256
}

$extractResult = Invoke-ExtractionStage `
  -DmgPath $resolvedDmgPath `
  -WorkDir $WorkDir `
  -Reuse:$Reuse `
  -Manifest $manifest `
  -ManifestPath $manifestPath `
  -ExtractSignature $extractSignature

$appDir = $extractResult.appDir
$nativeDir = Join-Path $WorkDir "native-builds"
$userDataDir = if ($isDefaultProfile) { Join-Path $WorkDir "userdata" } else { Join-Path $WorkDir "userdata-$effectiveProfile" }
$cacheDir = if ($isDefaultProfile) { Join-Path $WorkDir "cache" } else { Join-Path $WorkDir "cache-$effectiveProfile" }

Write-Header "Patching preload"
Patch-Preload $appDir

Write-Header "Reading app metadata"
$pkgPath = Join-Path $appDir "package.json"
if (-not (Test-Path $pkgPath)) { throw "package.json not found." }
$pkg = Get-Content -Raw $pkgPath | ConvertFrom-Json
$electronVersion = [string]$pkg.devDependencies.electron
$betterVersion = [string]$pkg.dependencies."better-sqlite3"
$ptyVersion = [string]$pkg.dependencies."node-pty"
if (-not $electronVersion) { throw "Electron version not found." }

$buildNumber = if ($pkg.PSObject.Properties.Name -contains "codexBuildNumber" -and $pkg.codexBuildNumber) { [string]$pkg.codexBuildNumber } else { "510" }
$buildFlavor = if ($pkg.PSObject.Properties.Name -contains "codexBuildFlavor" -and $pkg.codexBuildFlavor) { [string]$pkg.codexBuildFlavor } else { "prod" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win32-arm64" } else { "win32-x64" }

$nativeSignature = Get-StepSignature @{
  dmgSha256 = $dmgDescriptor.sha256
  electron = $electronVersion
  betterSqlite3 = $betterVersion
  nodePty = $ptyVersion
  arch = $arch
}

Write-Header "Preparing native modules"
$nativeOutput = Invoke-NativeStage `
  -AppDir $appDir `
  -NativeDir $nativeDir `
  -ElectronVersion $electronVersion `
  -BetterVersion $betterVersion `
  -PtyVersion $ptyVersion `
  -Arch $arch `
  -Reuse:$Reuse `
  -Manifest $manifest `
  -ManifestPath $manifestPath `
  -NativeSignature $nativeSignature

$nativeResult = $nativeOutput | Where-Object {
  $_ -and
  $_.PSObject -and
  ($_.PSObject.Properties.Name -contains "electronExe")
} | Select-Object -Last 1
if (-not $nativeResult) {
  throw "Native stage did not return a valid result object (missing electronExe)."
}

$electronExe = $nativeResult.electronExe

Patch-MainForWindowsEnvironment $appDir $buildNumber $buildFlavor

Write-Header "Environment contract checks"
Assert-EnvironmentContract -Strict:$StrictContract | Out-Null

$diagDir = Join-Path $WorkDir "diagnostics\$effectiveProfile"
$cliTracePath = Join-Path $diagDir "cli-resolution.log"

if ($BuildPortable) {
  Write-Header "Resolving Codex CLI"
  $cliResolution = Resolve-CodexCliPathContract -Explicit $CodexCliPath
  Write-CliResolutionTrace -Resolution $cliResolution -Path $cliTracePath
  if ($cliResolution.found) {
    Write-Host "Using Codex CLI: $($cliResolution.path) (source=$($cliResolution.source))" -ForegroundColor Cyan
  } else {
    Write-Host "codex.exe not found; portable build will rely on runtime PATH detection." -ForegroundColor Yellow
  }

  Write-Header "Packaging portable app"
  $portable = Invoke-PortableBuild `
    -DistDir $DistDir `
    -NativeDir $nativeDir `
    -AppDir $appDir `
    -BuildNumber $buildNumber `
    -BuildFlavor $buildFlavor `
    -BundledCliPath $cliResolution.path `
    -ProfileName $effectiveProfile

  Write-Host ""
  Write-Host "Portable build ready: $($portable.outputDir)" -ForegroundColor Green
  Write-Host "Launcher: $($portable.launcherPath)" -ForegroundColor Green
  Write-Host "CLI trace: $cliTracePath" -ForegroundColor DarkGray

  if (-not $NoLaunch) {
    Write-Header "Launching portable build"
    Start-Process -FilePath $portable.launcherPath -WorkingDirectory $portable.outputDir -NoNewWindow -Wait
  }
  return
}

if (-not $NoLaunch) {
  Write-Header "Resolving Codex CLI"
  $cliResolution = Resolve-CodexCliPathContract -Explicit $CodexCliPath -ThrowOnFailure
  Write-CliResolutionTrace -Resolution $cliResolution -Path $cliTracePath
  Write-Host "Using Codex CLI: $($cliResolution.path) (source=$($cliResolution.source))" -ForegroundColor Cyan

  Ensure-GitOnPath
  Write-Header "Electron child-process environment check"
  Invoke-ElectronChildEnvironmentContract -ElectronExe $electronExe -WorkingDir $appDir -Strict:$StrictContract | Out-Null

  Write-Header "Launching Codex"
  Start-CodexDirectLaunch `
    -ElectronExe $electronExe `
    -AppDir $appDir `
    -UserDataDir $userDataDir `
    -CacheDir $cacheDir `
    -CodexCliPath $cliResolution.path `
    -BuildNumber $buildNumber `
    -BuildFlavor $buildFlavor
} else {
  $cliResolution = Resolve-CodexCliPathContract -Explicit $CodexCliPath
  Write-CliResolutionTrace -Resolution $cliResolution -Path $cliTracePath
}
