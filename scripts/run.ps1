param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ForwardArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node is required but not found in PATH."
}

$cliScript = Join-Path $PSScriptRoot "node\run.js"
if (-not (Test-Path $cliScript)) {
  throw "Missing Node CLI script: $cliScript"
}

# Thin compatibility adapter: keep PowerShell entrypoint while Node owns orchestration.
& $node.Path $cliScript "run" @ForwardArgs
exit $LASTEXITCODE
