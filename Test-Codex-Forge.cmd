@echo off
setlocal
cd /d "%~dp0"

call npm run build:runner || exit /b %ERRORLEVEL%
call npm run forge:state || exit /b %ERRORLEVEL%
call npm run forge:runtime:sources || exit /b %ERRORLEVEL%
call npm run mods:compatibility-matrix || exit /b %ERRORLEVEL%
call npm run patch-pack:preflight:11012 || exit /b %ERRORLEVEL%
call npm run forge:electron:smoke || exit /b %ERRORLEVEL%

echo.
echo [OK] Codex Forge test flow passed.
exit /b 0
