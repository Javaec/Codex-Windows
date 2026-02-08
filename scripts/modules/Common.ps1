Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Header([string]$Text) {
  Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found."
  }
}

function Resolve-NpmCommand() {
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCmd) { return $npmCmd.Path }

  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) { return $npm.Path }

  return $null
}

function Resolve-NpxCommand() {
  $npxCmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if ($npxCmd) { return $npxCmd.Path }

  $npx = Get-Command npx -ErrorAction SilentlyContinue
  if ($npx) { return $npx.Path }

  return $null
}

function Invoke-Npm(
  [string[]]$NpmArgs,
  [switch]$PassThruOutput
) {
  $npmExe = Resolve-NpmCommand
  if (-not $npmExe) {
    throw "npm not found."
  }

  if ($PassThruOutput) {
    & $npmExe @NpmArgs | Out-Host
  } else {
    & $npmExe @NpmArgs | Out-Null
  }
  return $LASTEXITCODE
}

function Invoke-Npx(
  [string[]]$NpxArgs,
  [switch]$PassThruOutput
) {
  $npxExe = Resolve-NpxCommand
  if (-not $npxExe) {
    throw "npx not found."
  }

  if ($PassThruOutput) {
    & $npxExe @NpxArgs | Out-Host
  } else {
    & $npxExe @NpxArgs | Out-Null
  }
  return $LASTEXITCODE
}

function Escape-JsString([string]$Value) {
  if ($null -eq $Value) { return "" }
  return (($Value -replace '\\', '\\\\') -replace '"', '\"')
}

function Normalize-ProfileName([string]$ProfileName) {
  if (-not $ProfileName) { return "default" }
  $normalized = $ProfileName.Trim().ToLowerInvariant()
  if (-not $normalized) { return "default" }
  $normalized = [regex]::Replace($normalized, '[^a-z0-9._-]', '-')
  $normalized = $normalized.Trim('-', '.', '_')
  if (-not $normalized) { return "default" }
  return $normalized
}
