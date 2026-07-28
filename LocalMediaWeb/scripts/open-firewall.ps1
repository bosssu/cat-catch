# Allow inbound TCP for LocalMediaWeb (run as Administrator once)
$ErrorActionPreference = "Stop"
$port = 8790
if ($env:LMW_PORT) {
    try { $port = [int]$env:LMW_PORT } catch {}
}
# try read from settings if available
try {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    $cfgLine = & uv run --directory $Root python -c "from app.core.config import get_settings; print(get_settings().port)" 2>$null
    if ($cfgLine) { $port = [int]($cfgLine | Select-Object -Last 1) }
} catch {}

$ruleName = "LocalMediaWeb TCP $port"

# Remove stale rules with same name then recreate for all profiles (Private/Domain/Public)
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $port `
    -Profile Any `
    -Description "LocalMediaWeb LAN access (phone / tablet on same Wi-Fi)" | Out-Null

Write-Host "Created inbound allow rule: $ruleName (TCP $port, All profiles)"
Write-Host "Phone URL example: http://<this-pc-lan-ip>:$port/"
Write-Host "If still blocked: Wi-Fi network type, router AP isolation, or Clash TUN 'block LAN'."
