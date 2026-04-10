@echo off
setlocal

set "ENTRY=%~dp0Setup-Codex\internal\Run-Setup-Codex-Internal.ps1"
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

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" -BuildPortable -NoLaunch -ProfileName lite %*
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   build.cmd
echo   build.cmd -DmgPath .\Codex.dmg
echo Optional:
echo   -WorkDir .\work  -DistDir .\dist  -Reuse  -NoLaunch  -CodexCliPath C:\path\to\codex.exe
echo   -CodexCliChannel alpha
echo   -SingleExe
echo   -ProfileName lite ^| forge ^| dev
echo.
echo Patch profile selection:
echo   The runner extracts app metadata from the DMG and prefers internal version identity
echo   ^(package.json version + codexBuildNumber^) over the DMG file name.
echo   Snapshot file names remain fallback-only for unknown builds.
echo.
echo Default behavior:
echo   build.cmd builds Codex Lite.
echo   Codex Lite = Codex Repack: minimal Windows repack with bundled rg.exe, required path fixes, and no Forge mod runtime.
exit /b 0
