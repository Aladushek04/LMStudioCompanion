param([string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\LMStudioCompanion'), [switch]$Apply, [switch]$Preview)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'release-manifest.json'))) {
    if ($Preview) { Write-Host 'Подготовка исходников: проверенный Node/npm, зависимости из lockfile и локальная сборка. LM Studio и MCP не меняются.'; exit 0 }
    & (Join-Path $PSScriptRoot 'PrepareSource.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Подготовлено. Откройте Start-Companion.cmd.'; exit 0
}
$taskNode = Join-Path $taskRoot 'runtime\node.exe'
$taskEntry = Join-Path $taskRoot 'dist\host\src\install-cli.js'
& $taskNode $taskEntry 'preview' '--source' $taskRoot '--target' $Target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Preview) { exit 0 }
if (-not $Apply -and (Read-Host 'Нажмите Enter для установки; N для отмены') -ne '') { Write-Host 'Установка отменена.'; exit 0 }
& $taskNode $taskEntry 'install' '--source' $taskRoot '--target' $Target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ('Готово. Запуск: ' + (Join-Path $Target 'Start-Companion.cmd'))
