param(
  [int]$IntervalSec = 90,
  [int]$Rounds = 0
)
# Watchdog: keeps Antigravity conversation history visible by rewriting
# cloud records with source=CLI(17) back to source=local(0) and restoring annotations.
# Runs in background; writes every round to watchdog.log next to this script.
$ErrorActionPreference = 'Continue'
$dir      = 'D:\AI\MIX\tools\antigravity-repair'
$repair   = Join-Path $dir 'ag-repair.ps1'
$log      = Join-Path $dir 'watchdog.log'
$pidfile  = Join-Path $dir 'watchdog.pid'

# Robust single-instance guard: check process identity, not just PID existence
if (Test-Path $pidfile) {
  $old = 0
  try { $old = [int](Get-Content $pidfile -ErrorAction Stop) } catch { $old = 0 }
  if ($old -gt 0 -and $old -ne $PID) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $old" -ErrorAction SilentlyContinue
    if ($proc -and ($proc.CommandLine -match 'ag-watchdog' -or $proc.Name -match 'powershell')) {
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
while ($Rounds -le 0 -or $i -lt $Rounds) {
  $i++
  $sleepSec = $IntervalSec
  try {
    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $repair 2>&1
    $line = (@($r) | Where-Object { $_ -match 'REPAIRED|OK|LS not ready|error' } | Select-Object -Last 1)
    Write-Log ("round={0} {1}" -f $i, $line)
    if ($line -match 'LS not ready') {
      $sleepSec = 5 # quickly retry until Language Server port opens
    }
  } catch {
    Write-Log ("round={0} error: {1}" -f $i, $_.Exception.Message)
  }
  if ($Rounds -le 0 -or $i -lt $Rounds) { Start-Sleep -Seconds $sleepSec }
}
Write-Log ("STOP pid={0} rounds={1}" -f $PID, $i)
Remove-Item $pidfile -ErrorAction SilentlyContinue
