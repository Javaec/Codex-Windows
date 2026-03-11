@echo off
setlocal
cd /d "%~dp0\..\.."
call npm run forge:runtime:activate-repo-dist
exit /b %ERRORLEVEL%
