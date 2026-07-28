$ErrorActionPreference = "Continue"
$port = 8790
Write-Host "Stopping processes listening on port $port ..."

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "No listener on $port."
    exit 0
}
$pids = $conns.OwningProcess | Sort-Object -Unique
foreach ($procId in $pids) {
    try {
        $p = Get-Process -Id $procId -ErrorAction Stop
        Write-Host "Kill PID $procId ($($p.ProcessName))"
        Stop-Process -Id $procId -Force
    } catch {
        Write-Host "Skip PID $procId : $_"
    }
}
Write-Host "Done."
