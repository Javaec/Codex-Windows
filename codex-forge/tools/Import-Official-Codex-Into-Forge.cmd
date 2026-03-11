@echo off
setlocal
cd /d "%~dp0\.."
call npm run runtime:import-official
exit /b %ERRORLEVEL%
