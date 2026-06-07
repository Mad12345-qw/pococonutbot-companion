param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if (-not $connections) {
  Write-Host "No process is listening on port $Port."
  exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $processId -Force
    Write-Host "Stopped process $processId ($($process.ProcessName)) on port $Port."
  }
}
