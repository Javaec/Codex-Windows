Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-FirstExistingPath {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }

    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Test-CommandWorks {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CommandPath,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  try {
    & $CommandPath @Arguments *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

$setupDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $setupDir

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is required."
}

$toolBinDir = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
New-Item -ItemType Directory -Path $toolBinDir -Force | Out-Null
$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")

$rgCandidates =
  @(Get-ChildItem -Path (Join-Path $repoRoot "dist") -Filter rg.exe -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FullName -like "*\resources\path\rg.exe" -or $_.FullName -like "*\resources\rg.exe"
    } |
    Sort-Object LastWriteTimeUtc -Descending |
    ForEach-Object { $_.FullName })

$rgSource = $null
foreach ($candidate in $rgCandidates) {
  if (Test-CommandWorks -CommandPath $candidate -Arguments @("--version")) {
    $rgSource = $candidate
    break
  }
}

if (-not $rgSource) {
  throw "Working rg.exe source not found under dist."
}

$rgTarget = Join-Path $toolBinDir "rg.exe"
Copy-Item -LiteralPath $rgSource -Destination $rgTarget -Force

$sshSource = Get-FirstExistingPath -Candidates @(
  $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe" }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "Git\bin\ssh.exe" }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "Git\usr\bin\ssh.exe" }),
  $(if ($programFilesX86) { Join-Path $programFilesX86 "Git\bin\ssh.exe" }),
  $(if ($programFilesX86) { Join-Path $programFilesX86 "Git\usr\bin\ssh.exe" })
)

if (-not $sshSource) {
  throw "ssh.exe not found in known OpenSSH or Git for Windows locations."
}

$sshWrapperPath = Join-Path $toolBinDir "ssh.cmd"
$sshWrapper = @"
@echo off
"$sshSource" %*
exit /b %ERRORLEVEL%
"@
Set-Content -LiteralPath $sshWrapperPath -Value $sshWrapper -Encoding Ascii

Write-Host "Codex tool bin repaired."
Write-Host "toolBin=$toolBinDir"
Write-Host "rg=$rgTarget"
Write-Host "ssh=$sshWrapperPath -> $sshSource"
