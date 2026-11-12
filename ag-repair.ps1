param(
  [int]$Seconds = 8,
  [switch]$Quiet
)
$ErrorActionPreference = 'Continue'
$tools = $PSScriptRoot
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }

function Get-LsEndpoint {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'")
  foreach ($pr in $procs) {
    $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $pr.ProcessId -ErrorAction SilentlyContinue |
               Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
               Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($p in $ports) {
      $html = (& curl.exe -k -s -m 4 "https://127.0.0.1:$p/" 2>$null) -join "`n"
      $m = [regex]::Match($html, '"csrfToken":"([^"]+)"')
      if ($m.Success) { return @{ Port = $p; Token = $m.Groups[1].Value } }
    }
  }
  return $null
}

$ls = Get-LsEndpoint
if (-not $ls) {
  Write-Output 'LS not ready - skip'
  exit 0
}

$env:LS_PORT = "$($ls.Port)"
$env:LS_CSRF = $ls.Token
$dump = Join-Path $tools 'dump_watchdog.bin'
$env:LS_OUT = $dump

$out = & $node (Join-Path $tools 'ls_stream.js') $Seconds 0 2>&1
$n17 = 0
$lines = @()
foreach ($line in $out) {
  if ($line -match '^frames=') { $lines += $line }
  if ($line -match '^source=17 : (\d+)$') { $n17 = [int]$Matches[1] }
}
if (-not $Quiet) { $lines | ForEach-Object { Write-Output $_ } }

$env:LS_STREAM = $dump
$env:LS_LIMIT = '0'
$w = & $node (Join-Path $tools 'ls_write_all.js') 2>&1
$last = @($w) | Select-Object -Last 1

if ($last -match 'DONE ok=\s*(\d+)') {
  Write-Output ("REPAIRED written=" + $Matches[1] + " source17=" + $n17 + " | " + $last)
} elseif ($last -match 'Nothing to rewrite') {
  Write-Output ("OK no source=17, all clean")
} else {
  Write-Output ("STATUS: " + $last)
}
exit 0
