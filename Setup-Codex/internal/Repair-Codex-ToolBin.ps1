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

function Add-UserPathEntry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Entry
  )

  $currentProcessEntries = @($env:PATH -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($currentProcessEntries -notcontains $Entry) {
    $env:PATH = "$Entry;$env:PATH"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($userEntries -contains $Entry) {
    return
  }

  $updatedUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
    $Entry
  } else {
    "$Entry;$userPath"
  }
  [Environment]::SetEnvironmentVariable("Path", $updatedUserPath, "User")
}

function Ensure-PowerShellProfilePathEntry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Entry
  )

  $profileDir = Join-Path $HOME "Documents\PowerShell"
  $profilePath = Join-Path $profileDir "Microsoft.PowerShell_profile.ps1"
  $startMarker = "# >>> codex-tool-bin >>>"
  $endMarker = "# <<< codex-tool-bin <<<"
  $escapedEntry = $Entry.Replace("'", "''")
  $managedBlock = @"
$startMarker
if (Test-Path -LiteralPath '$escapedEntry') {
  `$codexToolBin = '$escapedEntry'
  if (-not ((`$env:PATH -split ';') -contains `$codexToolBin)) {
    `$env:PATH = "`$codexToolBin;`$env:PATH"
  }
}
$endMarker
"@

  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  $existing = if (Test-Path -LiteralPath $profilePath) {
    Get-Content -LiteralPath $profilePath -Raw
  } else {
    ""
  }

  $pattern = [regex]::Escape($startMarker) + ".*?" + [regex]::Escape($endMarker)
  if ($existing -match $pattern) {
    $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $managedBlock }, "Singleline")
  } elseif ([string]::IsNullOrWhiteSpace($existing)) {
    $updated = $managedBlock
  } else {
    $updated = $existing.TrimEnd("`r", "`n") + "`r`n`r`n" + $managedBlock
  }

  Set-Content -LiteralPath $profilePath -Value $updated -Encoding Ascii
}

$setupDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $setupDir

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is required."
}

$toolBinDir = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
New-Item -ItemType Directory -Path $toolBinDir -Force | Out-Null
Add-UserPathEntry -Entry $toolBinDir
Ensure-PowerShellProfilePathEntry -Entry $toolBinDir
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

$curlSource = Get-FirstExistingPath -Candidates @(
  $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "System32\curl.exe" }),
  $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "Sysnative\curl.exe" }),
  (Get-Command curl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
)

if (-not $curlSource) {
  throw "curl.exe not found; required to download putty.portable package."
}

$puttyPackageStage = Join-Path $env:TEMP "codex-putty-portable"
$puttyPackagePath = Join-Path $puttyPackageStage "putty.portable.nupkg"
$puttyExtractRoot = Join-Path $puttyPackageStage "package"
$puttyToolsDir = Join-Path $puttyExtractRoot "tools"
$puttyPortableDir = Join-Path $puttyPackageStage "portable"

if (Test-Path -LiteralPath $puttyPackageStage) {
  Remove-Item -LiteralPath $puttyPackageStage -Recurse -Force
}
New-Item -ItemType Directory -Path $puttyPackageStage -Force | Out-Null

& $curlSource "-L" "https://community.chocolatey.org/api/v2/package/putty.portable" "-o" $puttyPackagePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $puttyPackagePath)) {
  throw "Failed to download putty.portable package."
}

Expand-Archive -LiteralPath $puttyPackagePath -DestinationPath $puttyExtractRoot -Force
Expand-Archive -LiteralPath (Join-Path $puttyToolsDir "putty_x64.zip") -DestinationPath $puttyPortableDir -Force

Copy-Item -LiteralPath (Join-Path $puttyPortableDir "PUTTY.EXE") -Destination (Join-Path $toolBinDir "putty.exe") -Force
Copy-Item -LiteralPath (Join-Path $puttyPortableDir "PLINK.EXE") -Destination (Join-Path $toolBinDir "plink.exe") -Force

if ($env:APPDATA) {
  $pathShimDir = Join-Path $env:APPDATA "npm"
  New-Item -ItemType Directory -Path $pathShimDir -Force | Out-Null

  $puttyShimPath = Join-Path $pathShimDir "putty.cmd"
  $puttyShim = @"
@echo off
"$(Join-Path $toolBinDir 'putty.exe')" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -LiteralPath $puttyShimPath -Value $puttyShim -Encoding Ascii

  $plinkShimPath = Join-Path $pathShimDir "plink.cmd"
  $plinkShim = @"
@echo off
"$(Join-Path $toolBinDir 'plink.exe')" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -LiteralPath $plinkShimPath -Value $plinkShim -Encoding Ascii
}

Write-Host "Codex tool bin repaired."
Write-Host "toolBin=$toolBinDir"
Write-Host "rg=$rgTarget"
Write-Host "ssh=$sshWrapperPath -> $sshSource"
Write-Host "putty=$(Join-Path $toolBinDir 'putty.exe')"
Write-Host "plink=$(Join-Path $toolBinDir 'plink.exe')"
