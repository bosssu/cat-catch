@echo off
setlocal
cd /d "%~dp0"
title LocalMediaWeb
where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: powershell not found.
  pause
  exit /b 1
)
rem start.ps1 reads hide_console / open_browser from settings.yaml
rem When hide_console=true it re-launches hidden and this window exits quickly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo Start failed. Exit code %ERR%
  echo See data\logs\startup.log
  pause
  exit /b %ERR%
)
exit /b 0
