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
  powershell -NoProfile -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwA9AFsAUwB5AHMAdABlAG0ALgBUAGUAeAB0AC4AVQBUAEYAOABFAG4AYwBvAGQAaQBuAGcAXQA6ADoAVQBUAEYAOAA7ACAAWwBDAG8AbgBzAG8AbABlAF0AOgA6AFcAcgBpAHQAZQBMAGkAbgBlACgAJwBbAE8ASwBdACAAHQQwBCAAMgRBBEIEQAQ1BEcEQwQgAD8EQAQ4BDoEOwROBEcENQQ9BDgETwQ8BCEAIQAhACEAIQAhACEAJwApAA==
) else (
  echo [ERROR] Setup failed with exit code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
