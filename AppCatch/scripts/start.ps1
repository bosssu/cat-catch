# AppCatch launcher (PowerShell) — strips conda from PATH, uses clean CPython 3.12.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

function Test-Uv {
    return [bool](Get-Command uv -ErrorAction SilentlyContinue)
}

# Minimal PATH without Anaconda/conda Qt
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
    "$env:LOCALAPPDATA\uv"
)
foreach ($d in $uvCandidates) {
    if (Test-Path (Join-Path $d "uv.exe")) { $keep += $d }
}
# Keep original PATH entries that are not conda-related (for git etc. optional)
foreach ($part in ($env:PATH -split ';')) {
    if (-not $part) { continue }
    if ($part -match '(?i)aconda|miniconda|mambaforge|miniforge|\\conda\\') { continue }
    if ($part -match '(?i)\\Library\\bin') {
        # often conda Library\bin with Qt5Core.dll
        if ($part -match '(?i)aconda|miniconda|conda') { continue }
    }
    if ($keep -notcontains $part) { $keep += $part }
}
$env:PATH = ($keep -join ';')

if (-not (Test-Uv)) {
    Write-Host "[AppCatch] uv not found on sanitized PATH."
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
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& uv run --python 3.12.13 python -c "from PySide6.QtCore import Qt; print('PySide6 OK')"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[AppCatch] Recreating .venv ..."
    if (Test-Path ".venv") { Remove-Item -Recurse -Force ".venv" }
    & uv sync --python 3.12.13
    & uv run --python 3.12.13 python -c "from PySide6.QtCore import Qt"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[AppCatch] PySide6 still broken. Do not use Anaconda base env."
        exit 1
    }
}

& uv run --python 3.12.13 python -m app.main
exit $LASTEXITCODE
