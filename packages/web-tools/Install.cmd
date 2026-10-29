@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" -Install
if errorlevel 1 (
  echo Installation failed. Read the error above.
)
pause
