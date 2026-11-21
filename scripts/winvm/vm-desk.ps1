# scripts\winvm\vm-desk.ps1, on the VM as C:\tasktap\desk.ps1, called as the tower's helper is: runs a command line in
# the desktop account's signed-in session (vm-desk-account.ps1) through the scheduled task "Tasktap Desktop", which runs
# C:\tasktap\desk\job.ps1 there, not elevated, at normal priority; waits for its end, prints what it printed and exits
# with its exit code.
param([int]$TimeoutSeconds = 600, [Parameter(Mandatory)][string]$CommandLine)
$ErrorActionPreference = 'Stop'
$dir = 'C:\tasktap\desk'
New-Item -ItemType Directory -Force $dir | Out-Null
$log = "$dir\out.txt"; $done = "$dir\done.txt"
Remove-Item $log, $done -ErrorAction SilentlyContinue
Set-Content "$dir\job.ps1" @"
`$ErrorActionPreference = 'Continue'
# The desktop account's own PowerShell 7 (desk-account.ps1), for what the command line runs by name.
if (Test-Path 'C:\tasktap\pwsh\pwsh.exe') { `$env:PATH = "C:\tasktap\pwsh;`$env:PATH" }
& { $CommandLine } *> '$log'
Set-Content '$done' "`$LASTEXITCODE"
"@
Start-ScheduledTask -TaskName 'Tasktap Desktop'
$until = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not (Test-Path $done) -and (Get-Date) -lt $until) { Start-Sleep -Seconds 2 }
if (Test-Path $log) { Get-Content $log }
if (-not (Test-Path $done)) {
    Stop-ScheduledTask -TaskName 'Tasktap Desktop'
    Write-Host "desk.ps1: not done after $TimeoutSeconds s; stopped"
    exit 124
}
exit [int](Get-Content $done -Raw).Trim()
