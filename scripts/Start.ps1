param([switch]$NoOpen, [int]$Port = 17837, [switch]$Diagnose, [switch]$Advisor)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBase = $taskRoot
$taskStateFile = Join-Path $taskRoot 'install-state.json'
if (Test-Path -LiteralPath $taskStateFile) {
    $taskState = Get-Content -LiteralPath $taskStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskState.product -ne 'LMStudioCompanion' -or $taskState.root -ne $taskRoot -or $taskState.activeVersion -notmatch '^[a-f0-9-]{36}$') { throw 'Приложение отключено или запись установки повреждена. Запустите установку снова.' }
    $taskBase = Join-Path $taskRoot ('versions\' + $taskState.activeVersion)
}
if (Test-Path -LiteralPath (Join-Path $taskRoot '.install-lock')) { throw 'Дождитесь окончания установки или удаления.' }
if ($Advisor) { & (Join-Path $taskBase 'packages\advisor\Start-Advisor.cmd'); exit $LASTEXITCODE }
$taskNode = Join-Path $taskBase 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = Join-Path $env:USERPROFILE '.lmstudio\.internal\utils\node.exe' }
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe -ErrorAction Stop).Source }
$taskVersion = (& $taskNode '--version').Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0 -or [version]$taskVersion -lt [version]'22.21.1') { throw 'Нужен Node.js 22.21.1 или новее. Запустите Install-Companion.cmd.' }
$taskEntry = Join-Path $taskBase 'dist\host\src\main.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw 'Панель ещё не подготовлена. Запустите Install-Companion.cmd.' }
if ($Diagnose) {
    & $taskNode (Join-Path $taskBase 'dist\host\src\diagnose.js') '--output' (Join-Path $taskRoot 'data\diagnostics\capabilities.json')
} else {
    $taskArgs = @($taskEntry, '--data-dir', (Join-Path $taskRoot 'data\host'), '--port', [string]$Port)
    if (-not $NoOpen) { $taskArgs += '--open' }
    & $taskNode @taskArgs
}
exit $LASTEXITCODE