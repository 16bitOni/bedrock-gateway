# Bedrock Portal - Windows launcher
# Usage (PowerShell, from the project folder):   .\scripts\start.ps1            # http://127.0.0.1:8787
#                                                 .\scripts\start.ps1 -Port 9000 -Rebuild
param(
    [int]$Port = 8787,
    [string]$BindHost = "127.0.0.1",
    [switch]$Rebuild
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Venv = Join-Path $Backend ".venv"

# Load .env (KEY=VALUE lines) into this process
$EnvFile = Join-Path $Root ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$' -and $_ -notmatch '^\s*#') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), "Process")
        }
    }
}

$py = Get-Command py -ErrorAction SilentlyContinue
if (-not (Test-Path $Venv)) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Cyan
    if ($py) { py -3 -m venv $Venv } else { python -m venv $Venv }
}
$Python = Join-Path $Venv "Scripts\python.exe"
& $Python -m pip install --quiet --upgrade pip
& $Python -m pip install --quiet -r (Join-Path $Backend "requirements.txt")

$Dist = Join-Path $Frontend "dist\index.html"
if ($Rebuild -or -not (Test-Path $Dist)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warning "Node.js/npm not found - the dashboard can't be built. Install Node 20+ from https://nodejs.org (the API still works)."
    } else {
        Write-Host "Building dashboard..." -ForegroundColor Cyan
        Push-Location $Frontend
        if (Test-Path "package-lock.json") { npm ci } else { npm install }
        npm run build
        Pop-Location
    }
}

Write-Host ""
Write-Host "Bedrock Portal -> http://$($BindHost):$Port" -ForegroundColor Green
Write-Host "OpenAI base URL:    http://$($BindHost):$Port/v1"
Write-Host "Anthropic base URL: http://$($BindHost):$Port"
Write-Host ""
Push-Location $Backend
& $Python -m uvicorn app.main:app --host $BindHost --port $Port
Pop-Location
