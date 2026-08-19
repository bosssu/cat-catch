@echo off
setlocal
cd /d "%~dp0"

rem Prefer PowerShell launcher (PATH sanitize + clean CPython).
where pwsh >nul 2>&1
if not errorlevel 1 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
  if errorlevel 1 pause
  exit /b %ERRORLEVEL%
)

where powershell >nul 2>&1
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
  if errorlevel 1 pause
  exit /b %ERRORLEVEL%
)

rem Fallback without PowerShell: force uv python 3.12.13
where uv >nul 2>&1
if errorlevel 1 (
  echo [AppCatch] uv not found.
  pause
  exit /b 1
)
if not exist "config.yaml" copy /Y "config.example.yaml" "config.yaml" >nul
if not exist ".python-version" echo 3.12.13> ".python-version"
uv python install 3.12.13 >nul 2>&1
uv sync --python 3.12.13
uv run --python 3.12.13 python -m app.main
if errorlevel 1 pause
endlocal
