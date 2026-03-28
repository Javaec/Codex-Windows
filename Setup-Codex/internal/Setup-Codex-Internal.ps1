Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node is required but not found in PATH."
}

$rootDir = Split-Path -Parent $PSScriptRoot
$wizardScript = Join-Path $rootDir "node\CodexSetupWizard.cjs"
$configPath = Join-Path $rootDir "provider-config.json"

if (-not (Test-Path $wizardScript)) {
  throw "Missing script: $wizardScript"
}

if (-not (Test-Path $configPath)) {
  throw "Missing config: $configPath"
}

$env:NODE_NO_WARNINGS = "1"
if (-not $env:CODEX_PWSH_PATH) {
  if ($env:PWSH_EXE) {
    $env:CODEX_PWSH_PATH = $env:PWSH_EXE
  } else {
    $currentPwsh = Join-Path $PSHOME "pwsh.exe"
    if (Test-Path $currentPwsh) {
      $env:CODEX_PWSH_PATH = $currentPwsh
    }
  }
}

# Setup-Codex is intentionally PowerShell-first; the wizard process inherits this shell context.
& $node.Path $wizardScript --config $configPath
exit $LASTEXITCODE
