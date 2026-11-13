param(
  [int]$IntervalSec = 90,
  [int]$Rounds = 0,
  [switch]$DryRun
)
# Watchdog: keeps Antigravity conversation history visible by rewriting
# cloud records with source=CLI(17) back to source=local(0) and restoring annotations.
# Runs in background; writes every round to watchdog.log next to this script.
$ErrorActionPreference = 'Continue'
$dir      = $PSScriptRoot
$repair   = Join-Path $dir 'ag-repair.ps1'
$log      = Join-Path $dir 'watchdog.log'
$pidfile  = Join-Path $dir 'watchdog.pid'

# Robust single-instance guard: check process identity, not just PID existence
if (Test-Path $pidfile) {
  $old = 0
  try { $old = [int](Get-Content $pidfile -ErrorAction Stop) } catch { $old = 0 }
  if ($old -gt 0 -and $old -ne $PID) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $old" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'ag-watchdog') {
      Add-Content $log ("{0} already running pid={1} - exit" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $old)
      exit 0
    }
  }
}
Set-Content -Path $pidfile -Value $PID -Encoding ASCII

function Write-Log([string]$m) {
  Add-Content $log ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Write-Log ("START pid={0} interval={1}s" -f $PID, $IntervalSec)
$i = 0
$exitCode = 0
try {
  while ($Rounds -le 0 -or $i -lt $Rounds) {
    $i++
    $sleepSec = $IntervalSec
    try {
      $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $repair)
      if ($DryRun) {
        $argsList += '-DryRun'
      }
      $r = @(& powershell @argsList 2>&1) | ForEach-Object { "$_" }
      $lastExit = $LASTEXITCODE
      $line = (@($r) | Where-Object { $_ -match 'REPAIRED|OK|LS not ready|Language Server endpoint not found|error' } | Select-Object -Last 1)
      if (-not $line) {
        $line = (@($r) | Select-Object -Last 1)
      }
      Write-Log ("round={0} exit={1} {2}" -f $i, $lastExit, $line)
      if ($line -match 'LS not ready' -or $line -match 'Language Server endpoint not found') {
        $sleepSec = [Math]::Min(5, $IntervalSec) # quickly retry until Language Server port opens
      }
      if ($lastExit -ne 0 -and $lastExit -ne 2) {
        # exit 2 is harmless (LS not yet started/running)
        $exitCode = $lastExit
      }
    } catch {
      Write-Log ("round={0} error: {1}" -f $i, $_.Exception.Message)
      $exitCode = 1
    }
    if ($Rounds -le 0 -or $i -lt $Rounds) { Start-Sleep -Seconds $sleepSec }
  }
} finally {
  Write-Log ("STOP pid={0} rounds={1} exitCode={2}" -f $PID, $i, $exitCode)
  Remove-Item $pidfile -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
  exit $exitCode
}
exit 0
