<#
.SYNOPSIS
  Executes Antigravity history & archive status repair.

.DESCRIPTION
  Discovers running Antigravity Language Server on loopback (127.0.0.1),
  fetches CSRF token, captures summary stream dump, and triggers batch repair.

.PARAMETER Seconds
  Duration in seconds to collect summaries from Language Server stream. Default 8.

.PARAMETER DryRun
  If set, plans and simulates changes without writing to Language Server.

.PARAMETER Quiet
  Suppresses intermediate output lines.

.NOTES
  TLS Security Justification:
  Antigravity language_server generates a local self-signed TLS certificate bound
  strictly to 127.0.0.1. Curl and Node HTTP/2 use certificate validation bypass
  exclusively for local 127.0.0.1 loopback endpoints.
#>
param(
  [int]$Seconds = 8,
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$tools = $PSScriptRoot

# Node.js binary resolution
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'node' }

function Invoke-NativeCapture([string]$exe, [string[]]$cmdArgs) {
  $prevErrPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $exe @cmdArgs 2>&1
    $code = $LASTEXITCODE
    $lines = @($raw) | ForEach-Object { "$_" }
    return @{ ExitCode = $code; Lines = $lines }
  } finally {
    $ErrorActionPreference = $prevErrPref
  }
}

function Get-LsEndpoint {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" -ErrorAction SilentlyContinue)
  if (-not $procs -or $procs.Count -eq 0) {
    return $null
  }

  foreach ($pr in $procs) {
    $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $pr.ProcessId -ErrorAction SilentlyContinue |
               Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
               Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($p in $ports) {
      # Loopback 127.0.0.1 query with strict 4s timeout
      $res = Invoke-NativeCapture 'curl.exe' @('-k', '-s', '-m', '4', "https://127.0.0.1:$p/")
      $html = $res.Lines -join "`n"
      $m = [regex]::Match($html, '"csrfToken":"([^"]+)"')
      if ($m.Success) {
        return @{ Port = $p; Token = $m.Groups[1].Value }
      }
    }
  }
  return $null
}

$ls = Get-LsEndpoint
if (-not $ls) {
  $msg = "ERROR: Language Server endpoint not found or not responding on 127.0.0.1."
  [Console]::Error.WriteLine($msg)
  Write-Output $msg
  exit 2
}

$env:LS_PORT = "$($ls.Port)"
$env:LS_CSRF = $ls.Token
$dump = Join-Path $tools 'dump_watchdog.bin'
$env:LS_OUT = $dump

# Capture summary dump stream
$streamScript = Join-Path $tools 'ls_stream.js'
$streamRes = Invoke-NativeCapture $node @($streamScript, "$Seconds", '0')
$streamExit = $streamRes.ExitCode
$out = $streamRes.Lines

if ($streamExit -ne 0) {
  $msg = "ERROR: Failed to stream summaries from Language Server (exit $streamExit)."
  [Console]::Error.WriteLine($msg)
  Write-Output $msg
  exit $streamExit
}

$n17 = 0
$lines = @()
foreach ($line in $out) {
  if ($line -match '^frames=') { $lines += $line }
  if ($line -match '^source=17 : (\d+)$') { $n17 = [int]$Matches[1] }
}
if (-not $Quiet) { $lines | ForEach-Object { Write-Output $_ } }

$env:LS_STREAM = $dump
$writeScript = Join-Path $tools 'ls_write_all.js'

$nodeArgs = @($writeScript)
if ($DryRun) {
  $nodeArgs += '--dry-run'
}

$writeRes = Invoke-NativeCapture $node $nodeArgs
$writeExit = $writeRes.ExitCode
$w = $writeRes.Lines

$last = @($w) | Select-Object -Last 1
if (-not $Quiet) {
  $w | ForEach-Object { Write-Output $_ }
}

if ($writeExit -ne 0) {
  $msg = "ERROR: Repair operation failed with exit code $writeExit."
  [Console]::Error.WriteLine($msg)
  Write-Output $msg
  exit $writeExit
}

if ($last -match 'DONE ok=\s*(\d+)') {
  Write-Output ("REPAIRED written=" + $Matches[1] + " source17=" + $n17 + " | " + $last)
} elseif ($last -match 'Nothing to rewrite') {
  Write-Output ("OK no source=17, all clean")
} else {
  Write-Output ("STATUS: " + $last)
}

exit 0
