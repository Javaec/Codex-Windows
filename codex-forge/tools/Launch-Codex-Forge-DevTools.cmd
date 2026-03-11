@echo off
setlocal
cd /d "%~dp0\..\.."
call npm run forge:electron:devtools
exit /b %ERRORLEVEL%
