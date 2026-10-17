<#
verify-all.ps1 —— 一键跑完 dsh-modeler 的全部验证，最后给一张总表。

每步都独立跑、独立报结论：任一步失败就把它记下来继续跑下一步（而不是立刻退出），
这样一次运行就能看到"到底坏在哪一层"。

用法：
  .\verify-all.ps1
  .\verify-all.ps1 -SkipSlow     # 跳过最慢的两项（Python 逐体素 + 端到端）
#>

param([switch]$SkipSlow)

$ErrorActionPreference = 'Continue'

$ROOT = 'D:\dsh-modeler'
$NODE = 'C:\Users\YOURNAME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$NODE22 = 'C:\Users\YOURNAME\<node-v22>\node.exe'
$PY = 'C:\Users\YOURNAME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

foreach ($p in @($NODE, $NODE22, $PY)) {
  if (-not (Test-Path $p)) { Write-Host "缺少可执行文件：$p" -ForegroundColor Red; exit 1 }
}

$results = [System.Collections.ArrayList]::new()

function Run-Step {
  param(
    [string]$Name,
    [string]$Exe,
    # 注意：不要把这个参数叫 $Args —— 它是 PowerShell 的自动变量，
    # 当成 param 名会被静默忽略（不报错），表现为命令拿不到任何参数。
    [string[]]$ArgList,
    [string]$WorkDir = $ROOT,
    [string]$ExpectPattern = $null,
    # 某些步骤在"前提不满足"时会以约定退出码主动跳过（例如多视图权重还没下载完
    # → test-hunyuan-mv.mjs 退出码 2）。那种情况不应该算失败，否则一跑全量就红。
    [int]$SkipOnExit = -1
  )
  Write-Host ""
  Write-Host ("─" * 70) -ForegroundColor DarkGray
  Write-Host "▶ $Name" -ForegroundColor Cyan
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Push-Location $WorkDir
  try {
    $out = & $Exe @ArgList 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  $sw.Stop()

  # 只回显末尾若干行，避免刷屏
  $lines = $out.TrimEnd() -split "`r?`n"
  $tail = if ($lines.Count -gt 14) { $lines[($lines.Count - 14)..($lines.Count - 1)] } else { $lines }
  foreach ($l in $tail) { Write-Host "  $l" -ForegroundColor DarkGray }

  if ($SkipOnExit -ge 0 -and $code -eq $SkipOnExit) {
    Write-Host "  ○ 跳过（exit=$code：前提不满足，见上面最后一行的说明）" -ForegroundColor Yellow
    [void]$results.Add([pscustomobject]@{
        Step = $Name; Pass = $true; Exit = $code; Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
      })
    return
  }

  $pass = ($code -eq 0)
  if ($pass -and $ExpectPattern -and ($out -notmatch $ExpectPattern)) {
    $pass = $false
    Write-Host "  期望输出里应包含 /$ExpectPattern/，但没找到" -ForegroundColor Yellow
  }

  [void]$results.Add([pscustomobject]@{
      Step    = $Name
      Pass    = $pass
      Exit    = $code
      Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    })
  if ($pass) { Write-Host "  ✔ 通过（$([math]::Round($sw.Elapsed.TotalSeconds,1)) s）" -ForegroundColor Green }
  else { Write-Host "  ✘ 失败（exit=$code）" -ForegroundColor Red }
}

Write-Host "dsh-modeler 全量验证" -ForegroundColor White
Write-Host "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# 1. 核心回归（33 项）
Run-Step -Name '核心算法回归 selftest.test.mjs' -Exe $NODE `
  -ArgList @('--test', "$ROOT\tools\selftest.test.mjs") -ExpectPattern '# fail 0|fail 0'

# 2. 夹具独立验收（Pillow 解码，与 expected.json 对数）
Run-Step -Name '夹具独立验收 verify-fixtures.py（Pillow）' -Exe $PY `
  -ArgList @("$ROOT\tools\verify-fixtures.py") -ExpectPattern '全部通过|ȫ��ͨ��'

# 3. 客户端 bundle 协议冒烟
Run-Step -Name '客户端 bundle 冒烟 smoke-client.mjs' -Exe $NODE22 `
  -ArgList @("$ROOT\build\smoke-client.mjs") -ExpectPattern '"ok": true'

# 4. host 三工具实测
Run-Step -Name 'host 三工具实测 verify-host.mjs' -Exe $NODE `
  -ArgList @("$ROOT\tools\verify-host.mjs") -ExpectPattern 'host 侧全部通过'

# 5. UI 组件树真实渲染（记录型 React shim：能抓组件引用错/属性访问错/文案缺失）
Run-Step -Name 'UI 组件树渲染 verify-ui.mjs' -Exe $NODE `
  -ArgList @("$ROOT\tools\verify-ui.mjs") -ExpectPattern 'UI 组件树渲染通过'

# 5b. JSON 导出格式的闭环（写出来必须能读回来，且拓扑统计一致）
Run-Step -Name 'JSON 网格往返 test-mesh-json.mjs' -Exe $NODE `
  -ArgList @("$ROOT\tools\test-mesh-json.mjs") -ExpectPattern 'toMeshJSON 测试通过'

# 5c. 导出到本地目录的端点（按客户端给的路径写盘：happy path + 非法请求全部拦下）
Run-Step -Name '导出端点 test-export-api.mjs' -Exe $NODE `
  -ArgList @("$ROOT\tools\test-export-api.mjs") -ExpectPattern 'POST /export 测试通过'

# 5d. 多视图 Hunyuan3D-2mv 实测（**慢，约 4-5 分钟**；权重没装好会打印提示并跳过）
Run-Step -Name '多视图 Hunyuan3D-2mv 实测 test-hunyuan-mv.mjs（慢）' -Exe $NODE `
  -ArgList @("$ROOT\tools\test-hunyuan-mv.mjs") -ExpectPattern '多视图实测通过' -SkipOnExit 2

# 6. 浏览器端图片读取链路（createImageBitmap + getImageData）与 Node 端对账
#    实测只需 ~2.5 秒（--virtual-time-budget 是虚拟时间，不占实际时间）
Run-Step -Name '浏览器端链路 verify-browser.ps1' -Exe 'powershell' `
  -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$ROOT\tools\verify-browser.ps1") `
  -ExpectPattern '浏览器端图片读取链路验证通过'

# 7. 面板「全渲染 + 模拟拖图」：真实 React UMD 挂载 + 真 DOM + 真 three.js + DataTransfer 拖图
#    这一步走完的是**用户实际会走的那条路**（挂载 → 拖图 → 剪影 → 重建 → 画出来）
Run-Step -Name '面板全渲染 verify-panel.ps1' -Exe 'powershell' `
  -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$ROOT\tools\verify-panel.ps1") `
  -ExpectPattern '面板全渲染验证通过'

if (-not $SkipSlow) {
  # 8. 刷新跨语言对数用的 JS 基准（必须在新一轮 Python 对照之前跑，否则会拿过期数据比）
  Run-Step -Name '刷新 JS 实雕基准 dump-carve.mjs' -Exe $NODE `
    -ArgList @("$ROOT\tools\dump-carve.mjs") -ExpectPattern '已写出'

  # 9. 独立解析实现（Python 逐体素）—— 同时产出 verify-pipeline 需要的基准
  Run-Step -Name '独立解析体素数 expect-voxels.py' -Exe $PY `
    -ArgList @("$ROOT\tools\expect-voxels.py")

  # 10. 端到端（以 Python 基准为准）
  Run-Step -Name '端到端 verify-pipeline.mjs' -Exe $NODE `
    -ArgList @("$ROOT\tools\verify-pipeline.mjs") -ExpectPattern '全部通过'
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("═" * 70) -ForegroundColor DarkGray
Write-Host "总表" -ForegroundColor White
Write-Host ("═" * 70) -ForegroundColor DarkGray
$results | Format-Table -AutoSize | Out-String | Write-Host

$failed = @($results | Where-Object { -not $_.Pass })
if ($failed.Count) {
  Write-Host "有 $($failed.Count) 步失败：" -ForegroundColor Red
  foreach ($f in $failed) { Write-Host "  - $($f.Step)" -ForegroundColor Red }
  exit 1
}
Write-Host "全部 $($results.Count) 步通过。" -ForegroundColor Green
Write-Host ""
Write-Host "提醒：host 侧的 3 个工具（modeler_save / modeler_load / modeler_views）" -ForegroundColor DarkGray
Write-Host "      需要重启 DSH 桌面端才会出现在工具列表里；客户端面板刷新页面即可。" -ForegroundColor DarkGray
