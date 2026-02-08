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
