# Automated test suite for ag-watchdog.ps1
# Runs strictly in an isolated temporary directory with zero production dependencies.

$ErrorActionPreference = 'Stop'
$testPassed = 0

function Assert-Condition([bool]$condition, [string]$message) {
  if (-not $condition) {
    Write-Error "FAIL: $message"
    exit 1
  }
  $global:testPassed++
  Write-Host "  ✓ $message" -ForegroundColor Green
}

Write-Host "--- Running ag-watchdog.ps1 Tests ---" -ForegroundColor Cyan

$tempRoot = Join-Path $env:TEMP ("ag_test_wd_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
  $watchdogScript = Join-Path $repoRoot 'ag-watchdog.ps1'
  $testWatchdog = Join-Path $tempRoot 'ag-watchdog.ps1'
  Copy-Item $watchdogScript $testWatchdog

  # Create mock ag-repair.ps1 in isolated temp directory
  $mockRepair = Join-Path $tempRoot 'ag-repair.ps1'
  @'
param([switch]$DryRun, [switch]$Quiet)
Write-Output "OK no source=17, all clean"
exit 0
'@ | Set-Content -Path $mockRepair -Encoding ASCII

  # Test 1: Normal execution with 1 round
  Write-Host "Test 1: Single round execution and pidfile cleanup"
  $proc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testWatchdog, '-Rounds', '1', '-IntervalSec', '1', '-DryRun') -WorkingDirectory $tempRoot -PassThru -Wait
  Assert-Condition ($proc.ExitCode -eq 0) "Watchdog exited with code 0"

  $pidFile = Join-Path $tempRoot 'watchdog.pid'
  Assert-Condition (-not (Test-Path $pidFile)) "watchdog.pid was cleaned up upon completion"

  $logFile = Join-Path $tempRoot 'watchdog.log'
  Assert-Condition (Test-Path $logFile) "watchdog.log was created"
  $logContent = Get-Content $logFile -Raw
  Assert-Condition ($logContent -match 'START pid=') "Log records START message"
  Assert-Condition ($logContent -match 'round=1 exit=0 OK no source=17') "Log records round=1 output"
  Assert-Condition ($logContent -match 'STOP pid=') "Log records STOP message"

  # Test 2: Stale PID file recovery
  Write-Host "Test 2: Stale PID file recovery"
  Set-Content -Path $pidFile -Value '999999' -Encoding ASCII
  $proc2 = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testWatchdog, '-Rounds', '1', '-IntervalSec', '1', '-DryRun') -WorkingDirectory $tempRoot -PassThru -Wait
  Assert-Condition ($proc2.ExitCode -eq 0) "Watchdog handled stale PID and exited with code 0"
  Assert-Condition (-not (Test-Path $pidFile)) "Stale PID was replaced and cleaned up"

  # Test 3: PID guard exits when genuine duplicate process is running
  Write-Host "Test 3: PID guard with duplicate instance"
  # Spawn a mock background process with 'ag-watchdog' in its command line
  $dummyProc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-Command', '$mockTag = "ag-watchdog"; Start-Sleep -Seconds 15') -PassThru
  try {
    # Write its PID to watchdog.pid
    Set-Content -Path $pidFile -Value "$($dummyProc.Id)" -Encoding ASCII

    # Now launch watchdog - it should detect the existing process and exit immediately
    $proc3 = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testWatchdog, '-Rounds', '1', '-IntervalSec', '1', '-DryRun') -WorkingDirectory $tempRoot -PassThru -Wait
    Assert-Condition ($proc3.ExitCode -eq 0) "Duplicate watchdog exited cleanly"

    $logAfter = Get-Content $logFile -Raw
    Assert-Condition ($logAfter -match 'already running pid=') "Log records already running message"
  } finally {
    try { Stop-Process -Id $dummyProc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }

} finally {
  try {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  } catch {}
}

Write-Host "`nag-watchdog Suite Passed: $testPassed tests.`n" -ForegroundColor Green
exit 0
