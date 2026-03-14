@echo off
setlocal

call "%~dp0build.cmd" %* -CodexCliChannel alpha
exit /b %ERRORLEVEL%
