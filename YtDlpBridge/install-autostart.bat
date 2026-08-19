@echo off
setlocal
cd /d "%~dp0"
title YtDlpBridge install autostart
where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: powershell not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-autostart.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo Install failed. Exit code %ERR%
  pause
  exit /b %ERR%
)
echo.
echo Done. Bridge starts at logon.
pause
exit /b 0
