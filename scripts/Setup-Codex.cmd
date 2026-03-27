@echo off
setlocal
cd /d "%~dp0"
title Codex Setup Wizard

set "NODE_EXE="
for %%F in (node.exe) do set "NODE_EXE=%%~$PATH:F"

if not defined NODE_EXE (
  echo [ERROR] node.exe was not found in PATH.
  echo [ERROR] Install Node.js or run this launcher from a machine where Node is already available.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node\CodexSetupWizard.cjs" (
  echo [ERROR] Missing script: %~dp0node\CodexSetupWizard.cjs
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0provider-config.json" (
  echo [ERROR] Missing config: %~dp0provider-config.json
  echo.
  pause
  exit /b 1
)

set "NODE_NO_WARNINGS=1"
"%NODE_EXE%" "%~dp0node\CodexSetupWizard.cjs" --config "%~dp0provider-config.json"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Finished.
) else (
  echo [ERROR] Setup failed with exit code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
