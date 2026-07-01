# setup.ps1 - One-command setup for Windows (corporate-friendly).
#
#   Right-click > Run with PowerShell,  OR from a terminal:
#       powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Does everything automatically: installs dependencies, repairs the Electron
# binary (the usual "Electron uninstall" failure behind corporate proxies),
# creates .env, and type-checks. No manual steps.

$ErrorActionPreference = 'Stop'

# Allow this script to run even if the machine's policy is Restricted.
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force | Out-Null

# Trust the corporate proxy's certificate (Node 22+) so downloads succeed.
$env:NODE_OPTIONS = '--use-system-ca'
$env:ELECTRON_GET_USE_PROXY = 'true'

# Run from this script's folder regardless of where it was launched.
Push-Location $PSScriptRoot
try {
    Write-Host 'Starting automated setup...' -ForegroundColor Cyan
    npm run setup
    if ($LASTEXITCODE -ne 0) {
        throw "Setup failed with exit code $LASTEXITCODE."
    }
    Write-Host ''
    Write-Host 'Done. Launch the app with:  npm run dev' -ForegroundColor Green
}
finally {
    Pop-Location
}
