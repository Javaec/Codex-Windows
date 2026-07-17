@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "NODE_SCRIPT=%ROOT%Setup-Codex\node\lib\worklouder-bypass.js"
set "PATCH_MANAGER=%ROOT%shared\worklouder-persistent\Manage-Persistent-Patch.ps1"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  exit /b 1
)

if /I "%~1"=="--install-persistent" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_MANAGER%" -Mode Install -NodeScript "%NODE_SCRIPT%"
  exit /b !ERRORLEVEL!
)
if /I "%~1"=="--restore-persistent" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_MANAGER%" -Mode Restore -NodeScript "%NODE_SCRIPT%"
  exit /b !ERRORLEVEL!
)
if /I "%~1"=="--patch-status" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_MANAGER%" -Mode Status -NodeScript "%NODE_SCRIPT%"
  exit /b !ERRORLEVEL!
)

node "%NODE_SCRIPT%" %*
exit /b %ERRORLEVEL%
