@echo off
setlocal

set "DEFAULT_SNAPSHOT=%~dp0codex-26-506-31421.zip"
set "CODEX_WINDOWS_USE_ELECTRON_DIST_RUNTIME=1"

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

for %%I in ("%USERPROFILE%\scoop\shims" "%LOCALAPPDATA%\Microsoft\WinGet\Links") do (
  if exist "%%~I\7z.exe" set "PATH=%%~I;%PATH%"
)

if "%~1"=="" if exist "%DEFAULT_SNAPSHOT%" (
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" -BuildPortable -NoLaunch -ProfileName lite -DmgPath "%DEFAULT_SNAPSHOT%"
  exit /b %ERRORLEVEL%
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" -BuildPortable -NoLaunch -ProfileName lite %*
exit /b %ERRORLEVEL%

:usage
echo Usage:
echo   build.cmd
echo   build.cmd -DmgPath .\Codex.dmg
echo   build.cmd -DmgPath .\codex-26-506-31421.zip
echo Optional:
echo   -WorkDir .\work  -DistDir .\dist  -Reuse  -NoLaunch  -CodexCliPath C:\path\to\codex.exe
echo   -CodexCliChannel alpha
echo   -SingleExe
echo   -ProfileName lite ^| forge ^| dev
echo.
echo Patch profile selection:
echo   The runner extracts app metadata from the source archive and prefers internal version identity
echo   ^(package.json version + codexBuildNumber^) over the archive file name.
echo   Snapshot file names remain fallback-only for unknown builds.
echo.
echo Default behavior:
echo   build.cmd builds Codex Lite.
echo   If codex-26-506-31421.zip exists and no source archive is passed, it is used by default.
echo   build.cmd uses a plain Electron runtime shell for this ZIP so the latest installed Codex.exe cannot reject resources\app before startup.
echo   Codex Lite = Codex Repack: minimal Windows repack with bundled rg.exe, required path fixes, and no Forge mod runtime.
exit /b 0
