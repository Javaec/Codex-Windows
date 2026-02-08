@echo off
setlocal

set "SCRIPT=%~dp0scripts\node\run.js"
if not exist "%SCRIPT%" (
  echo Missing %SCRIPT%
  exit /b 1
)

if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage
if "%~1"=="" goto usage

where node >nul 2>nul
if errorlevel 1 (
  echo Missing node.exe in PATH
  exit /b 1
)

node "%SCRIPT%" build %*
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   build.cmd
echo   build.cmd -DmgPath .\Codex.dmg
echo Optional:
echo   -WorkDir .\work  -DistDir .\dist  -Reuse  -NoLaunch  -CodexCliPath C:\path\to\codex.exe
echo   -DevProfile      -ProfileName dev
echo   -PersistRipgrepPath
exit /b 0
