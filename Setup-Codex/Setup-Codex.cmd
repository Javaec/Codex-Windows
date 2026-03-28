@echo off
setlocal
cd /d "%~dp0"
title Codex Setup Wizard

set "PWSH_EXE="
for %%F in (pwsh.exe) do set "PWSH_EXE=%%~$PATH:F"
if not defined PWSH_EXE if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PWSH_EXE if exist "%ProgramFiles(x86)%\PowerShell\7\pwsh.exe" set "PWSH_EXE=%ProgramFiles(x86)%\PowerShell\7\pwsh.exe"

if not defined PWSH_EXE (
  echo [ERROR] PowerShell 7+ ^(pwsh.exe^) is required for Setup-Codex.
  echo [ERROR] Install PowerShell 7 and run this launcher again.
  echo [ERROR] Download: https://aka.ms/powershell-release?tag=stable
  echo.
  pause
  exit /b 1
)

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

if not exist "%~dp0internal\Setup-Codex-Internal.ps1" (
  echo [ERROR] Missing script: %~dp0internal\Setup-Codex-Internal.ps1
  echo.
  pause
  exit /b 1
)

set "NODE_NO_WARNINGS=1"
"%PWSH_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0internal\Setup-Codex-Internal.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  "%PWSH_EXE%" -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::WriteLine('[OK] Setup completed.')"
) else (
  echo [ERROR] Setup failed with exit code %EXIT_CODE%.
)
echo.
pause
exit /b %EXIT_CODE%
