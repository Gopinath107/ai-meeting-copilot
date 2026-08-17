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

# Trust the corporate proxy's certificate during setup only. Electron rejects
# --use-system-ca in NODE_OPTIONS, so always restore the caller's environment.
$previousNodeOptions = $env:NODE_OPTIONS
$previousElectronProxy = $env:ELECTRON_GET_USE_PROXY
$supportsSystemCa = & node -p "process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? 'yes' : 'no'"
if ($LASTEXITCODE -ne 0) {
    throw 'Node.js is required but could not be executed.'
}
if ($supportsSystemCa -eq 'yes' -and $env:NODE_OPTIONS -notmatch '(?:^|\s)--use-system-ca(?:\s|$)') {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--use-system-ca' | Where-Object { $_ }) -join ' ').Trim()
}
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
    if ($null -eq $previousNodeOptions) {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    }
    else {
        $env:NODE_OPTIONS = $previousNodeOptions
    }
    if ($null -eq $previousElectronProxy) {
        Remove-Item Env:ELECTRON_GET_USE_PROXY -ErrorAction SilentlyContinue
    }
    else {
        $env:ELECTRON_GET_USE_PROXY = $previousElectronProxy
    }
}
