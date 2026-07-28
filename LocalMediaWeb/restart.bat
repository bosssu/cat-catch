@echo off
setlocal
cd /d "%~dp0"
title LocalMediaWeb Restart
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo Restart failed. Exit code %ERR%
  pause
  exit /b %ERR%
)
exit /b 0
