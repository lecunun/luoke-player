# Portable Node.js fetcher (fallback path used by the launcher).
# Downloads node.exe only, keeps it in .\runtime\, so the player can run without
# installing Node.js system-wide.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\get_runtime.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 files with the ANSI
# code page unless they start with a UTF-8 BOM, so non-ASCII text would break.
param(
  [string]$Version = "v22.22.2"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtime = Join-Path $root "runtime"
if (-not (Test-Path $runtime)) { New-Item -ItemType Directory -Path $runtime | Out-Null }

$name = "node-$Version-win-x64"
$zip = Join-Path $env:TEMP "$name.zip"
$tmp = Join-Path $env:TEMP $name
$mirrors = @(
  "https://cdn.npmmirror.com/binaries/node/$Version/$name.zip",
  "https://npmmirror.com/mirrors/node/$Version/$name.zip",
  "https://nodejs.org/dist/$Version/$name.zip"
)

$ok = $false
foreach ($url in $mirrors) {
  try {
    Write-Host "Downloading $url"
    if (Test-Path $zip) { Remove-Item -Force $zip }
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 1800
    if ((Test-Path $zip) -and ((Get-Item $zip).Length -gt 1000000)) { $ok = $true; break }
    Write-Host "  file too small, trying next source"
  } catch {
    Write-Host ("  failed: " + $_.Exception.Message)
  }
}
if (-not $ok) {
  Write-Host ""
  Write-Host "All download sources failed. Install Node.js 18+ from https://nodejs.org/ instead."
  exit 1
}

Write-Host "Unpacking node.exe ..."
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$exe = Get-ChildItem -Path $tmp -Filter "node.exe" -Recurse | Select-Object -First 1
if (-not $exe) { Write-Host "node.exe not found inside the archive."; exit 1 }
Copy-Item $exe.FullName (Join-Path $runtime "node.exe") -Force

Remove-Item -Recurse -Force $tmp
Remove-Item -Force $zip

$size = [math]::Round((Get-Item (Join-Path $runtime "node.exe")).Length / 1MB, 1)
Write-Host "Done: runtime\node.exe ($size MB). You can double-click the launcher now."
exit 0
