"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeRuntimeLaneCompareTools = writeRuntimeLaneCompareTools;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function buildRuntimeLaneCompareScript() {
    return [
        "param([string]$BaseDir = $PSScriptRoot)",
        "$ErrorActionPreference = 'Stop'",
        "",
        "$logsRoot = Join-Path $BaseDir 'runtime-logs'",
        "$summaryPath = Join-Path $logsRoot 'lane-summary.txt'",
        "$summaryJsonPath = Join-Path $logsRoot 'lane-summary.json'",
        "if (-not (Test-Path -LiteralPath $logsRoot)) {",
        "  New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null",
        "  'No runtime logs found for any lane.' | Set-Content -LiteralPath $summaryPath -Encoding UTF8",
        "  '[]' | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8",
        "  Get-Content -LiteralPath $summaryPath",
        "  exit 0",
        "}",
        "",
        "$patterns = [ordered]@{",
        "  cli_initialized = 'Codex CLI initialized'",
        "  ready_message = \"Handled 'ready' message\"",
        "  statsig_ready = 'Statsig: auth context ready|Statsig: client initialization completed'",
        "  dom_ready = 'renderer\\.dom-ready|dom-ready'",
        "  window_show = 'window\\.show|show-window'",
        "  syntax_error = 'SyntaxError|Invalid or unexpected token'",
        "  renderer_mod_failed = 'renderer mod failed'",
        "  preload_error = 'Unable to load preload script'",
        "  update_required = 'Update required'",
        "  account_read = 'method=account/read'",
        "  thread_list = 'method=thread/list'",
        "  app_list = 'method=app/list'",
        "  skills_list = 'method=skills/list'",
        "  git_origin_failed = 'git-origin-and-roots'",
        "  thread_backfill_failed = 'Failed to backfill app thread title'",
        "}",
        "",
        "$rows = @()",
        "foreach ($laneDir in Get-ChildItem -LiteralPath $logsRoot -Directory | Sort-Object Name) {",
        "  $stdoutPath = Join-Path $laneDir.FullName 'stdout-latest.log'",
        "  $chromePath = Join-Path $laneDir.FullName 'chromium.log'",
        "  $envPath = Join-Path $laneDir.FullName 'launch.env.txt'",
        "  $content = ''",
        "  foreach ($filePath in @($stdoutPath, $chromePath, $envPath)) {",
        "    if (Test-Path -LiteralPath $filePath) {",
        "      $content += [System.IO.File]::ReadAllText($filePath)",
        "      $content += [Environment]::NewLine",
        "    }",
        "  }",
        "  if ([string]::IsNullOrWhiteSpace($content)) { continue }",
        "",
        "  $stdoutBytes = 0",
        "  if (Test-Path -LiteralPath $stdoutPath) { $stdoutBytes = (Get-Item -LiteralPath $stdoutPath).Length }",
        "  $chromiumBytes = 0",
        "  if (Test-Path -LiteralPath $chromePath) { $chromiumBytes = (Get-Item -LiteralPath $chromePath).Length }",
        "",
        "  $row = [ordered]@{",
        "    lane = $laneDir.Name",
        "    stdout_bytes = $stdoutBytes",
        "    chromium_bytes = $chromiumBytes",
        "  }",
        "  foreach ($patternName in $patterns.Keys) {",
        "    $row[$patternName] = ([regex]::Matches($content, $patterns[$patternName], [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)).Count",
        "  }",
        "  $rows += [pscustomobject]$row",
        "}",
        "",
        "if ($rows.Count -eq 0) {",
        "  'No runtime logs found for any lane.' | Set-Content -LiteralPath $summaryPath -Encoding UTF8",
        "  '[]' | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8",
        "} else {",
        "  ($rows | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $summaryJsonPath -Encoding UTF8",
        "  ($rows | Format-Table -AutoSize | Out-String -Width 240).TrimEnd() | Set-Content -LiteralPath $summaryPath -Encoding UTF8",
        "}",
        "",
        "Get-Content -LiteralPath $summaryPath",
        "",
    ].join("\n");
}
function writeRuntimeLaneCompareTools(outputDir) {
    fs.writeFileSync(path.join(outputDir, "Compare-Runtime-Lanes.ps1"), buildRuntimeLaneCompareScript(), "utf8");
    fs.writeFileSync(path.join(outputDir, "Compare-Runtime-Lanes.cmd"), `@echo off
setlocal
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\\Windows"
set "PWSH=%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
if exist "%ProgramFiles%\\PowerShell\\7\\pwsh.exe" set "PWSH=%ProgramFiles%\\PowerShell\\7\\pwsh.exe"
if exist "%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe" set "PWSH=%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Compare-Runtime-Lanes.ps1"
exit /b %ERRORLEVEL%
`, "ascii");
}
