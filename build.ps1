# One-step local build for Windows.
#   .\build.ps1              build a runnable app folder (fastest)
#   .\build.ps1 -Installer   also build the installer (.exe) and a portable zip
#   .\build.ps1 -Run         build, then start the app
param([switch]$Installer, [switch]$Run)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`nBuild failed: $text" -ForegroundColor Red; exit 1 }
function Run-Native($exe, [string[]]$argv, $why) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail $why }
}

Step 'Checking Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Get version 22 or newer from https://nodejs.org' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Fail "Node.js $(node -v) is too old; version 22 or newer is needed." }
Write-Host "Node.js $(node -v)"

# Behind a proxy (e.g. Clash), let Node's own downloads (Electron) use it too.
if ($env:HTTPS_PROXY -or $env:HTTP_PROXY -or $env:https_proxy -or $env:http_proxy) {
  $env:NODE_USE_ENV_PROXY = '1'
  Write-Host 'Using the proxy from HTTPS_PROXY/HTTP_PROXY'
}

Step 'Installing dependencies'
Run-Native 'npm.cmd' @('install', '--no-audit', '--no-fund') 'npm install did not finish. If you are behind a proxy, set $env:HTTPS_PROXY first (for example http://127.0.0.1:3128).'

Step 'Building'
Run-Native 'npx.cmd' @('electron-vite', 'build') 'the build step failed (see above).'

Step 'Packaging'
if ($Installer) {
  Run-Native 'npx.cmd' @('electron-builder', '--win', 'nsis', 'zip', '--x64', '--publish', 'never') 'packaging failed (see above).'
} else {
  Run-Native 'npx.cmd' @('electron-builder', '--win', '--dir', '--x64', '--publish', 'never') 'packaging failed (see above).'
}

$exe = Join-Path $PSScriptRoot 'release\win-unpacked\Ancora.exe'
Write-Host "`nDone." -ForegroundColor Green
if (Test-Path $exe) { Write-Host "App: $exe" }
if ($Installer) {
  Write-Host 'Installer and zip:'
  Get-ChildItem (Join-Path $PSScriptRoot 'release') -File | Where-Object { $_.Extension -in '.exe', '.zip' } | ForEach-Object { Write-Host "  $($_.FullName)" }
}
if ($Run -and (Test-Path $exe)) {
  Step 'Starting Ancora'
  Start-Process $exe
}
