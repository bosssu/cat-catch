$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$ScriptDir\stop.ps1"
Start-Sleep -Seconds 1
& "$ScriptDir\start.ps1"
