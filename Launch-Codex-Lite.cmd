@echo off
setlocal

set "TARGET=%~dp0dist\Launch-Codex-latest.cmd"
if not exist "%TARGET%" (
  echo [ERROR] Missing %TARGET%
  exit /b 1
)

call "%TARGET%"
exit /b %ERRORLEVEL%
