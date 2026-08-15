@echo off
setlocal
set "NODE_NO_WARNINGS=1"
node "%~dp0cli.cjs" %*
exit /b %ERRORLEVEL%
