# 打包发行版：把工具需要的文件按目录结构塞进一个 zip。
# 用 .NET 的 ZipArchive 直接取文件写入，不做中间拷贝。
#
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File tools\package.ps1 -Version 1.0.1

param(
  [string]$Version = '1.0.1',
  [string]$Name = '视频进度条工具'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root 'dist'
if (-not (Test-Path -LiteralPath $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$zipPath = Join-Path $distDir ("video-progress-bar-v$Version-win64.zip")

# 要打包的东西（相对路径）
$files = @(
  'app\server.js',
  'app\lib\ffmpeg.js',
  'app\lib\jobs.js',
  'app\public\index.html',
  'app\public\styles.css',
  'app\public\scene.js',
  'app\public\app.js',
  'app\public\dev-verify.html',
  'app\public\dev-export.html',
  'bin\node.exe',
  'bin\ffmpeg.exe',
  'bin\NODE-LICENSE.txt',
  'docs\node-missing.txt',
  'docs\preview.png',
  'tools\pick.ps1',
  'tools\selftest.js',
  'tools\browser-test.js',
  'tools\ui-flow.js',
  'tools\bench.js',
  'tools\probe-check.js',
  '启动进度条工具.cmd',
  '调试启动.cmd',
  '使用说明.txt',
  'README.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md'
)

# 先确认必需文件都在，缺了就直接报错，不要打出残缺的包
$missing = @()
foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $f))) { $missing += $f }
}
if ($missing.Count) {
  Write-Host '缺少以下文件，无法打包：' -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $src = Join-Path $root $f
    $entry = $Name + '/' + ($f -replace '\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $src, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    Write-Host ("  打包 {0,-42} {1,8:N0} KB" -f $f, ((Get-Item -LiteralPath $src).Length / 1KB))
  }
}
finally {
  $zip.Dispose()
}
$sw.Stop()

$size = (Get-Item -LiteralPath $zipPath).Length
Write-Host ''
Write-Host ("完成：{0}" -f $zipPath) -ForegroundColor Green
Write-Host ("大小：{0:N1} MB   耗时：{1:N1} 秒   共 {2} 个文件" -f ($size / 1MB), $sw.Elapsed.TotalSeconds, $files.Count)
