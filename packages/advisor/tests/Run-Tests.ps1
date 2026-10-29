param([string]$ModulePath = (Join-Path $PSScriptRoot '..\Advisor.Core.psm1'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ModulePath)) { throw 'Advisor module missing: expected RED before implementation' }
Import-Module $ModulePath -Force
$script:passed = 0
function Assert-Equal($Actual, $Expected, [string]$Because) {
    if ($Actual -cne $Expected) { throw "$Because : expected [$Expected], actual [$Actual]" }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Output "PASS $Name"
}
Test-Case 'parse observed CLI GiB output and ignore context commas' {
    $value = ConvertFrom-AdvisorEstimate "Model: test`nContext Length: 16,384`nEstimated GPU Memory:   9.74 GiB`nEstimated Total Memory: 9.74 GiB"
    Assert-Equal $value.GpuBytes 10458245366 'GPU GiB bytes rounded to nearest byte'
    Assert-Equal $value.TotalBytes 10458245366 'Total GiB bytes rounded to nearest byte'
}
Test-Case 'decimal GB and ANSI codes are handled with explicit units' {
    $escape = [char]27
    $value = ConvertFrom-AdvisorEstimate "${escape}[32mEstimated GPU Memory: 12.5 GB${escape}[0m`nEstimated Total Memory: 20 GB"
    Assert-Equal $value.GpuBytes 12500000000 'Decimal GB is not GiB'
}
Test-Case 'CLI estimate on stderr is parsed after a successful exit' {
    $value = ConvertFrom-AdvisorEstimate -Text '' -ErrorText "Estimated GPU Memory: 9.74 GiB`nEstimated Total Memory: 9.74 GiB"
    Assert-Equal $value.GpuBytes 10458245366 'LM Studio writes estimates to stderr'
}
Test-Case 'terminal worker snapshot replaces earlier progress and rejects incomplete report' {
    $file = Join-Path $PSScriptRoot ('snapshot-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($file, '{"Status":"completed","Message":"final"}')
        Assert-Equal (Read-AdvisorFinalReport $file).Status 'completed' 'Read after observing process exit'
        [IO.File]::WriteAllText($file, '{"Status":"running","Message":"old"}')
        $rejected = $false
        try { [void](Read-AdvisorFinalReport $file) } catch { $rejected=$true }
        Assert-Equal $rejected $true 'Do not export incomplete progress as a final result'
    } finally { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
Test-Case 'missing or invalid fields stay unknown instead of zero' {
    Assert-Equal (ConvertFrom-AdvisorEstimate 'Estimated GPU Memory: unknown') $null 'Unparseable output'
    Assert-Equal (ConvertFrom-AdvisorEstimate "Estimated GPU Memory: -1 GiB`nEstimated Total Memory: 2 GiB") $null 'Negative estimate'
    Assert-Equal (ConvertFrom-AdvisorEstimate "Estimated GPU Memory: 8 GiB`nEstimated Total Memory: 2 GiB") $null 'Impossible total'
}
Test-Case 'fits device but occupied GPU is not ready now' {
    $hw = @{GpuTotalBytes=16GB; GpuFreeBytes=5GB; RamTotalBytes=32GB; RamFreeBytes=24GB; GpuCount=1}
    $r = Get-AdvisorAssessment -Estimate @{GpuBytes=10GB; TotalBytes=10GB} -Hardware $hw
    Assert-Equal $r.State 'release-needed' 'Must not claim ready when memory is occupied'
}
Test-Case 'full GPU cannot exceed physical budget' {
    $hw = @{GpuTotalBytes=16GB; GpuFreeBytes=15GB; RamTotalBytes=32GB; RamFreeBytes=24GB; GpuCount=1}
    $r = Get-AdvisorAssessment -Estimate @{GpuBytes=19GB; TotalBytes=19GB} -Hardware $hw
    Assert-Equal $r.State 'insufficient' 'Model too large even before other allocations'
}
Test-Case 'RAM estimate is conservatively budgeted without GPU subtraction' {
    $hw = @{GpuTotalBytes=16GB; GpuFreeBytes=15GB; RamTotalBytes=32GB; RamFreeBytes=12GB; GpuCount=1}
    $r = Get-AdvisorAssessment -Estimate @{GpuBytes=6GB; TotalBytes=18GB} -Hardware $hw
    Assert-Equal $r.State 'release-needed' 'Total-memory meaning uncertain: do not invent CPU-only estimate'
}
Test-Case 'available resources produce ready with explicit reserve' {
    $hw = @{GpuTotalBytes=16GB; GpuFreeBytes=15GB; RamTotalBytes=32GB; RamFreeBytes=24GB; GpuCount=1}
    Assert-Equal (Get-AdvisorAssessment -Estimate @{GpuBytes=10GB; TotalBytes=10GB} -Hardware $hw).State 'ready' '2 GiB GPU and 4 GiB RAM reserves fit'
}
Test-Case 'no GPU telemetry and multiple GPUs are unknown' {
    $hw = @{GpuTotalBytes=$null; GpuFreeBytes=$null; RamTotalBytes=32GB; RamFreeBytes=24GB; GpuCount=0}
    Assert-Equal (Get-AdvisorAssessment -Estimate @{GpuBytes=10GB; TotalBytes=10GB} -Hardware $hw).State 'unknown' 'Unknown is not fits'
    $hw.GpuCount = 2; $hw.GpuTotalBytes=32GB; $hw.GpuFreeBytes=30GB
    Assert-Equal (Get-AdvisorAssessment -Estimate @{GpuBytes=10GB; TotalBytes=10GB} -Hardware $hw).State 'unknown' 'Multi GPU placement not inferred'
}
Test-Case 'LLM inventory uses metadata and drops embedding entries' {
    $json = '[{"type":"embedding","modelKey":"emb","maxContextLength":2048},{"type":"llm","modelKey":"real@q4","displayName":"Name","maxContextLength":8192,"vision":true,"quantization":{"name":"Q4_K_M"}}]'
    $models = @(ConvertFrom-AdvisorModels $json)
    Assert-Equal $models.Count 1 'Embedding excluded'
    Assert-Equal $models[0].MaxContextLength 8192 'Metadata context'
    Assert-Equal $models[0].Key 'real@q4' 'Exact variant'
}
Test-Case 'candidate contexts never exceed advertised maximum' {
    $contexts = @(Get-AdvisorContexts 8192)
    Assert-Equal $contexts.Count 1 'Deduplicated capped contexts'
    Assert-Equal $contexts[0] 8192 'Respects maximum'
}
Test-Case 'missing context metadata is not invented' {
    Assert-Equal @(Get-AdvisorContexts 0).Count 0 'No assumptions for unknown maximum'
}
Test-Case 'recommendation prefers balanced full GPU over larger context' {
    $rows = @(
        @{ContextLength=65536;GpuRatio=1.0;State='ready'},
        @{ContextLength=16384;GpuRatio=1.0;State='ready'},
        @{ContextLength=32768;GpuRatio=1.0;State='ready'}
    )
    Assert-Equal (Select-AdvisorRecommendation $rows).ContextLength 32768 '32K balanced, not largest by default'
}
Test-Case 'recommendation avoids unknown and physical failures' {
    $rows = @(@{ContextLength=32768;GpuRatio=1.0;State='insufficient'},@{ContextLength=16384;GpuRatio=0.5;State='release-needed'})
    Assert-Equal (Select-AdvisorRecommendation $rows).GpuRatio 0.5 'Partial GPU candidate'
    Assert-Equal (Select-AdvisorRecommendation @(@{ContextLength=32768;GpuRatio=1;State='unknown'})) $null 'No fake recommendation'
}
Test-Case 'Windows command-line quoting round-trips spaces quotes and trailing slashes' {
    $fixture = Join-Path $PSScriptRoot 'Echo-Arguments.ps1'
    $cases = @('path with spaces\', 'double"quote', 'C:\folder\', 'кириллица', '')
    $result = Invoke-AdvisorProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments (@('-NoProfile','-ExecutionPolicy','Bypass','-File',$fixture) + $cases) -TimeoutSeconds 10
    Assert-Equal $result.ExitCode 0 'Fixture process executed'
    $actual = ConvertFrom-Json -InputObject $result.Stdout
    Assert-Equal $actual.Count 5 'All arguments including empty survive'
    for ($i=0; $i -lt $cases.Count; $i++) { Assert-Equal $actual[$i] $cases[$i] "Argument $i" }
}
Test-Case 'process timeout is bounded and returns explicit error' {
    $result = Invoke-AdvisorProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments @('-NoProfile','-Command','Start-Sleep -Seconds 30') -TimeoutSeconds 1
    Assert-Equal $result.TimedOut $true 'Timeout recognized'
    Assert-Equal $result.ExitCode -1 'No successful exit after timeout'
}
Test-Case 'timeout remains bounded when a child inherits output pipes' {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-AdvisorProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Hold-Pipes.ps1')) -TimeoutSeconds 1
    Assert-Equal $result.TimedOut $true 'Parent timeout recognized'
    Assert-Equal ($clock.Elapsed.TotalSeconds -lt 5) $true 'No indefinite stream wait after killing parent'
}
Test-Case 'process errors never include success' {
    $result = Invoke-AdvisorProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments @('-NoProfile','-Command','Write-Error "fixture failure"; exit 4') -TimeoutSeconds 10
    Assert-Equal $result.ExitCode 4 'Exit code retained'
    Assert-Equal ($result.Stderr -match 'fixture failure') $true 'Error retained'
}
Test-Case 'already cancelled operation does not launch a process' {
    $cancel = Join-Path $env:TEMP ('advisor-test-' + [guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($cancel, 'cancel')
    try {
        $result = Invoke-AdvisorProcess -FilePath 'does-not-exist.exe' -Arguments @() -CancelPath $cancel
        Assert-Equal $result.Cancelled $true 'No child launch after cancellation'
    } finally { Remove-Item -LiteralPath $cancel -Force }
}
Test-Case 'worker writes a clear failure report when CLI is missing' {
    $worker = Join-Path $PSScriptRoot '..\Advisor.Worker.ps1'
    if (-not (Test-Path -LiteralPath $worker)) { throw 'Worker missing: expected RED before implementation' }
    $run = Join-Path $PSScriptRoot ('advisor-test-' + [guid]::NewGuid().ToString('N'))
    try {
        $result = Invoke-AdvisorProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',$worker,'-Mode','Inventory','-RunDirectory',$run,'-LmsPath','does-not-exist.exe') -TimeoutSeconds 15
        if (-not (Test-Path -LiteralPath (Join-Path $run 'report.json'))) { throw ('Worker did not produce report: ' + $result.Stderr) }
        $report = Get-Content -LiteralPath (Join-Path $run 'report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-Equal $report.Status 'failed' 'Missing CLI explicitly reported'
        Assert-Equal $report.DidLoadModels $false 'No mutation flag'
        Assert-Equal ($report.Message.Length -gt 10) $true 'User-facing reason'
    } finally {
        if (Test-Path -LiteralPath $run) { Get-ChildItem -LiteralPath $run -File | Remove-Item -Force; Remove-Item -LiteralPath $run }
    }
}
Write-Output "RESULT $script:passed passed"
