@echo off
setlocal
cd /d "%~dp0\.."
call npm run build:forge -- %*
exit /b %ERRORLEVEL%
