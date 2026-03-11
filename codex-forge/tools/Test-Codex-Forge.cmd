@echo off
setlocal
cd /d "%~dp0\.."

call npm run test || exit /b %ERRORLEVEL%

echo.
echo [OK] Codex Forge test flow passed.
exit /b 0
