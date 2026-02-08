Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-PortableLauncher(
  [string]$OutputDir,
  [string]$ProfileName
) {
  $profile = Normalize-ProfileName $ProfileName
  $isDefaultProfile = ($profile -eq "default")
  $userDataFolder = if ($isDefaultProfile) { "userdata" } else { "userdata-$profile" }
  $cacheFolder = if ($isDefaultProfile) { "cache" } else { "cache-$profile" }

  $launcherPath = Join-Path $OutputDir "Launch-Codex.cmd"
  $launcherTemplate = @'
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
set "CODEX_WINDOWS_PROFILE=__PROFILE__"
set "ELECTRON_FORCE_IS_PACKAGED=1"
set "NODE_ENV=production"

if not exist "%BASE%__USERDATA__" mkdir "%BASE%__USERDATA__" >nul 2>nul
if not exist "%BASE%__CACHE__" mkdir "%BASE%__CACHE__" >nul 2>nul

"%BASE%Codex.exe" --enable-logging --user-data-dir="%BASE%__USERDATA__" --disk-cache-dir="%BASE%__CACHE__"
exit /b %ERRORLEVEL%
'@
  $launcher = $launcherTemplate.
    Replace("__PROFILE__", $profile).
    Replace("__USERDATA__", $userDataFolder).
    Replace("__CACHE__", $cacheFolder)
  Set-Content -Path $launcherPath -Encoding Ascii -NoNewline -Value $launcher
  return $launcherPath
}

function Invoke-PortableBuild(
  [string]$DistDir,
  [string]$NativeDir,
  [string]$AppDir,
  [string]$BuildNumber,
  [string]$BuildFlavor,
  [string]$BundledCliPath,
  [string]$ProfileName
) {
  $profile = Normalize-ProfileName $ProfileName
  $isDefaultProfile = ($profile -eq "default")
  $packagerArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $electronDistDir = Join-Path $NativeDir "node_modules\electron\dist"
  if (-not (Test-Path $electronDistDir)) { throw "Electron runtime not found." }

  $outputName = if ($isDefaultProfile) { "Codex-win32-$packagerArch" } else { "Codex-win32-$packagerArch-$profile" }
  $outputDir = Join-Path $DistDir $outputName
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
  & robocopy $AppDir $appDstDir /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  $defaultAsar = Join-Path $resourcesDir "default_app.asar"
  if (Test-Path $defaultAsar) { Remove-Item -Force $defaultAsar }

  Patch-MainForWindowsEnvironment $appDstDir $BuildNumber $BuildFlavor

  if ($BundledCliPath -and (Test-Path $BundledCliPath)) {
    Write-Host "Bundling Codex CLI..." -ForegroundColor Cyan
    $cliSrcDir = Split-Path $BundledCliPath -Parent
    Copy-Item -Force $BundledCliPath (Join-Path $resourcesDir "codex.exe")
    $cliSiblings = Get-ChildItem -Path $cliSrcDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne (Split-Path $BundledCliPath -Leaf) }
    foreach ($sf in $cliSiblings) {
      Copy-Item -Force $sf.FullName (Join-Path $resourcesDir $sf.Name)
    }
  } else {
    Write-Host "codex.exe not found; portable build will rely on PATH auto-detection." -ForegroundColor Yellow
  }

  $launcherPath = Write-PortableLauncher -OutputDir $outputDir -ProfileName $profile
  return [pscustomobject]@{
    outputDir = $outputDir
    launcherPath = $launcherPath
  }
}
