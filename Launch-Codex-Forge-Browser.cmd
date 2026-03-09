@echo off
setlocal
cd /d "%~dp0"
call npm run forge:launcher
exit /b %ERRORLEVEL%
