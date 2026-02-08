Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-CliResolveResult([string]$PreferredArch) {
  return [pscustomobject]@{
    found = $false
    path = $null
    source = $null
    preferredArch = $PreferredArch
    trace = New-Object System.Collections.Generic.List[string]
  }
}

function Add-CliTrace([object]$Result, [string]$Message) {
  if ($Result -and $Result.trace) {
    $Result.trace.Add($Message)
  }
}

function Get-NpmGlobalRoots() {
  $roots = @()
  try {
    $npmRoot = (npm root -g 2>$null).Trim()
    if ($npmRoot) { $roots += $npmRoot }
  } catch {}
  try {
    $prefix = (npm prefix -g 2>$null).Trim()
    if ($prefix) { $roots += (Join-Path $prefix "node_modules") }
  } catch {}
  if ($env:APPDATA) {
    $roots += (Join-Path $env:APPDATA "npm\node_modules")
  }
  return $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

function Find-CodexVendorExeInRoot([string]$Root, [string]$PreferredArch) {
  if (-not $Root) { return $null }
  $candidates = @(
    (Join-Path $Root "@openai\codex\vendor\$PreferredArch\codex\codex.exe"),
    (Join-Path $Root "@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe"),
    (Join-Path $Root "@openai\codex\vendor\aarch64-pc-windows-msvc\codex\codex.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Resolve-NpmShimToVendorExe([string]$ShimPath, [string]$PreferredArch, [object]$Result) {
  if (-not $ShimPath -or -not (Test-Path $ShimPath)) { return $null }
  $shimDir = Split-Path $ShimPath -Parent
  if (-not $shimDir) { return $null }

  $roots = @(
    (Join-Path $shimDir "node_modules")
  )
  $roots += Get-NpmGlobalRoots
  $roots = $roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

  foreach ($root in $roots) {
    $resolved = Find-CodexVendorExeInRoot $root $PreferredArch
    if ($resolved) {
      Add-CliTrace $Result "Resolved shim [$ShimPath] via root [$root] -> [$resolved]"
      return $resolved
    }
  }

  Add-CliTrace $Result "Shim [$ShimPath] did not resolve to vendor codex.exe"
  return $null
}

function Resolve-CodexCliPathContract(
  [string]$Explicit,
  [switch]$ThrowOnFailure
) {
  $preferredArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
  $result = New-CliResolveResult $preferredArch

  function Resolve-Candidate([string]$Candidate, [string]$Source) {
    if (-not $Candidate) { return $null }
    if (-not (Test-Path $Candidate)) {
      Add-CliTrace $result "Candidate missing [$Source] -> [$Candidate]"
      return $null
    }

    $resolved = (Resolve-Path $Candidate).Path
    $ext = [IO.Path]::GetExtension($resolved).ToLowerInvariant()

    if ($ext -eq ".exe") {
      Add-CliTrace $result "Accepted executable [$Source] -> [$resolved]"
      return $resolved
    }

    if ($ext -eq ".cmd" -or $ext -eq ".ps1" -or -not $ext) {
      Add-CliTrace $result "Candidate is shim/non-exe [$Source] -> [$resolved]"
      $shim = Resolve-NpmShimToVendorExe $resolved $preferredArch $result
      if ($shim) { return $shim }
      return $null
    }

    Add-CliTrace $result "Rejected unsupported extension [$Source] -> [$resolved]"
    return $null
  }

  if ($Explicit) {
    $resolvedExplicit = Resolve-Candidate $Explicit "explicit"
    if ($resolvedExplicit) {
      $result.found = $true
      $result.path = $resolvedExplicit
      $result.source = "explicit"
      return $result
    }
    if ($ThrowOnFailure) {
      throw "Codex CLI not found from explicit path [$Explicit]. Trace: $([string]::Join(' | ', $result.trace))"
    }
    return $result
  }

  if ($env:CODEX_CLI_PATH) {
    $resolvedEnv = Resolve-Candidate $env:CODEX_CLI_PATH "env:CODEX_CLI_PATH"
    if ($resolvedEnv) {
      $result.found = $true
      $result.path = $resolvedEnv
      $result.source = "env:CODEX_CLI_PATH"
      return $result
    }
  }

  $npmRoots = Get-NpmGlobalRoots
  foreach ($root in $npmRoots) {
    $vendorExe = Find-CodexVendorExeInRoot $root $preferredArch
    if ($vendorExe) {
      Add-CliTrace $result "Detected vendor exe in npm root [$root] -> [$vendorExe]"
      $result.found = $true
      $result.path = $vendorExe
      $result.source = "npm-vendor"
      return $result
    }
    Add-CliTrace $result "No vendor exe in npm root [$root]"
  }

  $whereCandidates = @()
  try {
    $whereCandidates += (& where.exe codex.exe 2>$null)
  } catch {}
  try {
    $whereCandidates += (& where.exe codex.cmd 2>$null)
  } catch {}
  try {
    $whereCandidates += (& where.exe codex 2>$null)
  } catch {}

  foreach ($candidate in ($whereCandidates | Where-Object { $_ } | Select-Object -Unique)) {
    $resolved = Resolve-Candidate $candidate "where"
    if ($resolved) {
      $result.found = $true
      $result.path = $resolved
      $result.source = "where"
      return $result
    }
  }

  if ($ThrowOnFailure) {
    throw "codex.exe not found. Trace: $([string]::Join(' | ', $result.trace))"
  }
  return $result
}

function Write-CliResolutionTrace([object]$Resolution, [string]$Path) {
  if (-not $Resolution -or -not $Path) { return }
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("timestampUtc=$([DateTime]::UtcNow.ToString('o'))")
  $lines.Add("found=$($Resolution.found)")
  $lines.Add("path=$($Resolution.path)")
  $lines.Add("source=$($Resolution.source)")
  $lines.Add("preferredArch=$($Resolution.preferredArch)")
  foreach ($entry in $Resolution.trace) {
    $lines.Add("trace=$entry")
  }
  $dir = Split-Path $Path -Parent
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Set-Content -Path $Path -Encoding UTF8 -Value $lines
}
