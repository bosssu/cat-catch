# YtDlpBridge launcher. Default: re-launch hidden (no console).
param(
    [switch]$Autostart,
    [switch]$Inner,
    [switch]$Console
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
    if ($Console) { Write-Host $msg }
}

# Manual double-click: spawn hidden child and exit this window.
if (-not $Inner -and -not $Autostart -and -not $Console) {
    $ps = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path $ps)) { $ps = "powershell.exe" }
    $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Inner"
    Start-Process -FilePath $ps -ArgumentList $arg -WorkingDirectory $Root -WindowStyle Hidden
    exit 0
}

function Test-Uv {
    return [bool](Get-Command uv -ErrorAction SilentlyContinue)
}

$keep = @(
    "$env:SystemRoot\System32",
    "$env:SystemRoot",
    "$env:SystemRoot\System32\Wbem",
    "$env:SystemRoot\System32\WindowsPowerShell\v1.0",
    "$env:SystemRoot\System32\OpenSSH"
)
$uvCandidates = @(
    "$env:USERPROFILE\.local\bin",
    "$env:USERPROFILE\.cargo\bin",
    "$env:LOCALAPPDATA\Programs\uv",
    "$env:LOCALAPPDATA\uv",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
    "$env:USERPROFILE\.deno\bin"
)
foreach ($d in $uvCandidates) {
    if (Test-Path (Join-Path $d "uv.exe")) { $keep += $d }
}
foreach ($part in ($env:PATH -split ';')) {
    if (-not $part) { continue }
    if ($part -match '(?i)aconda|miniconda|mambaforge|miniforge|\\conda\\') { continue }
    if ($keep -notcontains $part) { $keep += $part }
}
$env:PATH = ($keep -join ';')

Write-Log "YtDlpBridge start (Autostart=$Autostart Console=$Console)"

if (-not (Test-Uv)) {
    Write-Log "ERROR: uv not found on sanitized PATH."
    if ($Console) { exit 1 }
    exit 1
}

if (-not (Test-Path "config.yaml") -and (Test-Path "config.example.yaml")) {
    Copy-Item "config.example.yaml" "config.yaml"
}

if (-not (Test-Path ".python-version")) {
    Set-Content -Path ".python-version" -Value "3.12.13" -Encoding ascii
}

& uv python install 3.12.13 | Out-Null
& uv sync --python 3.12.13
if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: uv sync failed ($LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Log "listen http://127.0.0.1:8792"
& uv run --python 3.12.13 python -m app.main
$code = $LASTEXITCODE
Write-Log "exit $code"
exit $code
