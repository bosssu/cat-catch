@echo off
setlocal
cd /d "%~dp0"
title YtDlpBridge
where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: powershell not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Console
if errorlevel 1 pause
exit /b %ERRORLEVEL%
