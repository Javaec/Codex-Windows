param(
  [Parameter(Mandatory = $false)]
  [string]$CodexHome,

  [Parameter(Mandatory = $false)]
  [string]$SqlitePath,

  [Parameter(Mandatory = $false)]
  [switch]$NoBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-SqlitePath {
  param(
    [Parameter(Mandatory = $false)]
    [string]$RequestedPath
  )

  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    $candidates += $RequestedPath
  }

  $command = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
  if ($command) {
    $candidates += $command.Source
  }

  $command = Get-Command sqlite3 -ErrorAction SilentlyContinue
  if ($command) {
    $candidates += $command.Source
  }

  $candidates += @(
    "C:\platform-tools\sqlite3.exe",
    (Join-Path $env:USERPROFILE "scoop\shims\sqlite3.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\sqlite3.exe")
  )

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "sqlite3.exe not found. Install sqlite3 or pass -SqlitePath."
}

function ConvertTo-SqliteQuotedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return "'" + $Path.Replace("'", "''") + "'"
}

function Invoke-SqliteScalar {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Sqlite,

    [Parameter(Mandatory = $true)]
    [string]$DatabasePath,

    [Parameter(Mandatory = $true)]
    [string]$Sql
  )

  $output = & $Sqlite $DatabasePath $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "sqlite3 failed with exit code $LASTEXITCODE for $DatabasePath"
  }
  return $output
}

function Invoke-SqliteScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Sqlite,

    [Parameter(Mandatory = $true)]
    [string]$DatabasePath,

    [Parameter(Mandatory = $true)]
    [string]$Sql
  )

  $Sql | & $Sqlite $DatabasePath
  if ($LASTEXITCODE -ne 0) {
    throw "sqlite3 failed with exit code $LASTEXITCODE for $DatabasePath"
  }
}

function Get-NormalizeExpression {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Column
  )

  return @"
CASE
  WHEN typeof($Column)='text' AND length($Column) > 4 AND substr(hex($Column), 1, 8)='5C5C3F5C' THEN substr($Column, 5)
  WHEN typeof($Column)='text' AND $Column LIKE '//?/%' THEN substr($Column, 5)
  WHEN typeof($Column)='text' AND $Column LIKE '//./%' THEN substr($Column, 5)
  WHEN typeof($Column)='text' AND $Column LIKE '/??/%' THEN substr($Column, 5)
  WHEN typeof($Column)='text' AND $Column GLOB '/[A-Za-z]:/*' THEN substr($Column, 2)
  WHEN typeof($Column)='text' AND substr($Column, 1, 1)='\' AND substr($Column, 2, 2) GLOB '[A-Za-z]:' THEN substr($Column, 2)
  ELSE $Column END
"@.Trim()
}

function Get-RepairSql {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Columns
  )

  $statements = New-Object System.Collections.Generic.List[string]
  $statements.Add(".timeout 10000")
  $statements.Add("BEGIN IMMEDIATE;")

  foreach ($column in $Columns) {
    $expr = Get-NormalizeExpression -Column $column
    $statements.Add("UPDATE threads SET $column = $expr WHERE typeof($column)='text' AND $column != $expr;")

    $triggerPrefix = "codex_windows_threads_${column}_normalize"
    $statements.Add(@"
CREATE TRIGGER IF NOT EXISTS ${triggerPrefix}_insert
AFTER INSERT ON threads
FOR EACH ROW BEGIN
  UPDATE threads SET $column = $expr WHERE id = NEW.id;
END;
"@.Trim())
    $statements.Add(@"
CREATE TRIGGER IF NOT EXISTS ${triggerPrefix}_update
AFTER UPDATE OF $column ON threads
FOR EACH ROW BEGIN
  UPDATE threads SET $column = $expr WHERE id = NEW.id;
END;
"@.Trim())
  }

  $statements.Add("COMMIT;")
  return ($statements -join "`n")
}

function Get-PrefixedCountSql {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Column
  )

  return "SELECT count(*) FROM threads WHERE typeof($Column)='text' AND (substr(hex($Column),1,8)='5C5C3F5C' OR $Column LIKE '//?/%' OR $Column LIKE '//./%' OR $Column LIKE '/??/%' OR $Column GLOB '/[A-Za-z]:/*' OR (substr($Column,1,1)='\' AND substr($Column,2,2) GLOB '[A-Za-z]:'));"
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    throw "USERPROFILE is required when -CodexHome is not provided."
  }
  $CodexHome = Join-Path $env:USERPROFILE ".codex"
}

if (-not (Test-Path -LiteralPath $CodexHome)) {
  throw "Codex home not found: $CodexHome"
}

$resolvedCodexHome = (Resolve-Path -LiteralPath $CodexHome).Path
$sqlite = Resolve-SqlitePath -RequestedPath $SqlitePath
$databases = @(Get-ChildItem -LiteralPath $resolvedCodexHome -Filter "state*.sqlite" -File -ErrorAction SilentlyContinue)
if ($databases.Count -eq 0) {
  throw "No state*.sqlite databases found in $resolvedCodexHome"
}

$backupDir = Join-Path $resolvedCodexHome "backups"
if (-not $NoBackup) {
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$totalUpdated = 0
foreach ($database in $databases) {
  $databasePath = $database.FullName
  $hasThreads = Invoke-SqliteScalar -Sqlite $sqlite -DatabasePath $databasePath -Sql "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='threads';"
  if ([int]$hasThreads -eq 0) {
    Write-Host "skip=$databasePath reason=no_threads_table"
    continue
  }

  $columnRows = Invoke-SqliteScalar -Sqlite $sqlite -DatabasePath $databasePath -Sql "PRAGMA table_info(threads);"
  $availableColumns = @($columnRows | ForEach-Object { ($_ -split "\|")[1] } | Where-Object { $_ })
  $targetColumns = @(@("cwd", "rollout_path") | Where-Object { $availableColumns -contains $_ })
  if ($targetColumns.Count -eq 0) {
    Write-Host "skip=$databasePath reason=no_thread_path_columns"
    continue
  }

  $before = 0
  foreach ($column in $targetColumns) {
    $before += [int](Invoke-SqliteScalar -Sqlite $sqlite -DatabasePath $databasePath -Sql (Get-PrefixedCountSql -Column $column))
  }

  if (-not $NoBackup) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = Join-Path $backupDir ("{0}-before-thread-path-normalize-{1}.sqlite" -f $database.BaseName, $timestamp)
    & $sqlite $databasePath ".backup $(ConvertTo-SqliteQuotedPath -Path $backupPath)"
    if ($LASTEXITCODE -ne 0) {
      throw "sqlite3 backup failed with exit code $LASTEXITCODE for $databasePath"
    }
    Write-Host "backup=$backupPath"
  }

  Invoke-SqliteScript -Sqlite $sqlite -DatabasePath $databasePath -Sql (Get-RepairSql -Columns $targetColumns)

  $after = 0
  foreach ($column in $targetColumns) {
    $after += [int](Invoke-SqliteScalar -Sqlite $sqlite -DatabasePath $databasePath -Sql (Get-PrefixedCountSql -Column $column))
  }

  $updated = [Math]::Max(0, $before - $after)
  $totalUpdated += $updated
  Write-Host "database=$databasePath before=$before after=$after normalized=$updated"
}

Write-Host "done normalized=$totalUpdated"
