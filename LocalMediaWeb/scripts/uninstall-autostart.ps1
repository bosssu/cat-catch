$ErrorActionPreference = "Continue"
$TaskName = "LocalMediaWeb"
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) {
    Write-Host "No scheduled task named '$TaskName'."
    exit 0
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."
Write-Host "Server may still be running — use stop.bat if needed."
