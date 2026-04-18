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

function Write-CmdShim {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ShimPath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )

  $shim = @"
@echo off
"$TargetPath" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -LiteralPath $ShimPath -Value $shim -Encoding Ascii
}

function Test-AuthenticodeSignedBy {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $true)]
    [string]$SubjectMatch
  )

  try {
    $signature = Get-AuthenticodeSignature -FilePath $FilePath
    if ($signature.Status -ne "Valid") {
      return $false
    }

    $subject = $signature.SignerCertificate.Subject
    return $subject -like "*$SubjectMatch*"
  } catch {
    return $false
  }
}

function Get-UsablePuttyPair {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Candidates
  )

  foreach ($candidate in $Candidates) {
    if (-not $candidate.Putty -or -not $candidate.Plink) {
      continue
    }

    $puttyPath = Get-FirstExistingPath -Candidates @($candidate.Putty)
    $plinkPath = Get-FirstExistingPath -Candidates @($candidate.Plink)
    if (-not $puttyPath -or -not $plinkPath) {
      continue
    }

    if (-not (Test-AuthenticodeSignedBy -FilePath $puttyPath -SubjectMatch "Simon Tatham")) {
      continue
    }

    if (-not (Test-AuthenticodeSignedBy -FilePath $plinkPath -SubjectMatch "Simon Tatham")) {
      continue
    }

    if (-not (Test-CommandWorks -CommandPath $plinkPath -Arguments @("-V"))) {
      continue
    }

    return @{
      Putty = $puttyPath
      Plink = $plinkPath
      Source = $candidate.Source
    }
  }

  return $null
}

function Download-PuttyPortablePair {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StageDir,

    [Parameter(Mandatory = $true)]
    [string]$CurlPath
  )

  $packagePath = Join-Path $StageDir "putty.portable.nupkg"
  $extractRoot = Join-Path $StageDir "package"
  $toolsDir = Join-Path $extractRoot "tools"
  $portableDir = Join-Path $StageDir "portable"

  if (Test-Path -LiteralPath $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

  & $CurlPath "-L" "https://community.chocolatey.org/api/v2/package/putty.portable" "-o" $packagePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $packagePath)) {
    throw "Failed to download putty.portable package."
  }

  Expand-Archive -LiteralPath $packagePath -DestinationPath $extractRoot -Force
  Expand-Archive -LiteralPath (Join-Path $toolsDir "putty_x64.zip") -DestinationPath $portableDir -Force

  return @{
    Putty = Join-Path $portableDir "PUTTY.EXE"
    Plink = Join-Path $portableDir "PLINK.EXE"
    Source = "download"
  }
}

function Resolve-PuttyPair {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ToolBinDir,

    [Parameter(Mandatory = $false)]
    [string]$ProgramFilesX86
  )

  $candidates = @(
    @{
      Putty = Join-Path $ToolBinDir "putty.exe"
      Plink = Join-Path $ToolBinDir "plink.exe"
      Source = "codex-tool-bin"
    },
    @{
      Putty = $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "PuTTY\putty.exe" })
      Plink = $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "PuTTY\plink.exe" })
      Source = "program-files"
    },
    @{
      Putty = $(if ($ProgramFilesX86) { Join-Path $ProgramFilesX86 "PuTTY\putty.exe" })
      Plink = $(if ($ProgramFilesX86) { Join-Path $ProgramFilesX86 "PuTTY\plink.exe" })
      Source = "program-files-x86"
    },
    @{
      Putty = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\PuTTY\putty.exe" })
      Plink = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\PuTTY\plink.exe" })
      Source = "local-programs"
    },
    @{
      Putty = Join-Path $HOME "scoop\apps\putty\current\putty.exe"
      Plink = Join-Path $HOME "scoop\apps\putty\current\plink.exe"
      Source = "scoop"
    }
  )

  $existingPair = Get-UsablePuttyPair -Candidates $candidates
  if ($existingPair) {
    return $existingPair
  }

  $curlPath = Get-FirstExistingPath -Candidates @(
    $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "System32\curl.exe" }),
    $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "Sysnative\curl.exe" }),
    (Get-Command curl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  )

  if (-not $curlPath) {
    throw "curl.exe not found; required to download putty.portable package."
  }

  $downloadedPair = Download-PuttyPortablePair -StageDir (Join-Path $env:TEMP "codex-putty-portable") -CurlPath $curlPath
  $usableDownloadedPair = Get-UsablePuttyPair -Candidates @($downloadedPair)
  if ($usableDownloadedPair) {
    return $usableDownloadedPair
  }

  throw "Failed to provision a working signed putty/plink pair."
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
Write-CmdShim -ShimPath $sshWrapperPath -TargetPath $sshSource

$puttyPair = Resolve-PuttyPair -ToolBinDir $toolBinDir -ProgramFilesX86 $programFilesX86
$puttyTarget = Join-Path $toolBinDir "putty.exe"
$plinkTarget = Join-Path $toolBinDir "plink.exe"
if (([IO.Path]::GetFullPath($puttyPair.Putty)) -ne ([IO.Path]::GetFullPath($puttyTarget))) {
  Copy-Item -LiteralPath $puttyPair.Putty -Destination $puttyTarget -Force
}
if (([IO.Path]::GetFullPath($puttyPair.Plink)) -ne ([IO.Path]::GetFullPath($plinkTarget))) {
  Copy-Item -LiteralPath $puttyPair.Plink -Destination $plinkTarget -Force
}
if (-not (Test-AuthenticodeSignedBy -FilePath $puttyTarget -SubjectMatch "Simon Tatham")) {
  throw "putty.exe signature validation failed."
}
if (-not (Test-CommandWorks -CommandPath $plinkTarget -Arguments @("-V"))) {
  throw "plink.exe validation failed."
}

if ($env:APPDATA) {
  $pathShimDir = Join-Path $env:APPDATA "npm"
  New-Item -ItemType Directory -Path $pathShimDir -Force | Out-Null

  Write-CmdShim -ShimPath (Join-Path $pathShimDir "putty.cmd") -TargetPath $puttyTarget
  Write-CmdShim -ShimPath (Join-Path $pathShimDir "plink.cmd") -TargetPath $plinkTarget
}

Write-Host "Codex tool bin repaired."
Write-Host "toolBin=$toolBinDir"
Write-Host "rg=$rgTarget"
Write-Host "ssh=$sshWrapperPath -> $sshSource"
Write-Host "putty=$puttyTarget ($($puttyPair.Source))"
Write-Host "plink=$plinkTarget ($($puttyPair.Source))"
