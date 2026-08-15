@echo off
setlocal
set "SCRIPT=%~dp0Run-Codex-Provider-Sync.ps1"

if not "%~1"=="" goto :run_powershell
if defined WT_SESSION goto :run_powershell
where wt.exe >nul 2>&1
if not errorlevel 1 (
  wt.exe -w 0 new-tab --title "Codex Provider Sync" pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
  exit /b %ERRORLEVEL%
)

:run_powershell
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
