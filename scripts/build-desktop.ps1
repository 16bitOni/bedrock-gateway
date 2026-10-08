# Build "Bedrock Portal.exe" on your own Windows PC (same result as the GitHub Actions release).
# Usage: .\scripts\build-desktop.ps1        ->  dist\Bedrock Portal.exe
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js 20+ is required to build the dashboard: https://nodejs.org" }
Push-Location frontend
if (Test-Path package-lock.json) { npm ci } else { npm install }
npm run build
Pop-Location

$Venv = Join-Path $Root ".build-venv"
if (-not (Test-Path $Venv)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv $Venv } else { python -m venv $Venv }
}
$Python = Join-Path $Venv "Scripts\python.exe"
& $Python -m pip install --quiet --upgrade pip
& $Python -m pip install --quiet -r backend\requirements-desktop.txt
& $Python -m PyInstaller packaging\bedrock-portal.spec --noconfirm

Write-Host ""
Write-Host "Built: $Root\dist\Bedrock Portal.exe" -ForegroundColor Green
Write-Host "Double-click it, or pin it to Start / the taskbar."
