Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-EmptyStateManifest() {
  return [pscustomobject]@{
    schemaVersion = 1
    updatedAtUtc = [DateTime]::UtcNow.ToString("o")
    dmg = $null
    steps = [pscustomobject]@{
      extract = $null
      native = $null
    }
  }
}

function Read-StateManifest([string]$Path) {
  if (-not $Path -or -not (Test-Path $Path)) {
    return (New-EmptyStateManifest)
  }
  try {
    $loaded = Get-Content -Raw $Path | ConvertFrom-Json
    if (-not $loaded.steps) {
      $loaded | Add-Member -MemberType NoteProperty -Name steps -Value ([pscustomobject]@{
        extract = $null
        native = $null
      })
    }
    if (-not ($loaded.steps.PSObject.Properties.Name -contains "extract")) {
      $loaded.steps | Add-Member -MemberType NoteProperty -Name extract -Value $null
    }
    if (-not ($loaded.steps.PSObject.Properties.Name -contains "native")) {
      $loaded.steps | Add-Member -MemberType NoteProperty -Name native -Value $null
    }
    return $loaded
  } catch {
    return (New-EmptyStateManifest)
  }
}

function Write-StateManifest([string]$Path, [object]$Manifest) {
  if (-not $Path -or -not $Manifest) { return }
  $Manifest.updatedAtUtc = [DateTime]::UtcNow.ToString("o")
  $dir = Split-Path $Path -Parent
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $Manifest | ConvertTo-Json -Depth 12 | Set-Content -Path $Path -Encoding UTF8
}

function Get-FileDescriptorWithCache([string]$Path, [object]$PreviousDescriptor) {
  if (-not (Test-Path $Path)) { throw "File not found: $Path" }
  $item = Get-Item -Path $Path
  $size = [int64]$item.Length
  $lastWriteUtc = ([DateTime]$item.LastWriteTimeUtc).ToString("o")

  $hash = $null
  if ($PreviousDescriptor -and
      ($PreviousDescriptor.PSObject.Properties.Name -contains "size") -and
      ($PreviousDescriptor.PSObject.Properties.Name -contains "lastWriteUtc") -and
      ($PreviousDescriptor.PSObject.Properties.Name -contains "sha256") -and
      [int64]$PreviousDescriptor.size -eq $size -and
      [string]$PreviousDescriptor.lastWriteUtc -eq $lastWriteUtc -and
      [string]$PreviousDescriptor.sha256) {
    $hash = [string]$PreviousDescriptor.sha256
  } else {
    $hash = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  return [pscustomobject]@{
    path = (Resolve-Path $Path).Path
    size = $size
    lastWriteUtc = $lastWriteUtc
    sha256 = $hash
  }
}

function Get-StepSignature([hashtable]$Fields) {
  $pairs = @()
  foreach ($key in ($Fields.Keys | Sort-Object)) {
    $pairs += "$key=$($Fields[$key])"
  }
  return ($pairs -join "|")
}

function Test-ManifestStepCurrent(
  [object]$Manifest,
  [string]$StepName,
  [string]$Signature
) {
  if (-not $Manifest -or -not $Manifest.steps) { return $false }
  if (-not ($Manifest.steps.PSObject.Properties.Name -contains $StepName)) { return $false }
  $step = $Manifest.steps.$StepName
  if (-not $step) { return $false }
  if (-not ($step.PSObject.Properties.Name -contains "signature")) { return $false }
  return ([string]$step.signature -eq [string]$Signature)
}

function Set-ManifestStepState(
  [object]$Manifest,
  [string]$StepName,
  [string]$Signature,
  [string]$Status,
  [hashtable]$Meta
) {
  if (-not $Manifest.steps) {
    $Manifest | Add-Member -MemberType NoteProperty -Name steps -Value ([pscustomobject]@{})
  }
  if (-not ($Manifest.steps.PSObject.Properties.Name -contains $StepName)) {
    $Manifest.steps | Add-Member -MemberType NoteProperty -Name $StepName -Value $null
  }

  $metaObj = [pscustomobject]@{}
  if ($Meta) {
    foreach ($key in $Meta.Keys) {
      $metaObj | Add-Member -MemberType NoteProperty -Name $key -Value $Meta[$key]
    }
  }

  $Manifest.steps.$StepName = [pscustomobject]@{
    status = $Status
    signature = $Signature
    atUtc = [DateTime]::UtcNow.ToString("o")
    meta = $metaObj
  }
}
