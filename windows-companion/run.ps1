# Start the Windows Companion Service in the foreground.
#   powershell -ExecutionPolicy Bypass -File run.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".\.venv")) {
  Write-Host "[companion] creating venv"
  python -m venv .venv
}
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

if (-not (Test-Path ".\config.json")) {
  Copy-Item ".\config.example.json" ".\config.json"
  Write-Host "[companion] created config.json — fill it in, then re-run." -ForegroundColor Yellow
  exit 1
}

Write-Host "[companion] starting"
.\.venv\Scripts\python.exe .\companion.py