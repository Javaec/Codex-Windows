@echo off
setlocal
cd /d "%~dp0"
call npm run forge:runtime:capture
exit /b %ERRORLEVEL%
