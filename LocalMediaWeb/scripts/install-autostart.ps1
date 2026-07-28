# Register LocalMediaWeb to start at user logon (Task Scheduler).
# Reads config/settings.yaml autostart / hide_console / open_browser.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TaskName = "LocalMediaWeb"
$StartPs1 = Join-Path $Root "scripts\start.ps1"

if (-not (Test-Path $StartPs1)) {
    Write-Error "Missing $StartPs1"
}

# Optional: respect settings.autostart flag (still allow force install)
$env:PYTHONPATH = Join-Path $Root "backend"
$want = $true
try {
    $line = & uv run --directory $Root python -c "from app.core.config import get_settings; print('1' if get_settings().autostart else '0')"
    $want = (("$line".Trim() | Select-Object -Last 1) -eq "1")
} catch {}

if (-not $want) {
    Write-Warning "settings.yaml has autostart: false — task will still be registered; set true if you want it enabled by default."
}

$ps = Join-Path $PSHOME "powershell.exe"
if (-not (Test-Path $ps)) { $ps = "powershell.exe" }

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartPs1`" -Autostart"
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
    -Description "LocalMediaWeb media server (logon). Config: open_browser / hide_console in settings.yaml" | Out-Null

if (-not $want) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Task '$TaskName' registered but DISABLED (autostart: false)."
    Write-Host "Enable: Enable-ScheduledTask -TaskName $TaskName   or set autostart: true and re-run this script."
} else {
    Write-Host "Task '$TaskName' registered and enabled — starts at logon (hidden)."
}

Write-Host "Start script: $StartPs1"
Write-Host "Manual test:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Uninstall:    uninstall-autostart.bat"
Write-Host "Stop server:  stop.bat"
Write-Host "Logs:         $Root\data\logs\startup.log"
