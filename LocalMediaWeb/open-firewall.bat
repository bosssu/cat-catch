@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Creates Windows Firewall inbound rule for TCP 8790 (Admin required)
echo.
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file - Run as administrator
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-firewall.ps1"
echo.
pause
exit /b %ERRORLEVEL%
