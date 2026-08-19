$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TaskName = "YtDlpBridge"
$StartPs1 = Join-Path $Root "scripts\start.ps1"

if (-not (Test-Path $StartPs1)) {
    Write-Error "Missing $StartPs1"
}

$ps = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $ps)) { $ps = "powershell.exe" }

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartPs1`""
$action = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "YtDlpBridge local HTTP (127.0.0.1:8792). Page URL download via yt-dlp." | Out-Null

Write-Host "Task '$TaskName' registered and enabled — starts at logon (hidden)."
Write-Host "Start script: $StartPs1"
Write-Host "Manual test:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Uninstall:    uninstall-autostart.bat"
