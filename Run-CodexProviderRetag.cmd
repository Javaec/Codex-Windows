@echo off
setlocal
node "%~dp0scripts\node\CodexProviderRetag.cjs" %*
exit /b %errorlevel%