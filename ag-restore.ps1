<#
.SYNOPSIS
  Restores original binary summaries from a backup session.

.PARAMETER BackupDir
  Path to a specific backup session directory.

.PARAMETER Latest
  Restores the most recent backup session.

.PARAMETER DryRun
  Plans restore without writing to Language Server.
#>
param(
  [string]$BackupDir = '',
  [switch]$Latest,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$tools = $PSScriptRoot

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

if (-not $DryRun) {
  $ls = Get-LsEndpoint
  if (-not $ls) {
    $msg = "ERROR: Language Server endpoint not found or not responding on 127.0.0.1."
    [Console]::Error.WriteLine($msg)
    Write-Output $msg
    exit 2
  }
  $env:LS_PORT = "$($ls.Port)"
  $env:LS_CSRF = $ls.Token
}

$restoreScript = Join-Path $tools 'ls_restore.js'
$nodeArgs = @($restoreScript)

if ($BackupDir) {
  $nodeArgs += @('--backup', $BackupDir)
} elseif ($Latest) {
  $nodeArgs += '--latest'
}

if ($DryRun) {
  $nodeArgs += '--dry-run'
}

$restoreRes = Invoke-NativeCapture $node $nodeArgs
$restoreExit = $restoreRes.ExitCode
$r = $restoreRes.Lines

$r | ForEach-Object { Write-Output $_ }

if ($restoreExit -ne 0) {
  $msg = "ERROR: Restore operation failed with exit code $restoreExit."
  [Console]::Error.WriteLine($msg)
  Write-Output $msg
  exit $restoreExit
}

exit 0
