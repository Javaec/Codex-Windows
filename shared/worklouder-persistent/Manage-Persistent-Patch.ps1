[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Restore", "Status")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$NodeScript,

    [string]$NodePath,

    [switch]$Elevated
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

function Resolve-NodePath {
    if ($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $NodePath).Path
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    $installedNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path -LiteralPath $installedNode -PathType Leaf) { return $installedNode }
    throw "Node.js 22 or newer was not found."
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$NodeScript = (Resolve-Path -LiteralPath $NodeScript).Path
$NodePath = Resolve-NodePath

if ($Mode -eq "Status") {
    & $NodePath $NodeScript --patch-status
    exit $LASTEXITCODE
}

if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
    throw "ChatGPT is running. Exit it completely before restoring the persistent patch."
}

if (-not $Elevated -or -not (Test-IsAdministrator)) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Mode", $Mode,
        "-NodeScript", "`"$NodeScript`"",
        "-NodePath", "`"$NodePath`"",
        "-Elevated"
    )
    $process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

$package = Get-AppxPackage -Name "OpenAI.Codex" | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package -or -not $package.InstallLocation) {
    throw "OpenAI.Codex Store package was not found."
}
$asarPath = Join-Path $package.InstallLocation "app\resources\app.asar"
if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
    throw "Codex app.asar was not found."
}

$originalAcl = Get-Acl -LiteralPath $asarPath
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

try {
    & takeown.exe /F $asarPath /A | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to take temporary ownership of app.asar." }

    & icacls.exe $asarPath /grant "*$($currentSid):(M)" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to grant temporary write access to app.asar." }

    & $NodePath $NodeScript --restore-persistent
    if ($LASTEXITCODE -ne 0) { throw "Persistent patch command failed with exit code $LASTEXITCODE." }
}
finally {
    try {
        Set-Acl -LiteralPath $asarPath -AclObject $originalAcl
    }
    catch {
        throw "CRITICAL: unable to restore the original app.asar ACL: $($_.Exception.Message)"
    }
}
