@echo off
setlocal

set "SCRIPT=%~dp0scripts\node\run.js"
if not exist "%SCRIPT%" (
  echo [ERROR] Missing %SCRIPT%
  call :maybe_pause
  exit /b 1
)

if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH.
  call :maybe_pause
  exit /b 1
)

node "%SCRIPT%" run %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERROR] run pipeline exited with code %RC%.
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
