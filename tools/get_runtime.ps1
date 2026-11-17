# 下载一份免安装的 Windows Node（只取 node.exe）到 runtime\，给「启动播放器.cmd」用。
# 用法（在播放器目录下）：powershell -ExecutionPolicy Bypass -File tools\get_runtime.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$runtime = Join-Path $root "runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

Write-Host "查询 Node 版本列表…"
$index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
$ver = ($index | Where-Object { $_.version -like "v22.*" } | Select-Object -First 1).version
if (-not $ver) { throw "没找到 v22 版本" }

$name = "node-$ver-win-x64"
$zip = Join-Path $env:TEMP "$name.zip"
$url = "https://nodejs.org/dist/$ver/$name.zip"
Write-Host "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "解压 node.exe …"
$tmp = Join-Path $env:TEMP $name
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Copy-Item (Join-Path $tmp "$name\node.exe") (Join-Path $runtime "node.exe") -Force
Remove-Item -Recurse -Force $tmp, $zip

$size = [math]::Round((Get-Item (Join-Path $runtime "node.exe")).Length / 1MB, 1)
Write-Host "完成：runtime\node.exe（$size MB）。现在可以双击「启动播放器.cmd」。"
