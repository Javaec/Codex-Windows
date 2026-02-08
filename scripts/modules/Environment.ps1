Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Add-PathSegments(
  [System.Collections.Generic.List[string]]$Segments,
  [hashtable]$Seen,
  [string]$Value
) {
  if (-not $Value) { return }
  foreach ($part in ($Value -split ";")) {
    $expanded = [Environment]::ExpandEnvironmentVariables($part).Trim().Trim('"')
    if (-not $expanded) { continue }
    $key = $expanded.ToLowerInvariant()
    if (-not $Seen.ContainsKey($key)) {
      $Seen[$key] = $true
      $Segments.Add($expanded)
    }
  }
}

function Get-RegistryValue([string]$Path, [string]$Name) {
  try {
    $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
    return [string]$item.$Name
  } catch {
    return $null
  }
}

function Resolve-CmdPath() {
  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $candidates = @(
    (Join-Path $systemRoot "System32\cmd.exe"),
    (Join-Path $systemRoot "Sysnative\cmd.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Resolve-PwshPath() {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:CODEX_PWSH_PATH) { $candidates.Add($env:CODEX_PWSH_PATH) }
  try {
    $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($pwshCmd) { $candidates.Add($pwshCmd.Path) }
  } catch {}

  if ($env:ProgramFiles) {
    $candidates.Add((Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"))
    $candidates.Add((Join-Path $env:ProgramFiles "PowerShell\7-preview\pwsh.exe"))
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "PowerShell\7\pwsh.exe"))
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "PowerShell\7-preview\pwsh.exe"))
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Resolve-WindowsPowerShellPath() {
  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $candidate = Join-Path $systemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path $candidate) {
    return (Resolve-Path $candidate).Path
  }
  return $null
}

function Ensure-WindowsEnvironment() {
  $segments = New-Object 'System.Collections.Generic.List[string]'
  $seen = @{}

  Add-PathSegments $segments $seen $env:PATH

  $machinePath = Get-RegistryValue "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  $userPath = Get-RegistryValue "HKCU:\Environment" "Path"
  Add-PathSegments $segments $seen $machinePath
  Add-PathSegments $segments $seen $userPath

  $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
  $defaults = @(
    $systemRoot,
    (Join-Path $systemRoot "System32"),
    (Join-Path $systemRoot "System32\Wbem"),
    (Join-Path $systemRoot "System32\WindowsPowerShell\v1.0"),
    (Join-Path $systemRoot "System32\OpenSSH")
  )
  if ($env:ProgramFiles) {
    $defaults += (Join-Path $env:ProgramFiles "PowerShell\7")
    $defaults += (Join-Path $env:ProgramFiles "nodejs")
    $defaults += (Join-Path $env:ProgramFiles "Git\cmd")
    $defaults += (Join-Path $env:ProgramFiles "Git\bin")
  }
  if (${env:ProgramFiles(x86)}) {
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "PowerShell\7")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "nodejs")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "Git\cmd")
    $defaults += (Join-Path ${env:ProgramFiles(x86)} "Git\bin")
  }
  if ($env:APPDATA) {
    $defaults += (Join-Path $env:APPDATA "npm")
  }
  if ($env:LOCALAPPDATA) {
    $defaults += (Join-Path $env:LOCALAPPDATA "fnm")
    $defaults += (Join-Path $env:LOCALAPPDATA "Volta\bin")
  }
  if ($env:NVM_SYMLINK) {
    $defaults += $env:NVM_SYMLINK
  }

  $nodeRegInstallPaths = @(
    (Get-RegistryValue "HKLM:\SOFTWARE\Node.js" "InstallPath"),
    (Get-RegistryValue "HKLM:\SOFTWARE\WOW6432Node\Node.js" "InstallPath"),
    (Get-RegistryValue "HKCU:\SOFTWARE\Node.js" "InstallPath")
  )
  foreach ($nodePath in $nodeRegInstallPaths) {
    Add-PathSegments $segments $seen $nodePath
  }

  foreach ($defaultPath in $defaults) {
    Add-PathSegments $segments $seen $defaultPath
  }

  $mergedPath = ($segments -join ";")
  $env:PATH = $mergedPath
  $env:Path = $mergedPath

  if (-not $env:PATHEXT) {
    $env:PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
  }

  $cmdPath = Resolve-CmdPath
  if ($cmdPath) {
    $env:COMSPEC = $cmdPath
  }

  $pwshPath = Resolve-PwshPath
  if ($pwshPath) {
    $env:CODEX_PWSH_PATH = $pwshPath
  } else {
    $windowsPowerShell = Resolve-WindowsPowerShellPath
    if ($windowsPowerShell) {
      $env:CODEX_PWSH_PATH = $windowsPowerShell
    }
  }
}

function Get-UserPathEntries() {
  $userPath = Get-RegistryValue "HKCU:\Environment" "Path"
  if (-not $userPath) { return @() }
  return ($userPath -split ";") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

function Add-UserPathEntry([string]$Entry) {
  if (-not $Entry) { return }
  $resolvedEntry = [Environment]::ExpandEnvironmentVariables($Entry).Trim().Trim('"')
  if (-not $resolvedEntry) { return }

  $entries = New-Object System.Collections.Generic.List[string]
  foreach ($current in (Get-UserPathEntries)) {
    $entries.Add($current)
  }

  $exists = $false
  foreach ($current in $entries) {
    if ($current.ToLowerInvariant() -eq $resolvedEntry.ToLowerInvariant()) {
      $exists = $true
      break
    }
  }
  if ($exists) { return }

  $entries.Add($resolvedEntry)
  $newPath = ($entries -join ";")
  Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $newPath -Type ExpandString
}

function Resolve-RipgrepCommand() {
  $cmd = Get-Command rg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  return $null
}

function Ensure-RipgrepInPath(
  [string]$WorkDir,
  [switch]$PersistUserPath
) {
  $existing = Resolve-RipgrepCommand
  if ($existing) { return [pscustomobject]@{ installed = $false; path = $existing; source = "path" } }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    try {
      & winget install --id BurntSushi.ripgrep -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Null
      Ensure-WindowsEnvironment
      $afterWinget = Resolve-RipgrepCommand
      if ($afterWinget) {
        return [pscustomobject]@{ installed = $true; path = $afterWinget; source = "winget" }
      }
    } catch {
      # Fall through to portable mode.
    }
  }

  if (-not $WorkDir) {
    return [pscustomobject]@{ installed = $false; path = $null; source = "unavailable" }
  }

  $toolsDir = Join-Path $WorkDir "tools"
  $rgRoot = Join-Path $toolsDir "ripgrep"
  New-Item -ItemType Directory -Force -Path $rgRoot | Out-Null
  $version = "14.1.1"
  $zipName = "ripgrep-$version-x86_64-pc-windows-msvc.zip"
  $zipPath = Join-Path $rgRoot $zipName
  $extractDir = Join-Path $rgRoot "ripgrep-$version-x86_64-pc-windows-msvc"
  $rgExe = Join-Path $extractDir "rg.exe"
  $url = "https://github.com/BurntSushi/ripgrep/releases/download/$version/$zipName"

  if (-not (Test-Path $rgExe)) {
    if (-not (Test-Path $zipPath)) {
      Invoke-WebRequest -Uri $url -OutFile $zipPath
    }
    if (Test-Path $extractDir) {
      Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    }
    Expand-Archive -Path $zipPath -DestinationPath $rgRoot -Force
  }

  if (Test-Path $rgExe) {
    if ($env:PATH -notlike "*$extractDir*") {
      $env:PATH = "$extractDir;$env:PATH"
      $env:Path = $env:PATH
    }
    if ($PersistUserPath) {
      Add-UserPathEntry $extractDir
    }
    return [pscustomobject]@{ installed = $true; path = $rgExe; source = "portable" }
  }

  return [pscustomobject]@{ installed = $false; path = $null; source = "unavailable" }
}

function New-ContractCheck([string]$Name, [bool]$Passed, [string]$Details) {
  return [pscustomobject]@{
    name = $Name
    passed = $Passed
    details = $Details
  }
}

function Invoke-EnvironmentContractChecks() {
  $checks = New-Object System.Collections.Generic.List[object]
  $cmdPath = Resolve-CmdPath
  $cmdDetails = if ($cmdPath) { $cmdPath } else { "cmd.exe not found" }
  $checks.Add((New-ContractCheck "cmd.exe available" ([bool]$cmdPath) $cmdDetails))

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $nodeDetails = if ($nodeCmd) { $nodeCmd.Path } else { "node not found in current PATH" }
  $checks.Add((New-ContractCheck "node available in host process" ([bool]$nodeCmd) $nodeDetails))

  $pwshCmd = Resolve-PwshPath
  $pwshDetails = if ($pwshCmd) { $pwshCmd } else { "pwsh and fallback powershell not found" }
  $checks.Add((New-ContractCheck "pwsh/powershell resolver" ([bool]$pwshCmd) $pwshDetails))

  $rgCmd = Resolve-RipgrepCommand
  $rgDetails = if ($rgCmd) { $rgCmd } else { "rg not found in current PATH" }
  $checks.Add((New-ContractCheck "rg (ripgrep) available" ([bool]$rgCmd) $rgDetails))

  if ($cmdPath) {
    try {
      & $cmdPath /d /s /c "where node" | Out-Null
      $checks.Add((New-ContractCheck "cmd where node" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"))
    } catch {
      $checks.Add((New-ContractCheck "cmd where node" $false $_.Exception.Message))
    }

    try {
      & $cmdPath /d /s /c "node -v" | Out-Null
      $checks.Add((New-ContractCheck "cmd node -v" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"))
    } catch {
      $checks.Add((New-ContractCheck "cmd node -v" $false $_.Exception.Message))
    }

    try {
      & $cmdPath /d /s /c "where powershell" | Out-Null
      $checks.Add((New-ContractCheck "cmd where powershell" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"))
    } catch {
      $checks.Add((New-ContractCheck "cmd where powershell" $false $_.Exception.Message))
    }
  }

  $allPassed = $true
  foreach ($check in $checks) {
    if (-not $check.passed) {
      $allPassed = $false
      break
    }
  }

  return [pscustomobject]@{
    passed = $allPassed
    checks = $checks
  }
}

function Write-EnvironmentContractSummary([object]$Result) {
  if (-not $Result) { return }
  foreach ($check in $Result.checks) {
    if ($check.passed) {
      Write-Host "[env] OK    $($check.name) :: $($check.details)" -ForegroundColor DarkGray
    } else {
      Write-Host "[env] FAIL  $($check.name) :: $($check.details)" -ForegroundColor Yellow
    }
  }
}

function Assert-EnvironmentContract([switch]$Strict) {
  $result = Invoke-EnvironmentContractChecks
  Write-EnvironmentContractSummary $result
  if (-not $result.passed) {
    $message = "Windows environment contract check failed."
    if ($Strict) {
      throw $message
    }
    Write-Host "$message Continuing in non-strict mode." -ForegroundColor Yellow
  }
  return $result
}

function Invoke-ElectronChildEnvironmentContract(
  [string]$ElectronExe,
  [string]$WorkingDir,
  [switch]$Strict
) {
  if (-not (Test-Path $ElectronExe)) {
    $message = "Electron child environment check skipped: electron runtime not found."
    if ($Strict) { throw $message }
    Write-Host $message -ForegroundColor Yellow
    return $false
  }
  if (-not (Test-Path $WorkingDir)) {
    $message = "Electron child environment check skipped: working dir not found."
    if ($Strict) { throw $message }
    Write-Host $message -ForegroundColor Yellow
    return $false
  }

  $script = @'
const cp=require('node:child_process');
function run(command){
  try{
    cp.execSync(command,{stdio:'pipe'});
    return true;
  }catch{
    return false;
  }
}
const checks=[
  ['child cmd where node','cmd.exe /d /s /c \"where node\"'],
  ['child cmd node -v','cmd.exe /d /s /c \"node -v\"'],
  ['child cmd where powershell','cmd.exe /d /s /c \"where powershell\"']
];
let ok=true;
for(const [name,cmd] of checks){
  const passed=run(cmd);
  process.stdout.write('[electron-env] '+(passed?'OK':'FAIL')+' '+name+'\n');
  if(!passed) ok=false;
}
process.exit(ok?0:1);
'@

  Push-Location $WorkingDir
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    & $ElectronExe -e $script
    $code = $LASTEXITCODE
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Pop-Location
  }

  if ($code -ne 0) {
    $message = "Electron child environment contract check failed (exit=$code)."
    if ($Strict) {
      throw $message
    }
    Write-Host $message -ForegroundColor Yellow
    return $false
  }

  return $true
}
