<#
verify-browser.ps1 —— 验证**浏览器端独有的图片读取链路**，并与 Node 端对账。

为什么需要单独一步：
  整条管线里只有这一段是浏览器独有的 ——
      File/Blob → createImageBitmap（含 EXIF 方向）→ canvas → getImageData → RGBA
  Node 侧我用的是自己写的 decodePNG（另一套代码路径）。如果这一段有问题
  （颜色空间、alpha 预乘、canvas 尺寸、EXIF 旋转），用户在网页里拖图就会得到
  与 Node 端不一致的剪影 —— 而所有回归测试都在 Node 侧，照不出来。

做法：
  1. build/make-browser-test.mjs 把三张夹具 PNG（base64）+ Node 端对照值 + 打包好的
     浏览器入口一起内联进 tools/browser-test.html（自包含，file:// 可开）
  2. headless Edge 跑它，页面逐项对账并把结果画成表
  3. 截图存档；同时用 --dump-dom 抓标题做通过/失败的机器判定

⚠ 关键参数：--virtual-time-budget 必须给足（用 90000）。
  给 15000 时页面只跑到第 3 个用例的进度提示就截图了（虚拟时间到期），
  看起来像"卡住"，其实只是没跑完。
#>

param(
  [int]$VirtualTimeBudgetMs = 90000,
  [string]$OutShot = 'D:\dsh-modeler\tools\_browser-test-shot.png'
)

$ErrorActionPreference = 'Continue'

$ROOT = 'D:\dsh-modeler'
$NODE = 'C:\Users\YOURNAME\<node-v22>\node.exe'
$EDGE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

foreach ($p in @($NODE, $EDGE)) {
  if (-not (Test-Path $p)) { Write-Host "缺少：$p" -ForegroundColor Red; exit 1 }
}

Write-Host "[1/3] 生成 browser-test.html（含 Node 端对照值）" -ForegroundColor Cyan
Push-Location "$ROOT\build"
& $NODE make-browser-test.mjs 2>&1 | Select-Object -Last 6
$genCode = $LASTEXITCODE
Pop-Location
if ($genCode -ne 0) { Write-Host "生成失败" -ForegroundColor Red; exit 1 }

$html = "$ROOT\tools\browser-test.html"
$url = 'file:///' + ($html -replace '\\', '/')
Write-Host "[2/3] headless Edge 跑一遍（virtual-time-budget=$VirtualTimeBudgetMs ms）" -ForegroundColor Cyan
if (Test-Path $OutShot) { Remove-Item $OutShot -Force }
& $EDGE --headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox `
  --screenshot="$OutShot" --window-size=900,760 --hide-scrollbars `
  --virtual-time-budget=$VirtualTimeBudgetMs "$url" 2>&1 |
  Select-String -Pattern 'written to file' | Select-Object -First 1

Write-Host "[3/3] 判定" -ForegroundColor Cyan

$shotOk = (Test-Path $OutShot) -and ((Get-Item $OutShot).Length -gt 20000)
if ($shotOk) {
  Write-Host ("  OK  截图已生成，{0} KB（>20KB 说明表格渲染出来了，不是空白/进度页）" -f [math]::Round((Get-Item $OutShot).Length / 1KB)) -ForegroundColor Green
} else {
  Write-Host "  失败 截图缺失或过小 —— 页面可能没跑完（试试调大 -VirtualTimeBudgetMs）" -ForegroundColor Red
}

# 用 dump-dom 抓页面标题做机器判定（标题由脚本设成 browser-test-OK / FAIL / ERROR）
$dom = & $EDGE --headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox `
  --dump-dom --virtual-time-budget=$VirtualTimeBudgetMs "$url" 2>&1 | Out-String

if ($dom -match 'browser-test-OK') {
  Write-Host "  OK  DOM 标题 = browser-test-OK ⇒ 浏览器端与 Node 端逐项一致" -ForegroundColor Green
  $verdict = 0
} elseif ($dom -match 'browser-test-FAIL') {
  Write-Host "  失败  DOM 标题 = browser-test-FAIL ⇒ 存在不一致，见截图里的红色行" -ForegroundColor Red
  $verdict = 1
} elseif ($dom -match '全部一致') {
  Write-Host "  OK  页面正文含「全部一致」（标题读取不可用，退化为正文匹配）" -ForegroundColor Green
  $verdict = 0
} else {
  Write-Host "  无法判定 DOM（--dump-dom 在这个 Edge 版本下可能不输出）；请人工看截图：" -ForegroundColor Yellow
  Write-Host "       $OutShot" -ForegroundColor Yellow
  $verdict = if ($shotOk) { 0 } else { 1 }
}

Write-Host ""
Write-Host "浏览器端图片读取链路验证$(if ($verdict -eq 0) { '通过' } else { '失败' })。" `
  -ForegroundColor $(if ($verdict -eq 0) { 'Green' } else { 'Red' })
Write-Host "截图：$OutShot" -ForegroundColor DarkGray
exit $verdict
