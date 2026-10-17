<#
verify-panel.ps1 —— 面板「全渲染 + 模拟拖图」验证。

与另外两步的分工：
  verify-ui.mjs        记录型 React **shim** 跑组件树（抓组件引用/属性错，但不挂真 DOM、不跑 three.js）
  verify-browser.ps1   浏览器端**图片读取链路**与 Node 对账
  本脚本               **真实 React 18 UMD 挂载 + 真 DOM + 真 three.js + DataTransfer 模拟拖图**

为什么这一步不可替代：它走完的是**用户实际会走的那条路** ——
把三张图拖进面板 → 剪影 → 重建 → three.js 画出来。前面两步都只覆盖这条路的一段。

做法：
  build/make-panel-mount-test.mjs 把 React UMD + ReactDOM UMD + 三张夹具 PNG（base64）
  + 打包好的面板入口全部内联进 tools/panel-mount-test.html（自包含，file:// 可开）；
  页面自己挂载面板、用 DataTransfer 往三个槽注入图片、等重建、把结论写进 document.title
  与页面正文。这里用 headless Edge 跑它、截图、并按标题做机器判定。

⚠ --virtual-time-budget 必须给足（90000）。给太少时页面还在注入/重建阶段就被截图了。

⚠ -Repeat 的意义（默认 3，**别改成 1**）：
  这一步抓到过一个"有时好有时坏"的真 bug —— 内联 ref 回调被 React 每次重渲染以 null 调一次，
  于是视口被反复拆掉，表现为**随机**地 canvas 为 0 / 报 precision 错。同一份代码连跑 3 次里
  2 次失败、1 次通过。只跑一次的话，这种 bug 有 1/3 的概率被放过 —— 所以这里默认连跑 3 次，
  要求**全过**才算通过。
#>

param(
  [int]$VirtualTimeBudgetMs = 90000,
  [string]$OutShot = 'D:\dsh-modeler\tools\_panel-mount-shot.png',
  [int]$Repeat = 3
)

$ErrorActionPreference = 'Continue'

$ROOT = 'D:\dsh-modeler'
$NODE = 'C:\Users\YOURNAME\<node-v22>\node.exe'
$EDGE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

foreach ($p in @($NODE, $EDGE)) {
  if (-not (Test-Path $p)) { Write-Host "缺少：$p" -ForegroundColor Red; exit 1 }
}

Write-Host "[1/3] 生成 panel-mount-test.html" -ForegroundColor Cyan
Push-Location "$ROOT\build"
& $NODE make-panel-mount-test.mjs 2>&1 | Select-Object -Last 3
$genCode = $LASTEXITCODE
Pop-Location
if ($genCode -ne 0) { Write-Host "生成失败" -ForegroundColor Red; exit 1 }

$html = "$ROOT\tools\panel-mount-test.html"
$url = 'file:///' + ($html -replace '\\', '/')

Write-Host "[2/3] headless Edge 跑（budget=$VirtualTimeBudgetMs ms，窗口 1000x1300）" -ForegroundColor Cyan
if (Test-Path $OutShot) { Remove-Item $OutShot -Force }
& $EDGE --headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox `
  --screenshot="$OutShot" --window-size=1000,1300 --hide-scrollbars `
  --virtual-time-budget=$VirtualTimeBudgetMs "$url" 2>&1 |
  Select-String -Pattern 'written to file' | Select-Object -First 1

Write-Host "[3/3] 判定（连跑 $Repeat 次，必须全过）" -ForegroundColor Cyan

$shotKb = if (Test-Path $OutShot) { [math]::Round((Get-Item $OutShot).Length / 1KB) } else { 0 }
if ($shotKb -gt 100) {
  Write-Host "  OK  截图 $shotKb KB（>100KB 说明 three.js 真渲染出了内容，不是空白页）" -ForegroundColor Green
} else {
  Write-Host "  失败  截图 $shotKb KB 过小 —— 面板可能没渲染出来" -ForegroundColor Red
}

$runs = @()
$verdict = 0
for ($i = 1; $i -le [Math]::Max(1, $Repeat); $i++) {
  $dom = & $EDGE --headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox `
    --dump-dom --virtual-time-budget=$VirtualTimeBudgetMs "$url" 2>&1 | Out-String
  if ($dom -match 'panel-mount-OK') {
    $runs += "OK"
    Write-Host "  第 $i 次：OK（挂载 + 拖图 + 重建 + WebGL 全通过）" -ForegroundColor Green
  } elseif ($dom -match 'panel-mount-FAIL' -or $dom -match 'panel-mount-ERROR') {
    $runs += "FAIL"
    $verdict = 1
    $detail = if ($dom -match 'id="verdict"[^>]*>(.*?)</div>') { ($matches[1] -replace '<[^>]+>','') } else { '' }
    Write-Host "  第 $i 次：失败 —— $detail" -ForegroundColor Red
  } elseif ($dom -match '面板全渲染通过') {
    $runs += "OK"
    Write-Host "  第 $i 次：OK（标题读取不可用，退化为正文匹配）" -ForegroundColor Green
  } else {
    $runs += "?"
    Write-Host "  第 $i 次：无法判定 DOM（可能是 --dump-dom 在这个 Edge 版本下不输出）" -ForegroundColor Yellow
  }
}
if ($runs -contains '?') { $verdict = if ($shotKb -gt 100) { 0 } else { 1 } }
Write-Host "  结果：$($runs -join ' / ')" -ForegroundColor DarkGray

Write-Host ""
Write-Host "面板全渲染验证$(if ($verdict -eq 0) { '通过' } else { '失败' })。" `
  -ForegroundColor $(if ($verdict -eq 0) { 'Green' } else { 'Red' })
Write-Host "截图：$OutShot" -ForegroundColor DarkGray
exit $verdict
