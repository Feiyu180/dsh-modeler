<#
restart-dsh.ps1 —— 重启 DSH 桌面端，让新装的插件生效。

为什么需要它：`dsh.client` 的 bundle 清单是**启动时**组合进 boot graph 的，
替换 profile 后必须重启 host 才会把 dsh-modeler 纳入；只刷新页面拿不到 client 半边的加载行。

重启会关掉当前会话的窗口，但**会话数据不会丢**：
  - 会话记录在 C:\Users\YOURNAME\.dsh\sessions
  - 换回来后点侧栏里那个会话即可继续

用法：
  .\restart-dsh.ps1              # 提示确认后重启
  .\restart-dsh.ps1 -Force       # 不提示
  .\restart-dsh.ps1 -DryRun      # 只打印将要执行的动作
#>

param(
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$exe = 'D:\dsh\DeepSeek Harness.exe'
if (-not (Test-Path $exe)) { throw "找不到 DSH 主程序：$exe" }

# 只挑顶层进程（不带 --type=），子进程会随主进程退出
$main = Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }

Write-Host "将重启 DSH 桌面端" -ForegroundColor Cyan
Write-Host "  可执行文件：$exe"
Write-Host "  当前顶层进程：$(($main | ForEach-Object { $_.ProcessId }) -join ', ')"
Write-Host ""
Write-Host "重启后：左侧栏底部「设置」上方应出现「◧ 三视图建模」按钮。" -ForegroundColor Yellow
Write-Host "本会话窗口会被关掉，但会话记录保留（在侧栏里点回来即可）。" -ForegroundColor Yellow
Write-Host ""

if ($DryRun) {
  Write-Host "DryRun：不实际执行。" -ForegroundColor DarkGray
  exit 0
}

if (-not $Force) {
  $ans = Read-Host "确认重启？(y/N)"
  if ($ans -notmatch '^[yY]') { Write-Host '已取消。' -ForegroundColor DarkGray; exit 0 }
}

# 1) 优雅关闭：先 CloseMainWindow，给它机会保存
foreach ($p in $main) {
  try {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
      [void]$proc.CloseMainWindow()
      Write-Host "  已请求关闭 PID $($p.ProcessId)" -ForegroundColor DarkGray
    }
  } catch { }
}

# 2) 等它退干净（最多 20 秒），还不走就强制
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $alive = Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
  if (-not $alive) { break }
  Start-Sleep -Milliseconds 400
}

$alive = Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
if ($alive) {
  Write-Host "  20 秒内没退干净，强制结束：$(($alive | ForEach-Object { $_.ProcessId }) -join ', ')" -ForegroundColor Yellow
  foreach ($p in $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# 3) 重新拉起
Write-Host "  正在启动…" -ForegroundColor DarkGray
Start-Process -FilePath $exe
Start-Sleep -Seconds 4

$now = Get-CimInstance Win32_Process -Filter "Name like '%DeepSeek%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
if ($now) {
  Write-Host "✔ 已重启（PID $(($now | ForEach-Object { $_.ProcessId }) -join ', ')）" -ForegroundColor Green
} else {
  Write-Host "✘ 看起来没起来，请手动双击 $exe" -ForegroundColor Red
}
