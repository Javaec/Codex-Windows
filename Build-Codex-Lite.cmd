@echo off
setlocal
cd /d "%~dp0"
call "%~dp0build.cmd" %*
exit /b %ERRORLEVEL%
