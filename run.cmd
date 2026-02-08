@echo off
setlocal

set "SCRIPT=%~dp0scripts\run.ps1"
if not exist "%SCRIPT%" (
  echo [ERROR] Missing %SCRIPT%
  call :maybe_pause
  exit /b 1
)

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERROR] run.ps1 exited with code %RC%.
  call :maybe_pause
  exit /b %RC%
)
exit /b 0

:usage
echo Usage:
echo   run.cmd
echo   run.cmd -DmgPath .\Codex.dmg
echo Optional:
echo   -WorkDir .\work  -CodexCliPath C:\path\to\codex.exe  -Reuse  -NoLaunch
echo   -BuildPortable   -DistDir .\dist
echo   -DevProfile      -ProfileName dev
echo   -PersistRipgrepPath
exit /b 0

:maybe_pause
if defined CODEX_NO_PAUSE exit /b 0
echo Press any key to close...
pause >nul
exit /b 0
