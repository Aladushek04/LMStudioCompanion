@echo off
chcp 65001 >nul
setlocal
set "taskNode=%USERPROFILE%\.lmstudio\.internal\utils\node.exe"
if exist "%taskNode%" goto run
set "taskNode=node"
where.exe node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите LM Studio или Node.js 22.21.1 и новее.
  pause
  exit /b 1
)
:run
if not exist "%~dp0dist\host\src\diagnose.js" (
  echo Диагностика ещё не собрана. Инструкция: packages\host\README.md
  pause
  exit /b 1
)
"%taskNode%" "%~dp0dist\host\src\diagnose.js"
set "taskExitCode=%errorlevel%"
pause
exit /b %taskExitCode%
