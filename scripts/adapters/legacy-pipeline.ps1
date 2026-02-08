param(
  [ValidateSet("run", "build")]
  [string]$Mode = "run",
  [string]$DmgPath,
  [string]$WorkDir,
  [string]$DistDir,
  [string]$CodexCliPath,
  [switch]$Reuse,
  [switch]$NoLaunch,
  [switch]$BuildPortable,
  [switch]$DevProfile,
  [string]$ProfileName,
  [switch]$PersistRipgrepPath,
  [switch]$StrictContract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptsRoot = Split-Path -Parent $PSScriptRoot
$legacyScript = Join-Path $scriptsRoot "run.legacy.ps1"
if (-not (Test-Path $legacyScript)) {
  throw "Missing legacy pipeline script: $legacyScript"
}

$legacyParams = @{}

foreach ($name in @("DmgPath", "WorkDir", "DistDir", "CodexCliPath", "ProfileName")) {
  if ($PSBoundParameters.ContainsKey($name)) {
    $legacyParams[$name] = $PSBoundParameters[$name]
  }
}

foreach ($name in @("Reuse", "NoLaunch", "DevProfile", "PersistRipgrepPath", "StrictContract")) {
  if ($PSBoundParameters.ContainsKey($name)) {
    $legacyParams[$name] = [bool]$PSBoundParameters[$name]
  }
}

if ($Mode -eq "build") {
  $legacyParams["BuildPortable"] = $true
} elseif ($PSBoundParameters.ContainsKey("BuildPortable")) {
  $legacyParams["BuildPortable"] = [bool]$BuildPortable
}

& $legacyScript @legacyParams
if ($?) {
  exit 0
}

if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

exit 1
