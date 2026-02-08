Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-7z([string]$BaseDir) {
  $cmd = Get-Command 7z -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }

  $p1 = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
  $p2 = Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe"
  if (Test-Path $p1) { return $p1 }
  if (Test-Path $p2) { return $p2 }

  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if ($wg) {
    & winget install --id 7zip.7zip -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
    if (Test-Path $p1) { return $p1 }
    if (Test-Path $p2) { return $p2 }
  }

  if (-not $BaseDir) { return $null }
  $tools = Join-Path $BaseDir "tools"
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $sevenZipDir = Join-Path $tools "7zip"
  New-Item -ItemType Directory -Force -Path $sevenZipDir | Out-Null
  $home = "https://www.7-zip.org/"
  try { $html = (Invoke-WebRequest -Uri $home -UseBasicParsing).Content } catch { return $null }
  $extra = [regex]::Match($html, 'href="a/(7z[0-9]+-extra\.7z)"').Groups[1].Value
  if (-not $extra) { return $null }
  $extraUrl = "https://www.7-zip.org/a/$extra"
  $sevenRUrl = "https://www.7-zip.org/a/7zr.exe"
  $sevenR = Join-Path $tools "7zr.exe"
  $extraPath = Join-Path $tools $extra
  if (-not (Test-Path $sevenR)) { Invoke-WebRequest -Uri $sevenRUrl -OutFile $sevenR }
  if (-not (Test-Path $extraPath)) { Invoke-WebRequest -Uri $extraUrl -OutFile $extraPath }
  & $sevenR x -y $extraPath -o"$sevenZipDir" | Out-Null
  $p3 = Join-Path $sevenZipDir "7z.exe"
  if (Test-Path $p3) { return $p3 }
  return $null
}

function Resolve-DmgPath([string]$Explicit, [string]$RepoRoot) {
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "DMG not found: $Explicit" }
    return (Resolve-Path $Explicit).Path
  }

  $default = Join-Path $RepoRoot "Codex.dmg"
  if (Test-Path $default) {
    return (Resolve-Path $default).Path
  }

  $cand = Get-ChildItem -Path $RepoRoot -Filter "*.dmg" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) {
    return $cand.FullName
  }

  throw "No DMG found in [$RepoRoot]."
}

function Invoke-ExtractionStage(
  [string]$DmgPath,
  [string]$WorkDir,
  [switch]$Reuse,
  [object]$Manifest,
  [string]$ManifestPath,
  [string]$ExtractSignature
) {
  $sevenZip = Resolve-7z $WorkDir
  if (-not $sevenZip) { throw "7z not found." }

  $extractedDir = Join-Path $WorkDir "extracted"
  $electronDir = Join-Path $WorkDir "electron"
  $appDir = Join-Path $WorkDir "app"

  $appPackage = Join-Path $appDir "package.json"
  $canReuse = $Reuse -and
    (Test-Path $appPackage) -and
    (Test-ManifestStepCurrent -Manifest $Manifest -StepName "extract" -Signature $ExtractSignature)

  if ($canReuse) {
    Write-Host "Extraction cache hit: DMG signature unchanged. Reusing app payload." -ForegroundColor Cyan
    return [pscustomobject]@{
      sevenZip = $sevenZip
      extractedDir = $extractedDir
      electronDir = $electronDir
      appDir = $appDir
      performed = $false
    }
  }

  Write-Header "Extracting DMG"
  foreach ($dir in @($extractedDir, $electronDir, $appDir)) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  & $sevenZip x -y $DmgPath -o"$extractedDir" | Out-Null

  Write-Header "Extracting app.asar"
  $hfs = Join-Path $extractedDir "4.hfs"
  if (Test-Path $hfs) {
    & $sevenZip x -y $hfs "Codex Installer/Codex.app/Contents/Resources/app.asar" "Codex Installer/Codex.app/Contents/Resources/app.asar.unpacked" -o"$electronDir" | Out-Null
  } else {
    $directApp = Join-Path $extractedDir "Codex Installer\Codex.app\Contents\Resources\app.asar"
    if (-not (Test-Path $directApp)) {
      throw "app.asar not found."
    }
    $directUnpacked = Join-Path $extractedDir "Codex Installer\Codex.app\Contents\Resources\app.asar.unpacked"
    $destBase = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources"
    New-Item -ItemType Directory -Force -Path $destBase | Out-Null
    Copy-Item -Force $directApp (Join-Path $destBase "app.asar")
    if (Test-Path $directUnpacked) {
      & robocopy $directUnpacked (Join-Path $destBase "app.asar.unpacked") /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    }
  }

  Write-Header "Unpacking app.asar"
  $asar = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources\app.asar"
  if (-not (Test-Path $asar)) { throw "app.asar not found." }
  $npmExit = Invoke-Npm -Args @(
    "exec",
    "--yes",
    "--package",
    "@electron/asar",
    "--",
    "asar",
    "extract",
    $asar,
    $appDir
  )
  if ($npmExit -ne 0) { throw "npm exec asar extract failed." }

  Write-Header "Syncing app.asar.unpacked"
  $unpacked = Join-Path $electronDir "Codex Installer\Codex.app\Contents\Resources\app.asar.unpacked"
  if (Test-Path $unpacked) {
    & robocopy $unpacked $appDir /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  }

  Set-ManifestStepState -Manifest $Manifest -StepName "extract" -Signature $ExtractSignature -Status "ok" -Meta @{
    dmgPath = $DmgPath
  }
  Write-StateManifest -Path $ManifestPath -Manifest $Manifest

  return [pscustomobject]@{
    sevenZip = $sevenZip
    extractedDir = $extractedDir
    electronDir = $electronDir
    appDir = $appDir
    performed = $true
  }
}
