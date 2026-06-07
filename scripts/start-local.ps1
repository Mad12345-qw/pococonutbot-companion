param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile. Copy .env.example to .env and fill your secrets first."
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  $parts = $line.Split("=", 2)
  if ($parts.Count -ne 2) {
    return
  }

  $name = $parts[0].Trim()
  $value = $parts[1].Trim().Trim('"').Trim("'")
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

npm start
