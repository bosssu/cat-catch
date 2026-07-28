# LocalMediaWeb launcher (Windows).
# Settings: config/settings.yaml → open_browser, hide_console, autostart_*
param(
    [switch]$Autostart,
    [switch]$Inner
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$LogDir = Join-Path $Root "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "startup.log"

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
    if (-not $script:QuietHost) {
        Write-Host $msg
    }
}

# --- fast-read launcher flags from settings.yaml (no uv; minimize console flash) ---
$openBrowser = $false
$hideConsole = $true
$autostartUvSync = $false
$hostBind = "0.0.0.0"
$port = 8790
$proxyUrl = ""
$netModes = ""

function Read-YamlBool([string]$text, [string]$key, [bool]$default) {
    if ($text -match "(?m)^\s*${key}\s*:\s*(true|false)\s*") {
        return ($Matches[1] -eq "true")
    }
    return $default
}
function Read-YamlInt([string]$text, [string]$key, [int]$default) {
    if ($text -match "(?m)^\s*${key}\s*:\s*(\d+)\s*") {
        return [int]$Matches[1]
    }
    return $default
}

$settingsPath = Join-Path $Root "config\settings.yaml"
if (-not (Test-Path $settingsPath)) {
    $settingsPath = Join-Path $Root "config\settings.example.yaml"
}
if (Test-Path $settingsPath) {
    try {
        $yt = Get-Content -Path $settingsPath -Raw -Encoding UTF8
        $openBrowser = Read-YamlBool $yt "open_browser" $false
        $hideConsole = Read-YamlBool $yt "hide_console" $true
        $autostartUvSync = Read-YamlBool $yt "autostart_uv_sync" $false
        $port = Read-YamlInt $yt "port" 8790
    } catch {}
}

# Re-launch hidden (manual double-click) so console flash is minimal
if ($hideConsole -and -not $Inner -and -not $Autostart) {
    $ps = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path $ps)) { $ps = "powershell.exe" }
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Inner"
    Start-Process -FilePath $ps -ArgumentList $arg -WorkingDirectory $Root -WindowStyle Hidden
    exit 0
}

$script:QuietHost = ($hideConsole -or $Autostart)
if ($script:QuietHost) {
    # still allow Write-Log to file
}

Write-Log "LocalMediaWeb start (Autostart=$Autostart hide=$hideConsole open_browser=$openBrowser)"
Write-Log "Root: $Root"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Log "ERROR: uv not found in PATH"
    if (-not $script:QuietHost) { Write-Error "uv not found in PATH. Install: https://github.com/astral-sh/uv" }
    exit 1
}

$doSync = $true
if ($Autostart -and -not $autostartUvSync) {
    $doSync = $false
    Write-Log "Skip uv sync (autostart_uv_sync=false)"
}
if ($doSync) {
    Write-Log "Syncing dependencies (uv sync)..."
    try {
        & uv sync 2>&1 | ForEach-Object { Write-Log "$_" }
    } catch {
        Write-Log "uv sync warning: $_"
    }
}

# Clear process-level proxy (downloads use settings http_proxy via httpx only)
foreach ($k in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
    Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}
$env:NO_PROXY = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local"
$env:no_proxy = $env:NO_PROXY
$env:PYTHONPATH = "$Root\backend"

# Re-read config after sync (first run)
try {
    $cfgOut = & uv run --directory $Root python -c @"
from app.core.config import get_settings
from app.services.http_client import configured_proxy, describe_network_setup
s = get_settings()
print('LMW_HOST=' + str(s.host))
print('LMW_PORT=' + str(s.port))
print('LMW_PROXY=' + (configured_proxy(s) or ''))
print('LMW_MODES=' + describe_network_setup(s))
print('LMW_OPEN_BROWSER=' + ('1' if s.open_browser else '0'))
print('LMW_HIDE_CONSOLE=' + ('1' if s.hide_console else '0'))
"@
    foreach ($line in @($cfgOut)) {
        $t = "$line".Trim()
        if ($t.StartsWith("LMW_HOST=")) { $hostBind = $t.Substring(9) }
        elseif ($t.StartsWith("LMW_PORT=")) {
            try { $port = [int]$t.Substring(9) } catch {}
        }
        elseif ($t.StartsWith("LMW_PROXY=")) { $proxyUrl = $t.Substring(10) }
        elseif ($t.StartsWith("LMW_MODES=")) { $netModes = $t.Substring(10) }
        elseif ($t.StartsWith("LMW_OPEN_BROWSER=")) { $openBrowser = ($t.Substring(17) -eq "1") }
        elseif ($t.StartsWith("LMW_HIDE_CONSOLE=")) { $hideConsole = ($t.Substring(17) -eq "1") }
    }
} catch {
    Write-Log "config reload failed: $_"
}

if ($proxyUrl) { Write-Log "Download proxy (httpx only): $proxyUrl" }
else { Write-Log "WARN: no http_proxy in settings — foreign CDN may fail" }
if ($netModes) { Write-Log "Download modes: $netModes" }

if ($hostBind -eq "127.0.0.1" -or $hostBind -eq "localhost" -or [string]::IsNullOrWhiteSpace($hostBind)) {
    Write-Log "Forcing host 0.0.0.0 for phone/LAN"
    $hostBind = "0.0.0.0"
}

$fwRule = "LocalMediaWeb TCP $port"
if (-not (Get-NetFirewallRule -DisplayName $fwRule -ErrorAction SilentlyContinue)) {
    try {
        New-NetFirewallRule -DisplayName $fwRule -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $port -Profile Any `
            -Description "LocalMediaWeb LAN" -ErrorAction Stop | Out-Null
        Write-Log "Firewall rule created: $fwRule"
    } catch {
        Write-Log "WARN: firewall rule missing — run open-firewall.bat as Admin"
    }
} else {
    Set-NetFirewallRule -DisplayName $fwRule -Enabled True -Profile Any -ErrorAction SilentlyContinue
    Write-Log "Firewall: $fwRule OK"
}

$lanIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique)

Write-Log "Bind: http://${hostBind}:$port/"
Write-Log "This PC: http://127.0.0.1:$port/"
foreach ($ip in $lanIps) { Write-Log "Phone / LAN: http://${ip}:$port/" }

# Already listening? do not start a second instance
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Log "Port $port already in use — skip start (already running)"
    if ($openBrowser) {
        Start-Process "http://127.0.0.1:$port/"
    }
    exit 0
}

$runner = Join-Path $Root "scripts\run_uvicorn.py"
$uvExe = (Get-Command uv).Source
$winStyle = if ($hideConsole) { "Hidden" } else { "Normal" }

Write-Log "Starting server (WindowStyle=$winStyle)..."
$p = Start-Process -FilePath $uvExe `
    -ArgumentList @("run", "--directory", $Root, "python", $runner, $hostBind, "$port") `
    -WorkingDirectory $Root `
    -PassThru `
    -WindowStyle $winStyle

$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    if ($p.HasExited) {
        Write-Log "ERROR: server exited early code=$($p.ExitCode)"
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 1
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Milliseconds 400
    }
}

if ($ready) {
    Write-Log "Health OK"
} else {
    Write-Log "WARN: health check timed out"
}

if ($openBrowser) {
    Write-Log "Opening browser (open_browser=true)"
    Start-Process "http://127.0.0.1:$port/"
} else {
    Write-Log "Skip browser (open_browser=false)"
}

# When hidden/autostart: detach — do not keep a parent powershell waiting (scheduled task would hang).
# Server process is independent; use stop.bat to kill port listener.
if ($hideConsole -or $Autostart) {
    Write-Log "Detached. PID(server)~$($p.Id). stop.bat to stop. log=$LogFile"
    exit 0
}

Write-Log "Console mode: Ctrl+C / close window stops waiter; stop.bat kills server"
try {
    Wait-Process -Id $p.Id
} finally {
    if (-not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
}
