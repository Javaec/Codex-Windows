[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "CodexProviderRetag"),
  [switch]$SkipPathUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Status {
  param(
    [ValidateSet("INFO", "OK", "WARN", "ERROR")]
    [string]$Level,
    [string]$Message
  )

  $color = switch ($Level) {
    "INFO" { [ConsoleColor]::Cyan }
    "OK" { [ConsoleColor]::Green }
    "WARN" { [ConsoleColor]::Yellow }
    "ERROR" { [ConsoleColor]::Red }
  }

  Write-Host ("[{0}] {1}" -f $Level, $Message) -ForegroundColor $color
}

function Add-UserPathEntry {
  param(
    [string]$PathEntry
  )

  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($current) {
    $entries = $current.Split(";", [StringSplitOptions]::RemoveEmptyEntries)
  }

  if ($entries -contains $PathEntry) {
    return
  }

  $newValue = if ($current) { "$current;$PathEntry" } else { $PathEntry }
  [Environment]::SetEnvironmentVariable("Path", $newValue, "User")
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Find-CodexBundledRipgrep {
  $candidates = @(
    (Join-Path (Get-Location) "dist\Codex-win32-x64\resources\rg.exe"),
    (Join-Path (Get-Location) "dist\Codex-win32-x64\resources\path\rg.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\resources\rg.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }

  return $null
}

function Get-SqliteToolsDownloadUrl {
  $response = Invoke-WebRequest -Uri "https://www.sqlite.org/download.html" -UseBasicParsing
  $match = [regex]::Match($response.Content, '(?<href>\d{4}/sqlite-tools-win-x64-\d+\.zip)')
  if (-not $match.Success) {
    throw "Could not locate the current sqlite-tools-win-x64 download link."
  }

  return "https://www.sqlite.org/$($match.Groups['href'].Value)"
}

Write-Status INFO "Preparing Codex provider retag helper tools."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node.exe was not found in PATH. Install Node.js first."
}
Write-Status OK "Found node at $($node.Source)"

$toolsDir = Join-Path $InstallRoot "tools"
$sqliteDir = Join-Path $toolsDir "sqlite3"
$launcherDir = Join-Path $InstallRoot "launchers"
New-Item -ItemType Directory -Path $sqliteDir -Force | Out-Null
New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null

$sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
if (-not $sqlite) {
  $zipUrl = Get-SqliteToolsDownloadUrl
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-provider-retag-" + [Guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "sqlite-tools.zip"
  $extractPath = Join-Path $tempRoot "extract"
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
  try {
    Write-Status INFO "Downloading sqlite tools from $zipUrl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Write-Status INFO "Extracting sqlite tools"
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
    $sqliteExe = Get-ChildItem -Path $extractPath -Recurse -Filter sqlite3.exe -File | Select-Object -First 1
    if (-not $sqliteExe) {
      throw "sqlite3.exe was not found inside the downloaded archive."
    }

    Copy-Item -Path $sqliteExe.FullName -Destination (Join-Path $sqliteDir "sqlite3.exe") -Force
    $sqlite = Get-Command (Join-Path $sqliteDir "sqlite3.exe") -ErrorAction SilentlyContinue
    Write-Status OK "sqlite3.exe installed to $sqliteDir"
  }
  finally {
    if (Test-Path $tempRoot) {
      Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
else {
  Write-Status OK "Found sqlite3 at $($sqlite.Source)"
}

if (-not $SkipPathUpdate) {
  Add-UserPathEntry -PathEntry $sqliteDir
  Write-Status OK "Updated user PATH with $sqliteDir"
}

$rgPath = Find-CodexBundledRipgrep
if ($rgPath) {
  Write-Status OK "Found bundled Codex rg.exe at $rgPath"
}
else {
  Write-Status WARN "Bundled Codex rg.exe was not found. The main retag tool does not require rg."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $repoRoot "Run-CodexProviderRetag.cmd"
$launcherContent = @"
@echo off
setlocal
node "%~dp0scripts\node\CodexProviderRetag.cjs" %*
exit /b %errorlevel%
"@
[System.IO.File]::WriteAllText($launcherPath, $launcherContent, [System.Text.UTF8Encoding]::new($false))
Write-Status OK "Launcher written to $launcherPath"

Write-Host ""
Write-Status INFO "Next steps:"
Write-Host "  1. Open a new terminal if PATH was updated."
Write-Host "  2. Run: node scripts\node\CodexProviderRetag.cjs"
Write-Host "     or: Run-CodexProviderRetag.cmd"
