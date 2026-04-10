@echo off
setlocal

set "ENTRY=%~dp0Setup-Codex\internal\Run-Setup-Codex-Internal.ps1"
if not exist "%ENTRY%" (
  echo [ERROR] Missing %ENTRY%
  call :maybe_pause
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
  echo [ERROR] PowerShell executable not found in PATH.
  call :maybe_pause
  exit /b 1
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" %*
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
echo   -BuildPortable   -SingleExe   -DistDir .\dist
echo   -ProfileName lite ^| forge ^| dev
echo.
echo Notes:
echo   build.cmd builds Codex Lite by default.
echo   Codex Lite = Codex Repack.
echo   Use -ProfileName forge only when you explicitly want the Forge mod runtime bundled.
exit /b 0

:maybe_pause
if defined CODEX_NO_PAUSE exit /b 0
echo Press any key to close...
pause >nul
exit /b 0
