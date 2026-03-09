@echo off
setlocal
cd /d "%~dp0"
call npm run forge:runtime:import-runner-smoke
exit /b %ERRORLEVEL%
