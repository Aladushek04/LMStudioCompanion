$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = Join-Path $PSHOME 'powershell.exe'
$info.Arguments = '-NoProfile -Command "Start-Sleep -Seconds 7"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$child = [Diagnostics.Process]::Start($info)
Write-Output 'child started'
Start-Sleep -Seconds 30
