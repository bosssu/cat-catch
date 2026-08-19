$ErrorActionPreference = "Continue"
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'YtDlpBridge|ytdlp-bridge|python -m app.main' -and $_.CommandLine -match '8792|YtDlp' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Broader fallback: processes whose cwd/command includes this repo folder name
$here = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$here*" -and $_.CommandLine -match 'app.main' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "YtDlpBridge stop requested."
