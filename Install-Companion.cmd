@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install.ps1"
set "taskExitCode=%errorlevel%"
pause
exit /b %taskExitCode%
