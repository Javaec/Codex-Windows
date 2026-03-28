import * as fs from "node:fs";
import * as path from "node:path";

export type RuntimeLaneSummary = {
  lane: string;
  stdout_bytes: number;
  chromium_bytes: number;
  cli_initialized: number;
  ready_message: number;
  statsig_ready: number;
  auth_unset: number;
  dom_ready: number;
  did_finish_load: number;
  window_show: number;
  ready_to_show: number;
  did_fail_load: number;
  render_process_gone: number;
  syntax_error: number;
  renderer_mod_failed: number;
  preload_error: number;
  update_required: number;
  account_read: number;
  thread_list: number;
  app_list: number;
  skills_list: number;
  usability_sidebar_present: number;
  usability_settings_present: number;
  usability_project_list_present: number;
  usability_surface_ready: number;
  usability_blocking_spinner: number;
  git_origin_failed: number;
  thread_backfill_failed: number;
};

const RUNTIME_LANE_PATTERNS: Array<[keyof Omit<RuntimeLaneSummary, "lane" | "stdout_bytes" | "chromium_bytes">, RegExp]> = [
  ["cli_initialized", /Codex CLI initialized/gi],
  ["ready_message", /Handled 'ready' message/gi],
  ["statsig_ready", /Statsig: auth context ready|Statsig: client initialization completed/gi],
  ["auth_unset", /authMethod=unset/gi],
  ["dom_ready", /renderer\.dom-ready|dom-ready/gi],
  ["did_finish_load", /webcontents\.did-finish-load|did-finish-load/gi],
  ["window_show", /window\.show|show-window/gi],
  ["ready_to_show", /ready-to-show|browser-window\.ready-to-show/gi],
  ["did_fail_load", /webcontents\.did-fail-load|did-fail-load/gi],
  ["render_process_gone", /webcontents\.render-process-gone|render-process-gone/gi],
  ["syntax_error", /SyntaxError|Invalid or unexpected token/gi],
  ["renderer_mod_failed", /renderer mod failed/gi],
  ["preload_error", /Unable to load preload script/gi],
  ["update_required", /Update required/gi],
  ["account_read", /method=account\/read/gi],
  ["thread_list", /method=thread\/list/gi],
  ["app_list", /method=app\/list/gi],
  ["skills_list", /method=skills\/list/gi],
  ["usability_sidebar_present", /\[codex-windows-usability\] sidebar\.present/gi],
  ["usability_settings_present", /\[codex-windows-usability\] settings\.present/gi],
  ["usability_project_list_present", /\[codex-windows-usability\] project-list\.present/gi],
  ["usability_surface_ready", /\[codex-windows-usability\] surface-ready/gi],
  ["usability_blocking_spinner", /\[codex-windows-usability\] blocking-spinner\.present/gi],
  ["git_origin_failed", /git-origin-and-roots/gi],
  ["thread_backfill_failed", /Failed to backfill app thread title/gi],
];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function buildRuntimeLaneRows(logsRoot: string): RuntimeLaneSummary[] {
  if (!fs.existsSync(logsRoot)) return [];
  const rows: RuntimeLaneSummary[] = [];
  for (const laneDir of fs.readdirSync(logsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const laneRoot = path.join(logsRoot, laneDir.name);
    const stdoutPath = path.join(laneRoot, "stdout-latest.log");
    const chromiumPath = path.join(laneRoot, "chromium.log");
    const envPath = path.join(laneRoot, "launch.env.txt");
    const content = [stdoutPath, chromiumPath, envPath]
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    if (!content.trim()) continue;

    const row: RuntimeLaneSummary = {
      lane: laneDir.name,
      stdout_bytes: fs.existsSync(stdoutPath) ? fs.statSync(stdoutPath).size : 0,
      chromium_bytes: fs.existsSync(chromiumPath) ? fs.statSync(chromiumPath).size : 0,
      cli_initialized: 0,
      ready_message: 0,
      statsig_ready: 0,
      auth_unset: 0,
      dom_ready: 0,
      did_finish_load: 0,
      window_show: 0,
      ready_to_show: 0,
      did_fail_load: 0,
      render_process_gone: 0,
      syntax_error: 0,
      renderer_mod_failed: 0,
      preload_error: 0,
      update_required: 0,
      account_read: 0,
      thread_list: 0,
      app_list: 0,
      skills_list: 0,
      usability_sidebar_present: 0,
      usability_settings_present: 0,
      usability_project_list_present: 0,
      usability_surface_ready: 0,
      usability_blocking_spinner: 0,
      git_origin_failed: 0,
      thread_backfill_failed: 0,
    };
    for (const [key, pattern] of RUNTIME_LANE_PATTERNS) {
      row[key] = countMatches(content, pattern);
    }
    rows.push(row);
  }
  return rows;
}

function buildRuntimeLaneSummaryText(rows: RuntimeLaneSummary[]): string {
  if (rows.length < 1) {
    return "No runtime logs found for any lane.\n";
  }
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function summarizeRuntimeLanes(outputDir: string): RuntimeLaneSummary[] {
  const logsRoot = path.join(outputDir, "runtime-logs");
  const summaryPath = path.join(logsRoot, "lane-summary.txt");
  const summaryJsonPath = path.join(logsRoot, "lane-summary.json");
  fs.mkdirSync(logsRoot, { recursive: true });
  const rows = buildRuntimeLaneRows(logsRoot);
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryPath, buildRuntimeLaneSummaryText(rows), "utf8");
  return rows;
}

function buildRuntimeLaneCompareScript(): string {
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
    "  auth_unset = 'authMethod=unset'",
    "  dom_ready = 'renderer\\.dom-ready|dom-ready'",
    "  did_finish_load = 'webcontents\\.did-finish-load|did-finish-load'",
    "  window_show = 'window\\.show|show-window'",
    "  ready_to_show = 'ready-to-show|browser-window\\.ready-to-show'",
    "  did_fail_load = 'webcontents\\.did-fail-load|did-fail-load'",
    "  render_process_gone = 'webcontents\\.render-process-gone|render-process-gone'",
    "  syntax_error = 'SyntaxError|Invalid or unexpected token'",
    "  renderer_mod_failed = 'renderer mod failed'",
    "  preload_error = 'Unable to load preload script'",
    "  update_required = 'Update required'",
    "  account_read = 'method=account/read'",
    "  thread_list = 'method=thread/list'",
    "  app_list = 'method=app/list'",
    "  skills_list = 'method=skills/list'",
    "  usability_sidebar_present = '\\[codex-windows-usability\\] sidebar\\.present'",
    "  usability_settings_present = '\\[codex-windows-usability\\] settings\\.present'",
    "  usability_project_list_present = '\\[codex-windows-usability\\] project-list\\.present'",
    "  usability_surface_ready = '\\[codex-windows-usability\\] surface-ready'",
    "  usability_blocking_spinner = '\\[codex-windows-usability\\] blocking-spinner\\.present'",
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

export function writeRuntimeLaneCompareTools(outputDir: string): void {
  fs.writeFileSync(path.join(outputDir, "Compare-Runtime-Lanes.ps1"), buildRuntimeLaneCompareScript(), "utf8");
  fs.writeFileSync(
    path.join(outputDir, "Compare-Runtime-Lanes.cmd"),
    `@echo off
setlocal
set "WINROOT=%SystemRoot%"
if "%WINROOT%"=="" set "WINROOT=C:\\Windows"
set "PWSH=%WINROOT%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
if exist "%ProgramFiles%\\PowerShell\\7\\pwsh.exe" set "PWSH=%ProgramFiles%\\PowerShell\\7\\pwsh.exe"
if exist "%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe" set "PWSH=%ProgramFiles(x86)%\\PowerShell\\7\\pwsh.exe"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Compare-Runtime-Lanes.ps1"
exit /b %ERRORLEVEL%
`,
    "ascii",
  );
}
