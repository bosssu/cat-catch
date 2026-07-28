@echo off
setlocal
cd /d "%~dp0"
title LocalMediaWeb uninstall autostart
where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: powershell not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-autostart.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo Uninstall failed. Exit code %ERR%
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
