@echo off
setlocal
cd /d "%~dp0\.."
call npm run electron:devtools
exit /b %ERRORLEVEL%
