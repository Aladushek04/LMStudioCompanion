@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start.ps1" -Diagnose
set "taskExitCode=%errorlevel%"
pause
exit /b %taskExitCode%
