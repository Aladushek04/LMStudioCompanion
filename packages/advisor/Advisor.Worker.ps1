param(
    [Parameter(Mandatory=$true)][ValidateSet('Inventory','Analyze')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$RunDirectory,
    [string]$ModelKey = '',
    [string]$LmsPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'Advisor.Core.psm1') -Force
[void][IO.Directory]::CreateDirectory($RunDirectory)
$reportPath = Join-Path $RunDirectory 'report.json'
$cancelPath = Join-Path $RunDirectory 'cancel'
$report = [ordered]@{
    SchemaVersion=1; Status='running'; Mode=$Mode; DidLoadModels=$false
    StartedAt=[DateTime]::UtcNow.ToString('o'); FinishedAt=$null
    Message='Проверяем LM Studio и оборудование...'; Progress=0
    Models=@(); Loaded=@(); Hardware=$null; Rows=@(); RecommendedIndex=-1
    Warnings=@(); CliPath=''; ModelKey=$ModelKey; ModelName=''
    EstimatePolicy='Только --estimate-only; parallel=1; стандартные настройки LM Studio, без engine-config-файла. Скорость не измерялась. Запас: 2 ГиБ GPU и 4 ГиБ RAM. Total Memory консервативно сравнивается с RAM целиком.'
}
function Save-Report {
    $temp = $reportPath + '.tmp'
    $json = ConvertTo-Json -InputObject $report -Depth 12
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($reportPath)) { [IO.File]::Replace($temp, $reportPath, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temp, $reportPath) }
}
function Assert-NotCancelled {
    if (Test-Path -LiteralPath $cancelPath) { throw 'Проверка отменена.' }
}
function Read-LoadedModels {
    $probe = Invoke-AdvisorProcess -FilePath $LmsPath -Arguments @('ps','--json') -TimeoutSeconds 15 -CancelPath $cancelPath
    if ($probe.Cancelled) { Assert-NotCancelled }
    if ($probe.ExitCode -ne 0) { throw 'Не удалось получить список загруженных моделей.' }
    $parsed = ConvertFrom-Json -InputObject $probe.Stdout
    foreach ($item in @($parsed)) {
        if ($null -eq $item) { continue }
        [pscustomobject]@{
            Identifier=Get-AdvisorProperty $item 'identifier' ''
            Key=Get-AdvisorProperty $item 'modelKey' ''
            ContextLength=Get-AdvisorProperty $item 'contextLength'
        }
    }
}
function Add-EstimateRow([long]$ContextLength, [double]$GpuRatio) {
    Assert-NotCancelled
    $report.Message = 'Оцениваем контекст ' + $ContextLength.ToString('N0') + ', GPU ' + ($GpuRatio*100) + '%...'
    Save-Report
    $raw = Get-AdvisorEstimate -LmsPath $LmsPath -ModelKey $ModelKey -ContextLength $ContextLength -GpuRatio $GpuRatio -CancelPath $cancelPath
    $assessment = Get-AdvisorAssessment -Estimate $raw.Estimate -Hardware $report.Hardware
    if ($raw.Error) { $assessment.Reason = $raw.Error }
    $report.Rows += [pscustomobject]@{
        ContextLength=$ContextLength; GpuRatio=$GpuRatio
        GpuBytes=Get-AdvisorProperty $raw.Estimate 'GpuBytes'
        TotalBytes=Get-AdvisorProperty $raw.Estimate 'TotalBytes'
        State=$assessment.State; Label=$assessment.Label; Reason=$assessment.Reason
        Error=$raw.Error; Arguments=$raw.Arguments; RawOutput=$raw.RawOutput; ErrorOutput=$raw.ErrorOutput
        Measured=$false
    }
    $report.Progress = [Math]::Min(90, 15 + $report.Rows.Count * 10)
    Save-Report
}
try {
    Save-Report
    Assert-NotCancelled
    if (-not $LmsPath) { $LmsPath = Find-AdvisorLms }
    if (-not (Test-Path -LiteralPath $LmsPath -PathType Leaf)) { throw 'CLI LM Studio не найден. Откройте LM Studio и установите CLI lms.' }
    $report.CliPath = $LmsPath
    $help = Invoke-AdvisorProcess -FilePath $LmsPath -Arguments @('load','--help') -TimeoutSeconds 15 -CancelPath $cancelPath
    foreach ($flag in @('--estimate-only','--context-length','--gpu','--parallel','--no-engine-config-file')) {
        if ($help.ExitCode -ne 0 -or $help.Stdout -notmatch [regex]::Escape($flag)) { throw "CLI не поддерживает нужную опцию $flag. Обновите LM Studio/CLI и повторите проверку." }
    }
    $ls = Invoke-AdvisorProcess -FilePath $LmsPath -Arguments @('ls','--json') -TimeoutSeconds 20 -CancelPath $cancelPath
    Assert-NotCancelled
    if ($ls.ExitCode -ne 0) { throw 'Не удалось прочитать модели. Запустите LM Studio и повторите проверку.' }
    $report.Models = @(ConvertFrom-AdvisorModels $ls.Stdout)
    $report.Loaded = @(Read-LoadedModels)
    $before = ConvertTo-Json -InputObject @($report.Loaded | Sort-Object Identifier) -Compress
    $report.Hardware = Get-AdvisorHardware $cancelPath
    $report.Warnings = @($report.Hardware.Warnings)
    Save-Report
    if ($Mode -eq 'Analyze') {
        $model = $report.Models | Where-Object { $_.Key -ceq $ModelKey } | Select-Object -First 1
        if ($null -eq $model) { throw 'Выбранная модель не найдена среди скачанных. Обновите список.' }
        if ($model.Format -ne 'gguf') { throw 'Первая версия советника оценивает GGUF-модели на Windows.' }
        $report.ModelName = $model.Name
        $contexts = @(Get-AdvisorContexts $model.MaxContextLength)
        if ($contexts.Count -eq 0) { throw 'LM Studio не указала предел контекста модели. Подбирать значения наугад советник не будет.' }
        foreach ($context in $contexts) { Add-EstimateRow $context 1.0 }
        $fullFit = @($report.Rows | Where-Object { $_.State -in @('ready','release-needed') })
        if ($fullFit.Count -eq 0 -and $report.Hardware.GpuCount -eq 1) {
            foreach ($ratio in @(0.75,0.5)) {
                foreach ($context in @($contexts | Where-Object { $_ -le 32768 })) { Add-EstimateRow $context $ratio }
                if (@($report.Rows | Where-Object { $_.State -in @('ready','release-needed') }).Count -gt 0) { break }
            }
        }
        Assert-NotCancelled
        # Refresh telemetry at the end: another application may have allocated memory.
        $report.Hardware = Get-AdvisorHardware $cancelPath
        $report.Warnings = @($report.Hardware.Warnings)
        foreach ($row in $report.Rows) {
            $estimate = $null
            if ($null -ne $row.GpuBytes -and $null -ne $row.TotalBytes) { $estimate = @{GpuBytes=$row.GpuBytes;TotalBytes=$row.TotalBytes} }
            $assessment = Get-AdvisorAssessment -Estimate $estimate -Hardware $report.Hardware
            $row.State=$assessment.State; $row.Label=$assessment.Label
            $row.Reason=$(if ($row.Error) {$row.Error} else {$assessment.Reason})
        }
        $best = Select-AdvisorRecommendation $report.Rows
        if ($null -ne $best) { $report.RecommendedIndex = [Array]::IndexOf($report.Rows, $best) }
        $afterLoaded = @(Read-LoadedModels)
        $after = ConvertTo-Json -InputObject @($afterLoaded | Sort-Object Identifier) -Compress
        if ($before -cne $after) { $report.Warnings += 'Во время проверки список загрузок изменился. Это могло произойти в LM Studio параллельно; повторите оценку при стабильной загрузке.' }
        $report.Message = 'Готово. Это предварительная оценка памяти; загрузка и скорость не проверялись.'
    } else {
        $report.Message = $(if ($report.Models.Count) {'Выберите модель и нажмите «Проверить настройки».'} else {'Нет скачанных LLM-моделей. Скачайте модель в LM Studio и обновите список.'})
    }
    Assert-NotCancelled
    $report.Status='completed'; $report.Progress=100
} catch {
    $report.Status=$(if (Test-Path -LiteralPath $cancelPath) {'cancelled'} else {'failed'})
    $report.Message=$_.Exception.Message
} finally {
    $report.FinishedAt=[DateTime]::UtcNow.ToString('o')
    Save-Report
}
if ($report.Status -eq 'failed') { exit 1 }
