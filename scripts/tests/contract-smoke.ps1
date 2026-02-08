param(
  [string]$WorkDir = (Join-Path $PSScriptRoot "..\..\work"),
  [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$moduleRoot = Join-Path $PSScriptRoot "..\modules"
foreach ($moduleName in @("Common.ps1", "Environment.ps1")) {
  $path = Join-Path $moduleRoot $moduleName
  if (-not (Test-Path $path)) { throw "Missing module: $path" }
  . $path
}

Ensure-WindowsEnvironment
Write-Header "Host environment contract"
Assert-EnvironmentContract -Strict:$Strict | Out-Null

$electronExe = Join-Path $WorkDir "native-builds\node_modules\electron\dist\electron.exe"
$appDir = Join-Path $WorkDir "app"
if ((Test-Path $electronExe) -and (Test-Path $appDir)) {
  Write-Header "Electron child environment contract"
  Invoke-ElectronChildEnvironmentContract -ElectronExe $electronExe -WorkingDir $appDir -Strict:$Strict | Out-Null
} else {
  Write-Host "Skipping Electron child contract: runtime not prepared in work/." -ForegroundColor Yellow
}

Write-Host "Contract smoke check completed." -ForegroundColor Green
