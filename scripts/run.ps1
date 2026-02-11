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

$repoRoot = Split-Path -Parent $PSScriptRoot
$tsConfig = Join-Path $repoRoot "tsconfig.json"
$tsCompiler = Join-Path $repoRoot "node_modules\typescript\bin\tsc"
$tsRoot = Join-Path $PSScriptRoot "ts"
$compiledRoot = Join-Path $PSScriptRoot "node"
$compiledEntry = Join-Path $compiledRoot "run.js"

$shouldCompile = -not (Test-Path $compiledEntry)
if (-not $shouldCompile -and (Test-Path $tsRoot)) {
  $latestTs = Get-ChildItem -Path $tsRoot -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($latestTs) {
    $compiledTime = (Get-Item $compiledEntry).LastWriteTimeUtc
    if ($latestTs.LastWriteTimeUtc -gt $compiledTime) {
      $shouldCompile = $true
    }
  }
}

if ($shouldCompile -and (Test-Path $tsCompiler) -and (Test-Path $tsConfig)) {
  & $node.Path $tsCompiler -p $tsConfig
  if ($LASTEXITCODE -ne 0) {
    throw "TypeScript runner build failed."
  }
}

$cliScript = Join-Path $compiledRoot "run.js"
if (-not (Test-Path $cliScript)) {
  throw "Missing Node CLI script: $cliScript"
}

# Thin compatibility adapter: keep PowerShell entrypoint while Node owns orchestration.
& $node.Path $cliScript "run" @ForwardArgs
exit $LASTEXITCODE
