@echo off
setlocal

set "ROOT=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  exit /b 1
)

node "%ROOT%Setup-Codex\node\lib\worklouder-bypass.js" %*
exit /b %ERRORLEVEL%
