@echo off
setlocal
if exist "%~dp0Advisor.exe" (
  start "LM Studio Advisor" "%~dp0Advisor.exe"
) else (
  start "LM Studio Advisor" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Advisor.ps1"
)
endlocal
