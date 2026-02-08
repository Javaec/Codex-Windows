@echo off
setlocal

set "SCRIPT=%~dp0scripts\run.ps1"
if not exist "%SCRIPT%" (
  echo Missing %SCRIPT%
  exit /b 1
)

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage
if "%~1"=="" goto usage

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   run.cmd
echo   run.cmd -DmgPath .\Codex.dmg
echo Optional:
echo   -WorkDir .\work  -CodexCliPath C:\path\to\codex.exe  -Reuse  -NoLaunch
echo   -BuildPortable   -DistDir .\dist
exit /b 0
