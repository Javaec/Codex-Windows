param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CliArguments
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $scriptRoot 'cli.cjs'
$nodeCommand = Get-Command node.exe -ErrorAction Stop

function Invoke-CodexCliJson {
  param([string[]] $Arguments)

  $output = & $nodeCommand.Source $cliPath @Arguments '--json' 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw (($output | Out-String).Trim())
  }
  return (($output | Out-String).Trim() | ConvertFrom-Json)
}

function Write-Rule {
  param([ConsoleColor] $Color = [ConsoleColor]::DarkCyan)
  Write-Host ('─' * 72) -ForegroundColor $Color
}

function Write-Info {
  param([string] $Label, [string] $Value)
  Write-Host ('  {0,-18}' -f $Label) -ForegroundColor DarkGray -NoNewline
  Write-Host $Value -ForegroundColor White
}

function Read-MenuChoice {
  param(
    [string] $Prompt,
    [int] $Default,
    [int] $Maximum
  )

  while ($true) {
    $answer = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
      return $Default
    }
    $choice = 0
    if ([int]::TryParse($answer, [ref] $choice) -and $choice -ge 1 -and $choice -le $Maximum) {
      return $choice
    }
    Write-Host "Введите число от 1 до $Maximum." -ForegroundColor Yellow
  }
}

function Read-ProviderChoice {
  param(
    [string] $Title,
    [string[]] $Providers,
    [string] $DefaultProvider,
    [bool] $AllowCustom
  )

  Write-Host $Title -ForegroundColor Cyan
  for ($index = 0; $index -lt $Providers.Count; $index += 1) {
    $marker = if ($Providers[$index] -eq $DefaultProvider) { ' (default)' } else { '' }
    Write-Host ('  {0}. {1}{2}' -f ($index + 1), $Providers[$index], $marker) -ForegroundColor White
  }
  $customIndex = $Providers.Count + 1
  if ($AllowCustom) {
    Write-Host "  $customIndex. Ввести provider ID вручную" -ForegroundColor DarkGray
  }

  $defaultIndex = [Math]::Max(1, [Array]::IndexOf($Providers, $DefaultProvider) + 1)
  while ($true) {
    $answer = Read-Host "Выбор [$defaultIndex]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
      return $DefaultProvider
    }
    $choice = 0
    if (-not [int]::TryParse($answer, [ref] $choice)) {
      Write-Host 'Введите номер из списка.' -ForegroundColor Yellow
      continue
    }
    if ($choice -ge 1 -and $choice -le $Providers.Count) {
      return $Providers[$choice - 1]
    }
    if ($AllowCustom -and $choice -eq $customIndex) {
      $custom = (Read-Host 'Provider ID').Trim()
      if ($custom) {
        return $custom
      }
    }
    Write-Host 'Некорректный выбор.' -ForegroundColor Yellow
  }
}

function Show-Report {
  param([psobject] $Report)

  Write-Rule
  Write-Info 'JSONL changes' $Report.jsonlChanges
  Write-Info 'SQLite changes' $Report.sqliteChanges
  Write-Info 'Provider' ("{0} -> {1}" -f ($Report.fromProviders -join ', '), $Report.toProvider)
  if ($Report.sessionId) {
    Write-Info 'Session' $Report.sessionId
  }
  if ($Report.backupDir) {
    Write-Info 'Backup' $Report.backupDir
  }
  if ($Report.verified) {
    Write-Info 'Verification' 'OK'
  }
}

if ($CliArguments.Count -gt 0) {
  $env:NODE_NO_WARNINGS = '1'
  & $nodeCommand.Source $cliPath @CliArguments
  exit $LASTEXITCODE
}

Clear-Host
Write-Host '╭────────────────────────────────────────────────────────────────────────╮' -ForegroundColor Cyan
Write-Host '│                    CODEX PROVIDER SYNC                                │' -ForegroundColor Cyan
Write-Host '│        История сессий: official provider ↔ custom provider             │' -ForegroundColor DarkCyan
Write-Host '╰────────────────────────────────────────────────────────────────────────╯' -ForegroundColor Cyan
Write-Host ''

$status = Invoke-CodexCliJson @('--status')
Write-Info 'Codex home' $status.codexHome
Write-Info 'State DB' $status.stateDbPath
Write-Info 'JSONL sessions' $status.jsonlSessions
Write-Info 'SQLite threads' $status.sqliteThreads
Write-Host ''

$sessionProviderNames = @($status.sessionProviders.PSObject.Properties.Name)
$databaseProviderNames = @($status.databaseProviders.PSObject.Properties.Name)
$providerNames = @($sessionProviderNames + $databaseProviderNames | Sort-Object -Unique)
if ($providerNames.Count -eq 0) {
  throw 'Provider-tagged sessions were not found.'
}

$defaultSource = if ($providerNames -contains 'openai') { 'openai' } else { $providerNames[0] }
$sourceProvider = Read-ProviderChoice 'Исходный provider:' $providerNames $defaultSource $true
$targetProviders = @($providerNames | Where-Object { $_ -ne $sourceProvider })
$defaultTarget = if ($targetProviders -contains 'codex') { 'codex' } elseif ($targetProviders.Count -gt 0) { $targetProviders[0] } else { '' }
$targetProvider = Read-ProviderChoice 'Целевой provider:' $targetProviders $defaultTarget $true

Write-Host ''
Write-Host 'Область миграции:' -ForegroundColor Cyan
Write-Host '  1. Все сессии этого provider' -ForegroundColor White
Write-Host '  2. Одна сессия по ID' -ForegroundColor White
$scope = Read-MenuChoice 'Выбор' 1 2
$sessionId = ''
if ($scope -eq 2) {
  $sessionId = (Read-Host 'Session ID').Trim()
  if (-not $sessionId) {
    throw 'Session ID cannot be empty.'
  }
}

$previewArgs = @('--from', $sourceProvider, '--to', $targetProvider, '--dry-run')
if ($sessionId) {
  $previewArgs += @('--session-id', $sessionId)
}
$preview = Invoke-CodexCliJson $previewArgs

Write-Host ''
Write-Host 'Предпросмотр изменений:' -ForegroundColor Green
Show-Report $preview
if ([int]$preview.jsonlChanges -eq 0 -and [int]$preview.sqliteChanges -eq 0) {
  Write-Host 'Изменения не требуются.' -ForegroundColor Yellow
  Read-Host 'Нажмите Enter для выхода' | Out-Null
  exit 0
}

if (Get-Process -Name codex -ErrorAction SilentlyContinue) {
  Write-Host 'ВНИМАНИЕ: Codex сейчас запущен. Перед записью закройте Codex, CLI и app-server.' -ForegroundColor Yellow
}
Write-Host ''
$confirmation = (Read-Host 'Применить изменения с backup? [y/N]').Trim().ToLowerInvariant()
if ($confirmation -notin @('y', 'yes', 'д', 'да')) {
  Write-Host 'Отменено. Ничего не изменено.' -ForegroundColor DarkGray
  Read-Host 'Нажмите Enter для выхода' | Out-Null
  exit 0
}

$applyArgs = @('--from', $sourceProvider, '--to', $targetProvider, '--yes')
if ($sessionId) {
  $applyArgs += @('--session-id', $sessionId)
}
$result = Invoke-CodexCliJson $applyArgs
Write-Host ''
Write-Host 'Миграция завершена.' -ForegroundColor Green
Show-Report $result
Read-Host 'Нажмите Enter для выхода' | Out-Null
