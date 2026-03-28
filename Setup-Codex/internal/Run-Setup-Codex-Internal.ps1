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

$rootDir = Split-Path -Parent $PSScriptRoot
$tsConfig = Join-Path $rootDir "tsconfig.json"
$tsCompiler = Join-Path $rootDir "node_modules\typescript\bin\tsc"
$tsRoot = Join-Path $rootDir "ts"
$compiledRoot = Join-Path $rootDir "node"
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

# Internal PowerShell adapter: keep Node as the orchestration owner.
& $node.Path $cliScript "run" @ForwardArgs
exit $LASTEXITCODE
