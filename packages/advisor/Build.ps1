$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'Advisor.exe'
if (Test-Path -LiteralPath $target) { throw 'Advisor.exe уже существует. Для повторной сборки укажите новый выходной файл либо сохраните прежнюю сборку отдельно.' }
Add-Type -Path (Join-Path $PSScriptRoot 'AdvisorHost.cs') -ReferencedAssemblies @(
    'System.Windows.Forms',
    [System.Management.Automation.PowerShell].Assembly.Location
) -OutputAssembly $target -OutputType WindowsApplication
Write-Output ('Built: ' + $target)
