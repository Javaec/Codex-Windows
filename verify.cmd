@echo off
setlocal

set "ROOT=%~dp0"
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

"%NODE_EXE%" "%ROOT%scripts\node\run.js" verify %*
exit /b %ERRORLEVEL%
