param([switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Advisor.Core.psm1') -Force
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$script:worker=$null; $script:workerError=$null; $script:runPath=''; $script:lastStamp=''; $script:lastReport=$null
$script:models=@(); $script:cancelAt=$null; $script:closing=$false
$script:dataRoot = Join-Path $PSScriptRoot 'data\runs'
$script:form = New-Object Windows.Forms.Form
$form.Text='LM Studio Companion — Советник по настройкам'
$form.Size=New-Object Drawing.Size(1220,860)
$form.MinimumSize=New-Object Drawing.Size(1040,760)
$form.StartPosition='CenterScreen'
$form.Font=New-Object Drawing.Font('Segoe UI',10)
$form.BackColor=[Drawing.Color]::FromArgb(246,248,252)
$form.AutoScaleMode='Font'
$root=New-Object Windows.Forms.TableLayoutPanel
$root.Dock='Fill'; $root.Padding=New-Object Windows.Forms.Padding(22); $root.ColumnCount=1; $root.RowCount=9
foreach ($height in @(42,40,84,42,44,0,100,68,30)) {
    if ($height -eq 0) { [void]$root.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent',100))) }
    else { [void]$root.RowStyles.Add((New-Object Windows.Forms.RowStyle('Absolute',$height))) }
}
$form.Controls.Add($root)
function New-Label([string]$Text) {
    $label=New-Object Windows.Forms.Label; $label.Text=$Text; $label.Dock='Fill'; $label.TextAlign='MiddleLeft'; return $label
}
function New-Button([string]$Text, [int]$Width=150) {
    $button=New-Object Windows.Forms.Button; $button.Text=$Text; $button.Width=$Width; $button.Height=34
    $button.FlatStyle='System'; $button.Margin=New-Object Windows.Forms.Padding(0,2,10,2); return $button
}
$title=New-Label 'Настройки под ваш компьютер'
$title.Font=New-Object Drawing.Font('Segoe UI',19,[Drawing.FontStyle]::Bold)
$title.ForeColor=[Drawing.Color]::FromArgb(31,56,100); $root.Controls.Add($title,0,0)
$subtitle=New-Label 'Выберите скачанную модель — советник сравнит расход памяти для разных вариантов контекста.'
$root.Controls.Add($subtitle,0,1)
$script:hardwareBox=New-Object Windows.Forms.TextBox
$hardwareBox.Multiline=$true; $hardwareBox.ReadOnly=$true; $hardwareBox.Dock='Fill'; $hardwareBox.BorderStyle='None'
$hardwareBox.BackColor=$form.BackColor; $hardwareBox.Text='Получаем сведения об оборудовании...'
$root.Controls.Add($hardwareBox,0,2)
$modelFlow=New-Object Windows.Forms.FlowLayoutPanel; $modelFlow.Dock='Fill'; $modelFlow.WrapContents=$false
$modelLabel=New-Object Windows.Forms.Label; $modelLabel.Text='Модель:'; $modelLabel.AutoSize=$true; $modelLabel.Margin=New-Object Windows.Forms.Padding(0,8,10,0)
$modelFlow.Controls.Add($modelLabel)
$script:combo=New-Object Windows.Forms.ComboBox; $combo.DropDownStyle='DropDownList'; $combo.Width=770; $combo.DropDownWidth=1000; $combo.DisplayMember='Name'; $combo.Margin=New-Object Windows.Forms.Padding(0,4,10,0)
$modelFlow.Controls.Add($combo)
$script:refresh=New-Button 'Обновить' 110; $modelFlow.Controls.Add($refresh)
$root.Controls.Add($modelFlow,0,3)
$actions=New-Object Windows.Forms.FlowLayoutPanel; $actions.Dock='Fill'; $actions.WrapContents=$false
$script:check=New-Button 'Проверить настройки' 205
$check.BackColor=[Drawing.Color]::FromArgb(40,95,190)
$script:cancel=New-Button 'Отмена' 95; $cancel.Enabled=$false
$script:copy=New-Button 'Скопировать параметры' 220; $copy.Enabled=$false
$script:save=New-Button 'Сохранить отчёт' 170; $save.Enabled=$false
$script:details=New-Button 'Подробности' 130; $details.Enabled=$false
foreach ($control in @($check,$cancel,$copy,$save,$details)) { $actions.Controls.Add($control) }
$root.Controls.Add($actions,0,4)
$script:grid=New-Object Windows.Forms.DataGridView
$grid.Dock='Fill'; $grid.ReadOnly=$true; $grid.AllowUserToAddRows=$false; $grid.AllowUserToDeleteRows=$false
$grid.RowHeadersVisible=$false; $grid.AutoSizeColumnsMode='Fill'; $grid.SelectionMode='FullRowSelect'; $grid.MultiSelect=$false
$grid.BackgroundColor=[Drawing.Color]::White; $grid.BorderStyle='None'; $grid.AutoSizeRowsMode='AllCells'
$grid.DefaultCellStyle.WrapMode='True'; $grid.RowTemplate.Height=36
foreach ($column in @(@('Context','Контекст',65),@('Gpu','На GPU',55),@('GpuMemory','GPU, оценка',90),@('TotalMemory','Всего, оценка',90),@('Result','Результат',170))) {
    $index=$grid.Columns.Add($column[0],$column[1]); $grid.Columns[$index].FillWeight=[single]$column[2]
}
$root.Controls.Add($grid,0,5)
$script:recommendation=New-Label 'Сначала выберите модель и выполните проверку.'
$recommendation.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold)
$recommendation.ForeColor=[Drawing.Color]::FromArgb(31,56,100); $root.Controls.Add($recommendation,0,6)
$notice=New-Label "Советник выполняет только сухие оценки: модели и настройки LM Studio не меняются.`nЗапас: 2 ГиБ GPU и 4 ГиБ RAM. Скорость и успешная загрузка не проверялись.`nОценки CLI могут отличаться от текущей загрузки с вашими параметрами KV-кэша, Flash Attention и batch."
$notice.Font=New-Object Drawing.Font('Segoe UI',9); $notice.ForeColor=[Drawing.Color]::FromArgb(80,90,108)
$root.Controls.Add($notice,0,7)
$footer=New-Object Windows.Forms.TableLayoutPanel; $footer.Dock='Fill'; $footer.ColumnCount=2
[void]$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent',75)))
[void]$footer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent',25)))
$script:status=New-Label 'Подключаемся к LM Studio...'; $status.Font=New-Object Drawing.Font('Segoe UI',9)
$script:progress=New-Object Windows.Forms.ProgressBar; $progress.Dock='Fill'
$footer.Controls.Add($status,0,0); $footer.Controls.Add($progress,1,0); $root.Controls.Add($footer,0,8)

function Set-AdvisorBusy([bool]$Busy) {
    $check.Enabled=(-not $Busy -and $combo.Items.Count -gt 0); $refresh.Enabled=-not $Busy
    $combo.Enabled=-not $Busy; $cancel.Enabled=$Busy; $save.Enabled=(-not $Busy -and $null -ne $script:lastReport)
    $copy.Enabled=(-not $Busy -and $grid.Rows.Count -gt 0); $details.Enabled=(-not $Busy -and $null -ne $script:lastReport)
}
function Show-AdvisorReport($Report) {
    $script:lastReport=$Report
    $status.Text=$Report.Message
    $progress.Value=[Math]::Max(0,[Math]::Min(100,[int]$Report.Progress))
    if ($Report.Hardware) {
        $h=$Report.Hardware
        $loadedText=(@($Report.Loaded | ForEach-Object { $_.Key + ' / контекст ' + $_.ContextLength }) -join '; ')
        if (-not $loadedText) { $loadedText='нет загруженных моделей' }
        $hardwareBox.Text='GPU: ' + $h.GpuName + '  |  всего ' + (Format-AdvisorGiB $h.GpuTotalBytes) + ', свободно ' + (Format-AdvisorGiB $h.GpuFreeBytes) + "`r`n" +
            'RAM: ' + (Format-AdvisorGiB $h.RamTotalBytes) + ', свободно ' + (Format-AdvisorGiB $h.RamFreeBytes) + '  |  CPU: ' + $h.CpuName + "`r`nЗагружено: " + $loadedText
    }
    if ($Report.Mode -eq 'Inventory' -and $Report.Status -eq 'completed') {
        $oldKey=$(if ($combo.SelectedItem) {$combo.SelectedItem.Key} else {''})
        $script:models=@($Report.Models); $combo.Items.Clear()
        foreach ($model in $script:models) { [void]$combo.Items.Add($model) }
        $preferred=$oldKey
        if (-not $preferred -and @($Report.Loaded).Count) { $preferred=$Report.Loaded[0].Key }
        $selected=-1
        for ($i=0; $i -lt $combo.Items.Count; $i++) { if ($combo.Items[$i].Key -ceq $preferred) {$selected=$i; break} }
        if ($selected -lt 0 -and $combo.Items.Count) { $selected=0 }
        $combo.SelectedIndex=$selected
        $recommendation.Text='Выберите модель и нажмите «Проверить настройки».'
    }
    if ($Report.Mode -eq 'Analyze') {
        $grid.Rows.Clear()
        foreach ($row in @($Report.Rows)) {
            $index=$grid.Rows.Add($row.ContextLength.ToString('N0'),($row.GpuRatio*100).ToString('0')+'%',(Format-AdvisorGiB $row.GpuBytes),(Format-AdvisorGiB $row.TotalBytes),$row.Label)
            $grid.Rows[$index].Tag=$row
            $grid.Rows[$index].DefaultCellStyle.BackColor=switch ($row.State) {
                'ready' {[Drawing.Color]::FromArgb(231,246,235)}
                'release-needed' {[Drawing.Color]::FromArgb(255,248,224)}
                'insufficient' {[Drawing.Color]::FromArgb(255,235,235)}
                default {[Drawing.Color]::FromArgb(241,243,247)}
            }
        }
        if ($Report.Status -eq 'completed' -and $Report.RecommendedIndex -ge 0) {
            $best=$Report.Rows[$Report.RecommendedIndex]
            $suffix=$(if ($best.GpuRatio -lt 1) {' Часть модели будет обрабатываться CPU; скорость может снизиться.'} else {''})
            $recommendation.Text='Для начала: контекст ' + $best.ContextLength.ToString('N0') + ', GPU ' + ($best.GpuRatio*100).ToString('0') + '%. ' + $best.Label + '. ' + $best.Reason + $suffix
            $grid.ClearSelection(); $grid.Rows[$Report.RecommendedIndex].Selected=$true
        } elseif ($Report.Status -eq 'running') { $recommendation.Text='Проверка идёт. Итоговая рекомендация появится после всех оценок.' }
        elseif ($Report.Status -eq 'completed') { $recommendation.Text='Подходящий вариант не подтверждён. Посмотрите причины и подробности; настройки наугад не предлагаются.' }
        else { $recommendation.Text=$Report.Message + ' Итоговая рекомендация не готова.' }
    }
    if ($Report.Status -eq 'failed') { $recommendation.Text=$Report.Message }
}
function Start-AdvisorRun([string]$Mode) {
    if ($null -ne $script:worker) { return }
    try {
        $script:runPath=Join-Path $script:dataRoot ([DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
        [void][IO.Directory]::CreateDirectory($script:runPath)
        $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Advisor.Worker.ps1'),'-Mode',$Mode,'-RunDirectory',$script:runPath)
        if ($Mode -eq 'Analyze') {
            if (-not $combo.SelectedItem) { return }
            $arguments+=@('-ModelKey',$combo.SelectedItem.Key)
        }
        $info=New-Object Diagnostics.ProcessStartInfo
        $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $info.Arguments=(($arguments | ForEach-Object {ConvertTo-AdvisorArgument $_}) -join ' ')
        $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardError=$true
        $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
        $script:worker=New-Object Diagnostics.Process; $script:worker.StartInfo=$info
        [void]$script:worker.Start(); $script:workerError=$script:worker.StandardError.ReadToEndAsync()
        $script:lastStamp=''; $script:cancelAt=$null; $script:lastReport=$null
        $grid.Rows.Clear(); $recommendation.Text='Выполняется проверка...'; $progress.Value=0
        $status.Text='Проверяем LM Studio...'; Set-AdvisorBusy $true; $timer.Start()
    } catch {
        $script:worker=$null; Set-AdvisorBusy $false
        [void][Windows.Forms.MessageBox]::Show($form,$_.Exception.Message,'Не удалось начать проверку','OK','Error')
    }
}
function Request-AdvisorCancel {
    if ($null -ne $script:worker) {
        [IO.File]::WriteAllText((Join-Path $script:runPath 'cancel'),'cancel')
        $script:cancelAt=[DateTime]::UtcNow; $cancel.Enabled=$false; $status.Text='Останавливаем проверку...'
    }
}
function Stop-AdvisorWorkerTree {
    if ($null -eq $script:worker -or $script:worker.HasExited) { return }
    $kill=New-Object Diagnostics.ProcessStartInfo
    $kill.FileName=Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $kill.Arguments='/PID ' + $script:worker.Id + ' /T /F'
    $kill.UseShellExecute=$false; $kill.CreateNoWindow=$true
    $p=[Diagnostics.Process]::Start($kill); [void]$p.WaitForExit(3000); $p.Dispose()
}
$script:timer=New-Object Windows.Forms.Timer; $timer.Interval=250
$timer.Add_Tick({
    if ($null -eq $script:worker) { $timer.Stop(); return }
    try {
        $file=Join-Path $script:runPath 'report.json'
        if (Test-Path -LiteralPath $file) {
            $stamp=(Get-Item -LiteralPath $file).LastWriteTimeUtc.Ticks
            if ($stamp -ne $script:lastStamp) {
                try {
                    $r=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json
                    Show-AdvisorReport $r; $script:lastStamp=$stamp
                } catch { } # Atomic writer can be replacing this file; retry next tick.
            }
        }
        if ($script:cancelAt -and ([DateTime]::UtcNow-$script:cancelAt).TotalSeconds -gt 12) { Stop-AdvisorWorkerTree }
        if ($script:worker.HasExited) {
            $timer.Stop()
            $errorText=$script:workerError.GetAwaiter().GetResult()
            try { Show-AdvisorReport (Read-AdvisorFinalReport $file) }
            catch { $status.Text='Итоговый отчёт недоступен: ' + $_.Exception.Message }
            if ($null -eq $script:lastReport -or $script:lastReport.Status -eq 'running') {
                $status.Text='Проверка не завершилась. Повторите её.'
                $recommendation.Text=$(if ($script:cancelAt) {'Проверка отменена.'} else {'Не удалось завершить проверку. ' + $errorText})
            }
            $script:worker.Dispose(); $script:worker=$null; Set-AdvisorBusy $false
        }
    } catch { $status.Text='Не удалось прочитать результат: ' + $_.Exception.Message }
})
$refresh.Add_Click({Start-AdvisorRun 'Inventory'})
$check.Add_Click({Start-AdvisorRun 'Analyze'})
$cancel.Add_Click({Request-AdvisorCancel})
$combo.Add_SelectedIndexChanged({
    if ($null -eq $script:worker) { $grid.Rows.Clear(); $copy.Enabled=$false; $save.Enabled=$false; $details.Enabled=$false; $script:lastReport=$null; $recommendation.Text='Модель выбрана. Нажмите «Проверить настройки».' }
})
$copy.Add_Click({
    if ($grid.SelectedRows.Count) {
        $row=$grid.SelectedRows[0].Tag
        $text='Модель: ' + $script:lastReport.ModelName + "`r`nКонтекст: " + $row.ContextLength + "`r`nGPU Offload: " + ($row.GpuRatio*100).ToString('0') + "%`r`n" + $row.Label + "`r`n" + $row.Reason + "`r`nЭто оценка памяти. Скорость не измерялась; остальные параметры оставлены штатными."
        [Windows.Forms.Clipboard]::SetText($text); $status.Text='Параметры выбранной строки скопированы.'
    }
})
$save.Add_Click({
    if ($null -eq $script:lastReport) {return}
    $dialog=New-Object Windows.Forms.SaveFileDialog; $dialog.Filter='Отчёт JSON (*.json)|*.json'; $dialog.FileName='LMStudio-advisor-report.json'
    if ($dialog.ShowDialog($form) -eq 'OK') {
        try { [IO.File]::WriteAllText($dialog.FileName,($script:lastReport | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false)); $status.Text='Отчёт сохранён.' }
        catch { [void][Windows.Forms.MessageBox]::Show($form,$_.Exception.Message,'Не удалось сохранить','OK','Error') }
    }
    $dialog.Dispose()
})
$details.Add_Click({
    $text=$script:lastReport.EstimatePolicy
    if ($grid.SelectedRows.Count) {$text+="`r`n`r`n" + $grid.SelectedRows[0].Tag.Reason}
    if (@($script:lastReport.Warnings).Count) {$text+="`r`n`r`n" + ($script:lastReport.Warnings -join "`r`n")}
    [void][Windows.Forms.MessageBox]::Show($form,$text,'Как получена оценка','OK','Information')
})
$form.Add_FormClosing({
    $script:closing=$true; $timer.Stop()
    if ($null -ne $script:worker) {
        Request-AdvisorCancel
        if (-not $script:worker.WaitForExit(1500)) { Stop-AdvisorWorkerTree }
        $script:worker.Dispose(); $script:worker=$null
    }
})
if ($SmokeTest) {
    # A diagnostic mode for Windows environments: construct controls without scanning models.
    $form.Dispose(); Write-Output 'UI controls created successfully'; exit 0
}
$form.Add_Shown({Start-AdvisorRun 'Inventory'})
[void]$form.ShowDialog()
$timer.Dispose(); $form.Dispose()
