$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'install-state.json'))) {
    Write-Host 'Это распакованный переносной комплект. Здесь нет предыдущей установленной версии для отката.'
    Write-Host 'После установки запускайте Rollback-Companion.cmd из папки установленного приложения. Для установки откройте Install-Companion.cmd.'
    exit 0
}
$taskState = Get-Content -LiteralPath (Join-Path $taskRoot 'install-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskState.product -ne 'LMStudioCompanion' -or $taskState.root -ne $taskRoot -or $taskState.bootstrapVersion -notmatch '^[a-f0-9-]{36}$') { throw 'Запись установки повреждена.' }
$taskBase = Join-Path $taskRoot ('versions\' + $taskState.bootstrapVersion)
& (Join-Path $taskBase 'runtime\node.exe') (Join-Path $taskBase 'dist\host\src\install-cli.js') 'rollback' '--target' $taskRoot
exit $LASTEXITCODE
