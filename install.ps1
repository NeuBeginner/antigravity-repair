<#
.SYNOPSIS
  Installs Antigravity Watchdog into the Windows Startup folder.
#>
$ErrorActionPreference = 'Stop'
$startupDir = [Environment]::GetFolderPath('Startup')
$targetVbs = Join-Path $PSScriptRoot 'antigravity_history_repair.vbs'
$shortcutPath = Join-Path $startupDir 'antigravity_history_repair.lnk'

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "`"$targetVbs`""
$sc.WorkingDirectory = $PSScriptRoot
$sc.Description = 'Antigravity History & Unread Status Repair Watchdog'
$sc.Save()

Write-Host "Installed startup shortcut to: $shortcutPath" -ForegroundColor Green
Write-Host "Starting watchdog now..." -ForegroundColor Cyan
Start-Process wscript.exe -ArgumentList "`"$targetVbs`""
Write-Host "Done!" -ForegroundColor Green
