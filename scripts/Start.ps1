param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $env:USERPROFILE '.lmstudio\.internal\utils\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe -ErrorAction Stop).Source }
$taskEntry = Join-Path $taskRoot 'dist\host\src\main.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw 'Панель ещё не собрана. Выполните npm ci --ignore-scripts и npm run build в папке проекта.' }
if ($NoOpen) { & $taskNode $taskEntry } else { & $taskNode $taskEntry '--open' }
exit $LASTEXITCODE
