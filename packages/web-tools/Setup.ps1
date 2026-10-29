[CmdletBinding()]
param(
    [ValidateRange(1024,65535)][int]$Port = 8088,
    [string]$ExistingSearxngUrl = '',
    [switch]$Install,
    [switch]$SkipBuild,
    [string]$McpConfigPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.lmstudio\mcp.json')
)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
foreach ($taskRequiredFile in @('compose.yaml','Dockerfile','requirements.txt','webtools\server.py','searxng\settings.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $taskRequiredFile) -PathType Leaf)) {
        throw "Incomplete package: missing file $taskRequiredFile. Extract the entire folder before setup."
    }
}
$taskDocker = (Get-Command docker -ErrorAction Stop).Source
$taskCompose = @('compose', '--ansi', 'never', '--project-directory', $taskRoot, '-f', (Join-Path $taskRoot 'compose.yaml'))

function Invoke-TaskDocker {
    param([string[]]$DockerArgs)
    & $taskDocker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}

# Validate the existing configuration before building or changing any service.
$taskConfig = [pscustomobject]@{}
if ($Install -and (Test-Path -LiteralPath $McpConfigPath)) {
    $taskConfig = Get-Content -LiteralPath $McpConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $taskConfig -or $taskConfig -isnot [pscustomobject]) {
        throw 'Existing mcp.json must contain a JSON object. It has not been changed.'
    }
    if ($null -ne $taskConfig.mcpServers -and $taskConfig.mcpServers -isnot [pscustomobject]) {
        throw 'Existing mcpServers must be a JSON object. It has not been changed.'
    }
}

Invoke-TaskDocker -DockerArgs @('info', '--format', '{{.ServerVersion}}')
$taskEnvPath = Join-Path $taskRoot '.env'
if (-not (Test-Path -LiteralPath $taskEnvPath)) {
    $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $taskBytes = New-Object byte[] 32
    try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
    $taskSecret = -join ($taskBytes | ForEach-Object { $_.ToString('x2') })
    $taskLines = @("SEARXNG_SECRET=$taskSecret", "SEARXNG_PORT=$Port", 'BROWSER_ENABLED=true')
    if ($ExistingSearxngUrl) {
        $taskUri = [Uri]$ExistingSearxngUrl
        if (-not $taskUri.IsAbsoluteUri -or $taskUri.Scheme -notin @('http','https')) {
            throw 'ExistingSearxngUrl must be an absolute HTTP(S) URL.'
        }
        if ($taskUri.Host -in @('127.0.0.1','localhost','::1')) {
            $taskBuilder = New-Object System.UriBuilder($taskUri)
            $taskBuilder.Host = 'host.docker.internal'
            $ExistingSearxngUrl = $taskBuilder.Uri.AbsoluteUri
        }
        $taskLines += "SEARXNG_URL=$ExistingSearxngUrl"
    }
    [IO.File]::WriteAllLines($taskEnvPath, $taskLines, (New-Object Text.UTF8Encoding($false)))
}

Invoke-TaskDocker -DockerArgs ($taskCompose + @('config', '--quiet'))
if (-not $SkipBuild) { Invoke-TaskDocker -DockerArgs ($taskCompose + @('build', 'mcp')) }
$taskExistingUrl = Get-Content -LiteralPath $taskEnvPath | Where-Object { $_ -match '^SEARXNG_URL=' }
if (-not $taskExistingUrl) {
    Invoke-TaskDocker -DockerArgs ($taskCompose + @('up', '-d', '--wait', '--wait-timeout', '90', 'searxng'))
}

$taskEntry = [pscustomobject]@{
    command = $taskDocker
    args = $taskCompose + @('run', '--rm', '--no-deps', '-T', 'mcp')
}
$taskSnippet = [pscustomobject]@{mcpServers = [pscustomobject]@{'lmstudio-web' = $taskEntry}}
$taskSnippetPath = Join-Path $taskRoot 'lmstudio-mcp.json'
[IO.File]::WriteAllText($taskSnippetPath, ($taskSnippet | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))

if ($Install) {
    if ($null -eq $taskConfig.mcpServers) {
        $taskConfig | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{}) -Force
    }
    $taskConfig.mcpServers | Add-Member -MemberType NoteProperty -Name 'lmstudio-web' -Value $taskEntry -Force
    $taskDirectory = Split-Path -Parent $McpConfigPath
    if (-not (Test-Path -LiteralPath $taskDirectory)) { New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null }
    if (Test-Path -LiteralPath $McpConfigPath) {
        $taskBackup = $McpConfigPath + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak'
        Copy-Item -LiteralPath $McpConfigPath -Destination $taskBackup
        Write-Host "Backup: $taskBackup"
    }
    $taskTemp = Join-Path $taskDirectory ('mcp-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($taskTemp, ($taskConfig | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $taskTemp -Destination $McpConfigPath -Force
    } finally {
        if (Test-Path -LiteralPath $taskTemp) { Remove-Item -LiteralPath $taskTemp }
    }
    Write-Host "Installed: $McpConfigPath"
    Write-Host 'Open a new chat or reload MCP tools in LM Studio. Enable LM Studio Web tools for that chat.'
} else {
    Write-Host "Configuration snippet: $taskSnippetPath"
    Write-Host 'Use Setup.ps1 -Install to merge this server into LM Studio configuration with a backup.'
}
Write-Host 'Run Test.ps1 to check search, reading and browser rendering.'
