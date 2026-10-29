$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskTools = Join-Path $taskRoot '.tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskNode = Join-Path $env:USERPROFILE '.lmstudio\.internal\utils\node.exe'
if (Test-Path -LiteralPath $taskNode) { $taskV = (& $taskNode '--version').Trim().TrimStart('v') } else { $taskV = '0.0.0' }
if ([version]$taskV -lt [version]'22.21.1') {
    $taskZip = Join-Path $taskTools ('node-' + $taskLock.node.version + '.zip')
    if (-not (Test-Path -LiteralPath $taskZip)) { Invoke-WebRequest -UseBasicParsing -Uri $taskLock.node.url -OutFile $taskZip }
    if ((Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskLock.node.sha256) { throw 'Контрольная сумма Node не совпала. Удалите архив из .tools и повторите.' }
    $taskRuntime = Join-Path $taskTools ('runtime-' + [guid]::NewGuid().ToString())
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($taskZip, $taskRuntime)
    $taskNode = Join-Path $taskRuntime ($taskLock.node.folder + '\node.exe')
    $taskBundled = Join-Path $taskRoot 'runtime'
    New-Item -ItemType Directory -Path $taskBundled -Force | Out-Null
    Copy-Item -LiteralPath $taskNode -Destination (Join-Path $taskBundled 'node.exe')
    Copy-Item -LiteralPath (Join-Path $taskRuntime ($taskLock.node.folder + '\LICENSE')) -Destination (Join-Path $taskBundled 'Node-LICENSE.txt')
    $taskNode = Join-Path $taskBundled 'node.exe'
}
$taskNpmArchive = Join-Path $taskTools ('npm-' + $taskLock.npm.version + '.tgz')
if (-not (Test-Path -LiteralPath $taskNpmArchive)) { Invoke-WebRequest -UseBasicParsing -Uri $taskLock.npm.url -OutFile $taskNpmArchive }
$taskSha = [Security.Cryptography.SHA512]::Create()
try { $taskDigest = [Convert]::ToBase64String($taskSha.ComputeHash([IO.File]::ReadAllBytes($taskNpmArchive))) } finally { $taskSha.Dispose() }
if ($taskDigest -ne $taskLock.npm.sha512) { throw 'Контрольная сумма npm не совпала.' }
$taskNpmDir = Join-Path $taskTools ('npm-source-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskNpmDir | Out-Null
Push-Location -LiteralPath $taskTools
try {
    # Windows tar uses the active code page for arguments: use ASCII leaves.
    & tar.exe '-xzf' (Split-Path -Leaf $taskNpmArchive) '-C' (Split-Path -Leaf $taskNpmDir)
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось распаковать npm.' }
} finally { Pop-Location }
$taskEmptyConfig = Join-Path $taskNpmDir 'empty.npmrc'
[IO.File]::WriteAllText($taskEmptyConfig, '')
$taskEmptyGlobal = Join-Path $taskNpmDir 'global.npmrc'
[IO.File]::WriteAllText($taskEmptyGlobal, '')
$taskOldPath = $env:PATH
Push-Location -LiteralPath $taskRoot
try {
    $env:PATH = (Split-Path -Parent $taskNode) + ';' + $taskOldPath
    & $taskNode (Join-Path $taskNpmDir 'package\bin\npm-cli.js') 'ci' '--ignore-scripts' '--no-audit' '--no-fund' '--registry=https://registry.npmjs.org/' ('--userconfig=' + $taskEmptyConfig) ('--globalconfig=' + $taskEmptyGlobal) ('--cache=' + (Join-Path $taskTools 'npm-cache'))
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить зависимости.' }
    & $taskNode (Join-Path $PSScriptRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Сборка не завершена.' }
} finally { $env:PATH = $taskOldPath; Pop-Location }
