@echo off
setlocal
cd /d "%~dp0\..\.."
call npm run forge:runtime:import-official
exit /b %ERRORLEVEL%
