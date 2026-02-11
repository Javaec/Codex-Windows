@echo off
setlocal

set "ENTRY=%~dp0scripts\run.ps1"
if not exist "%ENTRY%" (
  echo Missing %ENTRY%
  exit /b 1
)

if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage

set "PS_EXE="
for %%I in (pwsh.exe powershell.exe) do (
  if not defined PS_EXE (
    where %%I >nul 2>nul && set "PS_EXE=%%I"
  )
)
if not defined PS_EXE (
  echo Missing PowerShell executable in PATH
  exit /b 1
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" -BuildPortable %*
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   build.cmd
echo   build.cmd -DmgPath .\Codex.dmg
echo Optional:
echo   -WorkDir .\work  -DistDir .\dist  -Reuse  -NoLaunch  -CodexCliPath C:\path\to\codex.exe
echo   -SingleExe
echo   -DevProfile      -ProfileName dev
echo   -PersistRipgrepPath
exit /b 0
