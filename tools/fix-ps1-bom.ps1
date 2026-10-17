<#
fix-ps1-bom.ps1 —— 给 tools/ 下所有 .ps1 补上 UTF-8 BOM（幂等）。

为什么需要这个：
  本机 PowerShell 是 **5.1**，它读没有 BOM 的 .ps1 时按 **GBK** 解码。文件里只要有中文
  （注释、Write-Host 文案、正则里的夹具名），解码就会错乱，轻则输出乱码，重则直接
  报 "字符串缺少终止符" / "Unexpected token '}'" —— 明明文件本身是好的。
  这个坑踩过两次：改一次 .ps1 就复发一次（有些编辑器/工具写文件会把 BOM 丢掉）。

用法：
  powershell -File tools/fix-ps1-bom.ps1            # 修复
  powershell -File tools/fix-ps1-bom.ps1 -Check     # 只检查（有缺 BOM 就退出码 1）
#>

param(
  [switch]$Check,
  [string]$Root
)

# 默认修**本脚本所在的 tools 目录**，而不是写死本机路径。
# （原来写死 'D:\dsh-modeler\tools'：在交付副本里跑会跑去改工作区那份，行为与预期不符。）
if (-not $Root) { $Root = $PSScriptRoot }

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$missing = @()
$fixed = @()

foreach ($f in Get-ChildItem -Path $Root -Filter *.ps1 -File) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($hasBom) { continue }
  $missing += $f.Name
  if (-not $Check) {
    # 解码时去掉可能存在的 U+FEFF（避免写成双 BOM），再带 BOM 写回
    $text = $utf8NoBom.GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
    $fixed += $f.Name
  }
}

if ($missing.Count -eq 0) {
  Write-Host "OK：$Root 下所有 .ps1 都带 UTF-8 BOM" -ForegroundColor Green
  exit 0
}
if ($Check) {
  Write-Host "缺 BOM（PowerShell 5.1 会按 GBK 解码，中文会崩）：$($missing -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "已补 BOM：$($fixed -join ', ')" -ForegroundColor Green
exit 0
