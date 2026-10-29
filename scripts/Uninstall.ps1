$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'install-state.json'))) {
    Write-Host 'Это распакованный переносной комплект. Установленной версии в этой папке нет; ничего не удалено.'
    Write-Host 'Для удаления установленной версии откройте Uninstall-Companion.cmd в папке установки. При переносном использовании сохраните data перед удалением самой папки.'
    exit 0
}
$taskState = Get-Content -LiteralPath (Join-Path $taskRoot 'install-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskState.product -ne 'LMStudioCompanion' -or $taskState.root -ne $taskRoot -or $taskState.bootstrapVersion -notmatch '^[a-f0-9-]{36}$') { throw 'Запись установки повреждена или приложение уже удалено.' }
$taskBase = Join-Path $taskRoot ('versions\' + $taskState.bootstrapVersion)
foreach ($taskProcess in [Diagnostics.Process]::GetProcessesByName('Advisor')) {
    try { $taskExecutable = $taskProcess.MainModule.FileName } catch { continue }
    if ($taskExecutable.StartsWith($taskRoot + '\versions\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Сначала закройте советник Companion, затем повторите удаление.' }
}
$taskReceipt = & (Join-Path $taskBase 'runtime\node.exe') (Join-Path $taskBase 'dist\host\src\install-cli.js') 'uninstall' '--target' $taskRoot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$taskResult = ($taskReceipt -join "`n") | ConvertFrom-Json
if ($taskResult.root -ne $taskRoot) { throw 'Неверная папка удаления.' }
# Node has exited: remove only unchanged bundled runtimes; never recurse.
$taskDeleteDirs = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($taskProperty in $taskResult.deferred.PSObject.Properties) {
    if ($taskProperty.Name -notmatch '^(versions/[a-f0-9-]{36}/runtime/node\.exe|\.uninstall-[a-f0-9-]{36}/.+)$' -or $taskProperty.Name -match '(^|/)\.\.?(/|$)|[\\:\x00-\x1f]') { throw 'Неверный путь удаления.' }
    $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskProperty.Name))
    if (-not $taskPath.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Путь выходит из папки установки.' }
    $taskAncestor = $taskPath
    while ($taskAncestor) {
        if ((Test-Path -LiteralPath $taskAncestor) -and ((Get-Item -LiteralPath $taskAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Ссылка в пути удаления запрещена.' }
        $taskAncestor = Split-Path -Parent $taskAncestor
    }
    if (Test-Path -LiteralPath $taskPath) {
        $taskSha = [Security.Cryptography.SHA256]::Create()
        try { $taskDigest = [BitConverter]::ToString($taskSha.ComputeHash([IO.File]::ReadAllBytes($taskPath))).Replace('-', '').ToLowerInvariant() } finally { $taskSha.Dispose() }
        if ($taskDigest -eq $taskProperty.Value) { Remove-Item -LiteralPath $taskPath -Force }
    }
    $taskDirectory = Split-Path -Parent $taskPath
    while ($taskDirectory -and $taskDirectory -ne $taskRoot) { [void]$taskDeleteDirs.Add($taskDirectory); $taskDirectory = Split-Path -Parent $taskDirectory }
}
foreach ($taskDirectory in ($taskDeleteDirs | Sort-Object Length -Descending)) {
    if ((Test-Path -LiteralPath $taskDirectory) -and [IO.Directory]::GetFileSystemEntries($taskDirectory).Length -eq 0) { [IO.Directory]::Delete($taskDirectory, $false) }
}
if ($taskResult.preserved.Count -gt 0) { Write-Host ('Оставлены изменённые файлы: ' + ($taskResult.preserved -join ', ')) }
Write-Host 'Приложение удалено. Данные, резервные копии, изменённые файлы и служебные манифесты сохранены.'
