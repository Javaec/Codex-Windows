@echo off
setlocal
call "%~dp0Setup-Codex\provider-sync\Run-Codex-Provider-Sync.cmd" %*
exit /b %errorlevel%
