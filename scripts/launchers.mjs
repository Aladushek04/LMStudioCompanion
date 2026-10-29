/** Windows launchers preserve the operation result and leave reports readable. */
export function wrapper(flag, pause = false) {
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\Start.ps1" -${flag}\r\nset "taskExitCode=%errorlevel%"\r\n${pause ? 'pause' : 'if not "%taskExitCode%"=="0" pause'}\r\nexit /b %taskExitCode%\r\n`;
}
