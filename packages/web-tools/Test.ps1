[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskDocker = (Get-Command docker -ErrorAction Stop).Source
& $taskDocker compose --ansi never --project-directory $PSScriptRoot -f (Join-Path $PSScriptRoot 'compose.yaml') run --rm --no-deps -T mcp python diagnostics.py
if ($LASTEXITCODE -ne 0) { throw 'Diagnostics failed; read the messages above.' }
