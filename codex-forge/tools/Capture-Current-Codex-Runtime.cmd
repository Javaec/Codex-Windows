@echo off
setlocal
cd /d "%~dp0\.."
call npm run runtime:capture
exit /b %ERRORLEVEL%
