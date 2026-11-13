# Twinly setup - run once. Windows PowerShell 5.1 compatible.
# Usage:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
function Say($msg, $color = 'Cyan') { Write-Host "  $msg" -ForegroundColor $color }
function Set-EnvValue($key, $value) {
  $path = Join-Path $PSScriptRoot '.env'
  $lines = @(); if (Test-Path $path) { $lines = @(Get-Content $path) }
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^\s*$key=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($path, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Say 'TWINLY SETUP' 'Green'
Write-Host ''

# 1. Node.js 20+
$ok = $false
if (Get-Command node -ErrorAction SilentlyContinue) { if ([int]((& node -v).TrimStart('v').Split('.')[0]) -ge 20) { $ok = $true } }
if (-not $ok) {
  Say 'Installing Node.js (one time)...' 'Yellow'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Say 'Node.js installed. Close this window and run setup.ps1 again.' 'Yellow'; Read-Host '  Press Enter to close'; exit 1 }
}
Say ("Node.js " + (& node -v) + " ready")

# 2. Packages
Say 'Installing Twinly (about a minute)...'
& npm install --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Say 'Install failed - check your internet and run setup.ps1 again.' 'Red'; Read-Host '  Press Enter to close'; exit 1 }

# 3. Settings file
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

# 4. Phone access (optional)
Write-Host ''
$ans = Read-Host '  Do you also want to open Twinly from your iPhone on the same Wi-Fi? (Y/N)'
if ($ans -match '^[Yy]') {
  do { $pw = Read-Host '  Choose a password for the Twinly dashboard (min 6 characters)' } while ($pw.Length -lt 6)
  Set-EnvValue 'HOST' '0.0.0.0'
  Set-EnvValue 'DASHBOARD_PASSWORD' $pw
  try { New-NetFirewallRule -DisplayName 'Twinly' -Direction Inbound -Protocol TCP -LocalPort 4747 -Action Allow -Profile Private -ErrorAction Stop | Out-Null; Say 'Firewall opened for Twinly (private Wi-Fi only).' }
  catch { Say 'If Windows Firewall pops up when Twinly starts, tick "Private networks" and click Allow.' 'Yellow' }
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
  if ($ip) { Say "On your iPhone open:  http://${ip}:4747   (username: anything, password: the one you chose)" 'Green' }
} else {
  Set-EnvValue 'HOST' '127.0.0.1'
}

# 5. Desktop shortcut
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Twinly.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\start.ps1`""
$sc.WorkingDirectory = $PSScriptRoot
$sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,160"
$sc.Description = 'Start Twinly'
$sc.Save()
Say 'Added a "Twinly" shortcut to your Desktop - double-click it any time to start.' 'Green'

Write-Host ''
Say 'Starting Twinly now...' 'Green'
& (Join-Path $PSScriptRoot 'start.ps1')
