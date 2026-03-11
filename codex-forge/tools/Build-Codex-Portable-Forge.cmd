@echo off
setlocal

set "ENTRY=%~dp0\..\..\scripts\run.ps1"
if not exist "%ENTRY%" (
  echo Missing %ENTRY%
  exit /b 1
)

set "PS_EXE="
for %%I in (pwsh.exe powershell.exe) do (
  if not defined PS_EXE (
    where %%I >nul 2>nul && set "PS_EXE=%%I"
  )
)
if not defined PS_EXE (
  echo Missing PowerShell executable in PATH
  exit /b 1
)

pushd "%~dp0\..\.."
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" -BuildPortable -NoLaunch -ProfileName forge %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
