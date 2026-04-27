# Kill the Hamilton STAR twin listening on the default HTTP port.
#
# The twin (headless server or Electron main process) binds to
# 127.0.0.1:8222 by default. If that port is already in use when
# a new 'npm start' launches, Electron silently falls back to 8223,
# 8224... which leaks stale servers and confuses the UI (wrong tab
# talks to the wrong process). Run this before every 'npm start'
# to guarantee a clean 8222.
#
# Only processes whose image name is node.exe or electron.exe are
# terminated - other apps that happen to hold 8222 are reported
# and left alone.
#
# USAGE:
#   .\scripts\kill-twin.ps1
#   .\scripts\kill-twin.ps1 -Port 8223

param(
  [int]$Port = 8222
)

$ErrorActionPreference = "Stop"

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($null -eq $conns) {
  Write-Host "Nothing listening on :$Port - already free." -ForegroundColor Green
  exit 0
}

$killed = 0
$skipped = 0

foreach ($c in @($conns)) {
  $procId = $c.OwningProcess
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -eq $proc) { continue }

  $name = $proc.ProcessName.ToLower()
  if ($name -eq "node" -or $name -eq "electron") {
    Write-Host "Killing $($proc.ProcessName) (PID $procId) on :$Port" -ForegroundColor Yellow
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      $killed = $killed + 1
    } catch {
      Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
    }
  } else {
    Write-Host "Not touching $($proc.ProcessName) (PID $procId) - unrelated to the twin" -ForegroundColor DarkYellow
    $skipped = $skipped + 1
  }
}

Start-Sleep -Milliseconds 200
$remaining = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$remainingCount = 0
if ($null -ne $remaining) { $remainingCount = @($remaining).Count }

if ($remainingCount -eq 0) {
  Write-Host "Port :$Port is free (killed $killed, skipped $skipped)." -ForegroundColor Green
  exit 0
} else {
  Write-Host "Port :$Port still held by $remainingCount process(es). See list above." -ForegroundColor Red
  exit 1
}
