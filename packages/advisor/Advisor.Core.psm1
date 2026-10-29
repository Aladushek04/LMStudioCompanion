Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-AdvisorProperty($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
    } elseif ($null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function ConvertTo-AdvisorArgument([string]$Value) {
    # Windows CRT quoting: double backslashes before quotes and the closing quote.
    if ($null -eq $Value) { $Value = '' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Stop-AdvisorProcessTree([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $info.Arguments = '/PID ' + $Process.Id + ' /T /F'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $killer = New-Object Diagnostics.Process
    $killer.StartInfo = $info
    try {
        [void]$killer.Start()
        [void]$killer.WaitForExit(2000)
        if (-not $Process.HasExited) { $Process.Kill() }
    } catch { if (-not $Process.HasExited) { $Process.Kill() } }
    finally { $killer.Dispose() }
}

function Invoke-AdvisorProcess {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 30, [string]$CancelPath = '')
    if ($CancelPath -and (Test-Path -LiteralPath $CancelPath)) {
        return [pscustomobject]@{ExitCode=-1; Stdout=''; Stderr=''; TimedOut=$false; Cancelled=$true}
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-AdvisorArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $info.EnvironmentVariables['NO_COLOR'] = '1'
    $info.EnvironmentVariables['FORCE_COLOR'] = '0'
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false
    $cancelled = $false
    try {
        [void]$process.Start()
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        while (-not $process.WaitForExit(100)) {
            $cancelled = $CancelPath -and (Test-Path -LiteralPath $CancelPath)
            $timedOut = $clock.Elapsed.TotalSeconds -ge $TimeoutSeconds
            if ($timedOut -or $cancelled) { Stop-AdvisorProcessTree $process; [void]$process.WaitForExit(1000); break }
        }
        $stdout=''; $stderr=''
        # A child can inherit pipes even after its parent exits; stream collection is bounded too.
        if ($outTask.Wait(500)) { $stdout=$outTask.GetAwaiter().GetResult() }
        if ($errTask.Wait(500)) { $stderr=$errTask.GetAwaiter().GetResult() }
        return [pscustomobject]@{
            ExitCode = $(if ($timedOut -or $cancelled) { -1 } else { $process.ExitCode })
            Stdout = $stdout
            Stderr = $stderr
            TimedOut = [bool]$timedOut
            Cancelled = [bool]$cancelled
        }
    } finally { $process.Dispose() }
}

function Find-AdvisorLms {
    $default = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
    if (Test-Path -LiteralPath $default -PathType Leaf) { return $default }
    $command = Get-Command lms.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw 'LM Studio CLI не найден. Откройте LM Studio и установите CLI lms в настройках программы.'
}

function ConvertFrom-AdvisorModels([string]$Json) {
    $parsed = ConvertFrom-Json -InputObject $Json -ErrorAction Stop
    foreach ($model in @($parsed)) {
        if ((Get-AdvisorProperty $model 'type') -ne 'llm') { continue }
        $key = [string](Get-AdvisorProperty $model 'modelKey' '')
        if (-not $key -or $key.StartsWith('-') -or $key -match '[\x00-\x1f]') { continue }
        $maxContext = 0L
        [void][long]::TryParse([string](Get-AdvisorProperty $model 'maxContextLength' ''), [ref]$maxContext)
        [pscustomobject]@{
            Key = $key
            Name = [string](Get-AdvisorProperty $model 'displayName' $key)
            Format = [string](Get-AdvisorProperty $model 'format' '')
            Quantization = [string](Get-AdvisorProperty (Get-AdvisorProperty $model 'quantization') 'name' '')
            MaxContextLength = $maxContext
            Vision = [bool](Get-AdvisorProperty $model 'vision' $false)
            SizeBytes = Get-AdvisorProperty $model 'sizeBytes'
        }
    }
}

function ConvertFrom-AdvisorEstimate([string]$Text, [string]$ErrorText = '') {
    $clean = [regex]::Replace(($Text + "`n" + $ErrorText), '\x1b\[[0-?]*[ -/]*[@-~]', '')
    $values = @{}
    foreach ($field in @('GPU', 'Total')) {
        $pattern = '(?im)^\s*Estimated ' + $field + ' Memory:\s*([0-9]+(?:\.[0-9]+)?)\s*(GiB|MiB|KiB|GB|MB|KB|B)\s*$'
        $match = [regex]::Match($clean, $pattern)
        if (-not $match.Success) { return $null }
        $number = [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
        $multiplier = switch ($match.Groups[2].Value.ToUpperInvariant()) {
            'GIB' { 1073741824.0 }; 'MIB' { 1048576.0 }; 'KIB' { 1024.0 }
            'GB' { 1000000000.0 }; 'MB' { 1000000.0 }; 'KB' { 1000.0 }; 'B' { 1.0 }
        }
        $bytes = $number * $multiplier
        if ($bytes -lt 0 -or $bytes -gt [long]::MaxValue -or [double]::IsInfinity($bytes)) { return $null }
        $values[$field] = [long][Math]::Round($bytes)
    }
    if ($values.Total -lt $values.GPU -or $values.Total -le 0) { return $null }
    return [pscustomobject]@{GpuBytes=$values.GPU; TotalBytes=$values.Total}
}

function Get-AdvisorContexts([long]$MaxContextLength) {
    if ($MaxContextLength -lt 1) { return }
    @(16384, 32768, 65536) | ForEach-Object { [Math]::Min($_, $MaxContextLength) } | Select-Object -Unique
}

function Read-AdvisorFinalReport([string]$Path) {
    $snapshot = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ((Get-AdvisorProperty $snapshot 'Status' '') -notin @('completed','failed','cancelled')) {
        throw 'Фоновая проверка завершилась без итогового отчёта.'
    }
    return $snapshot
}

function Get-AdvisorAssessment {
    param($Estimate, $Hardware)
    $gpuTotal = Get-AdvisorProperty $Hardware 'GpuTotalBytes'
    $gpuFree = Get-AdvisorProperty $Hardware 'GpuFreeBytes'
    $ramTotal = Get-AdvisorProperty $Hardware 'RamTotalBytes'
    $ramFree = Get-AdvisorProperty $Hardware 'RamFreeBytes'
    $gpu = Get-AdvisorProperty $Estimate 'GpuBytes'
    $total = Get-AdvisorProperty $Estimate 'TotalBytes'
    if ($null -eq $Estimate -or $null -eq $gpu -or $null -eq $total -or
        $null -eq $gpuTotal -or $null -eq $gpuFree -or $null -eq $ramTotal -or $null -eq $ramFree -or
        (Get-AdvisorProperty $Hardware 'GpuCount' 0) -ne 1) {
        return [pscustomobject]@{State='unknown'; Label='Оценка неполная'; Reason='Нет полной телеметрии одной NVIDIA GPU, RAM или оценки LM Studio. Подходящий профиль не подтверждён.'}
    }
    if ($gpu -gt ($gpuTotal - 2GB) -or $total -gt ($ramTotal - 4GB)) {
        return [pscustomobject]@{State='insufficient'; Label='Мало запаса'; Reason='Оценка превышает бюджет устройства с запасом 2 ГиБ GPU и 4 ГиБ RAM. Попробуйте меньший контекст или частичную выгрузку.'}
    }
    if ($gpu -le ($gpuFree - 2GB) -and $total -le ($ramFree - 4GB)) {
        return [pscustomobject]@{State='ready'; Label='Есть запас сейчас'; Reason='Оценка помещается в свободную память с заданным запасом. Это предварительная оценка, а не гарантия успешной загрузки.'}
    }
    return [pscustomobject]@{State='release-needed'; Label='Нужно освободить память'; Reason='По общей ёмкости вариант подходит, но сейчас свободной памяти недостаточно. Запущенная модель тоже занимает память; освобождаемый ею объём здесь не угадан.'}
}

function Select-AdvisorRecommendation($Rows) {
    $eligible = @($Rows | Where-Object { $_.State -in @('ready','release-needed') })
    if ($eligible.Count -eq 0) { return $null }
    # Prefer full GPU, then balanced 32K; a larger context is not presumed faster.
    return $eligible | Sort-Object @{Expression={$_.GpuRatio};Descending=$true}, @{Expression={
        if ($_.ContextLength -eq 32768) { 0 } elseif ($_.ContextLength -lt 32768) { 1 } else { 2 }
    }}, @{Expression={$_.ContextLength};Descending=$true} | Select-Object -First 1
}

function Get-AdvisorHardware([string]$CancelPath = '') {
    $warnings = New-Object 'Collections.Generic.List[string]'
    $ramTotal=$null; $ramFree=$null; $cpuName='Не определён'; $cpuCores=$null
    try {
        $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 8
        $ramTotal = [long]$os.TotalVisibleMemorySize * 1024
        $ramFree = [long]$os.FreePhysicalMemory * 1024
        $cpu = Get-CimInstance Win32_Processor -OperationTimeoutSec 8 | Select-Object -First 1
        $cpuName = [string]$cpu.Name; $cpuCores = $cpu.NumberOfCores
    } catch { $warnings.Add('Не удалось прочитать сведения RAM/CPU через Windows: ' + $_.Exception.Message) }
    $gpuTotal=$null; $gpuFree=$null; $gpuName='Не определена'; $gpuCount=0
    try {
        $smi = Get-Command nvidia-smi.exe -ErrorAction Stop
        $probe = Invoke-AdvisorProcess $smi.Source @('--query-gpu=index,name,memory.total,memory.free','--format=csv,noheader,nounits') 10 $CancelPath
        if ($probe.ExitCode -ne 0) { throw 'nvidia-smi не вернул данные' }
        $cards = @($probe.Stdout | ConvertFrom-Csv -Header 'Index','Name','TotalMiB','FreeMiB')
        $gpuCount = $cards.Count
        if ($gpuCount -eq 1) {
            $gpuName = $cards[0].Name.Trim()
            $gpuTotal = [long]::Parse($cards[0].TotalMiB.Trim(), [Globalization.CultureInfo]::InvariantCulture) * 1MB
            $gpuFree = [long]::Parse($cards[0].FreeMiB.Trim(), [Globalization.CultureInfo]::InvariantCulture) * 1MB
        } else { $warnings.Add('Несколько GPU: автоматическая оценка распределения между картами пока не поддерживается.') }
    } catch { $warnings.Add('Телеметрия NVIDIA недоступна. Полная оценка пригодности профиля невозможна.') }
    [pscustomobject]@{CpuName=$cpuName; CpuCores=$cpuCores; RamTotalBytes=$ramTotal; RamFreeBytes=$ramFree; GpuName=$gpuName; GpuTotalBytes=$gpuTotal; GpuFreeBytes=$gpuFree; GpuCount=$gpuCount; Warnings=@($warnings)}
}

function Get-AdvisorEstimate {
    param([string]$LmsPath, [string]$ModelKey, [long]$ContextLength, [double]$GpuRatio, [string]$CancelPath = '')
    if (-not $ModelKey -or $ModelKey.StartsWith('-') -or $ModelKey -match '[\x00-\x1f]') { throw 'Неверный ключ модели.' }
    if ($ContextLength -le 0 -or $GpuRatio -le 0 -or $GpuRatio -gt 1) { throw 'Неверные параметры оценки.' }
    $ratioText = $GpuRatio.ToString('0.##', [Globalization.CultureInfo]::InvariantCulture)
    if ($GpuRatio -eq 1) { $ratioText = 'max' }
    $arguments = @('load',$ModelKey,'--context-length',[string]$ContextLength,'--gpu',$ratioText,'--parallel','1','--no-engine-config-file','--estimate-only','--yes')
    $result = Invoke-AdvisorProcess $LmsPath $arguments 35 $CancelPath
    if ($result.Cancelled) { throw 'Проверка отменена.' }
    $estimate = $null
    if ($result.ExitCode -eq 0) { $estimate = ConvertFrom-AdvisorEstimate -Text $result.Stdout -ErrorText $result.Stderr }
    [pscustomobject]@{
        Estimate=$estimate; Arguments=$arguments; RawOutput=$result.Stdout; ErrorOutput=$result.Stderr
        Error=$(if ($result.TimedOut) {'LM Studio не ответила за 35 секунд.'} elseif ($result.ExitCode -ne 0) {'LM Studio не смогла оценить этот вариант.'} elseif ($null -eq $estimate) {'Формат оценки LM Studio не распознан.'} else {$null})
    }
}

function Format-AdvisorGiB($Bytes) {
    if ($null -eq $Bytes) { return 'нет данных' }
    return ([double]$Bytes / 1GB).ToString('0.00', [Globalization.CultureInfo]::GetCultureInfo('ru-RU')) + ' ГиБ'
}

Export-ModuleMember -Function *-Advisor*
