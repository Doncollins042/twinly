# Starts Twinly and opens it in your browser. Keep this window open while Twinly runs.
Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'Twinly - keep this window open'
$port = 4747
if (Test-Path '.env') { $m = Select-String -Path '.env' -Pattern '^PORT=(\d+)' | Select-Object -First 1; if ($m) { $port = [int]$m.Matches[0].Groups[1].Value } }
$url = "http://localhost:$port"

# Already running? Just open it.
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "  Twinly is already running - opening $url" -ForegroundColor Green
  Start-Process $url; Start-Sleep -Seconds 2; exit 0
}
if (-not (Test-Path 'node_modules')) { & npm install --no-fund --no-audit --loglevel=error }

Write-Host ''
Write-Host '  TWINLY is starting. Keep this window open - closing it stops auto-replies.' -ForegroundColor Green
Write-Host '  If linking WhatsApp in the browser is fiddly, the QR code also shows up here.' -ForegroundColor DarkGray
Write-Host ''
Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 3; Start-Process $u } -ArgumentList $url | Out-Null
while ($true) {
  & node server.js
  Write-Host '  Twinly stopped - restarting in 5 seconds (close this window to quit)...' -ForegroundColor Yellow
  Start-Sleep -Seconds 5
}
