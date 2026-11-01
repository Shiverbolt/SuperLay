# Downloads the latest console PresentMon build from Intel's GitHub releases into ./vendor.
# SuperLay can also do this itself: Settings → Diagnostics → Download latest PresentMon.
$ErrorActionPreference = 'Stop'
$vendor = Join-Path $PSScriptRoot '..\vendor'
New-Item -ItemType Directory -Force $vendor | Out-Null

$rel = Invoke-RestMethod 'https://api.github.com/repos/GameTechDev/PresentMon/releases/latest' -Headers @{ 'User-Agent' = 'SuperLay' }
$asset = $rel.assets | Where-Object { $_.name -match '^PresentMon-[\d.]+-x64\.exe$' } | Select-Object -First 1
if (-not $asset) { throw "No console x64 build found in release $($rel.tag_name)" }

$dest = Join-Path $vendor $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $dest -Headers @{ 'User-Agent' = 'SuperLay' }
Write-Host "PresentMon $($rel.tag_name) -> $dest"
