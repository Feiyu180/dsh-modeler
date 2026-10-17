<#
refresh-dsh.ps1 —— 把 DSH 窗口切到前台，发一次刷新（F5），前后各截一张图。

为什么要这么绕：DSH 是 Electron 桌面应用，没有开远程调试端口（9222/9223 都不通），
所以没法用 CDP 发 Page.reload；只能把它切到前台后模拟一次 F5。
（已确认没有跑 pnpm dev:web，所以插件改动不会自动热重载，必须刷新。）

参数：
  -TitleMatch  主窗口标题需包含的子串（默认空 = 取第一个有标题的窗口）
  -WaitSec     刷新后等待加载的秒数
  -Before/-Out 两张截图的路径
退出码：0=成功；1=找不到窗口
#>

param(
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$TitleMatch = '',
  [int]$WaitSec = 9,
  [string]$Before = 'D:\dsh-modeler\tools\_refresh-before.png',
  [string]$After = 'D:\dsh-modeler\tools\_refresh-after.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('DSHWin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DSHWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

function Get-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][DSHWin]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

function Shot([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# --- 找窗口 ---
$cands = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $cands) {
  $cands = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "*$($ProcessName -replace ' ','*')*" }
}
if (-not $cands) { Write-Host "找不到进程「$ProcessName」的主窗口" -ForegroundColor Red; exit 1 }

$target = $null
foreach ($c in $cands) {
  $t = $c.MainWindowTitle
  if ($t -and ($TitleMatch -eq '' -or $t -like "*$TitleMatch*")) { $target = $c; break }
}
if (-not $target) { $target = $cands | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 }
if (-not $target) { Write-Host '找到进程但没有带标题的主窗口' -ForegroundColor Red; exit 1 }

$hwnd = $target.MainWindowHandle
Write-Host "目标：PID $($target.Id)  标题「$($target.MainWindowTitle)」" -ForegroundColor Cyan

# --- 抢前台 ---
if ([DSHWin]::IsIconic($hwnd)) { [void][DSHWin]::ShowWindow($hwnd, 9) }
[void][DSHWin]::ShowWindow($hwnd, 5)
$fg = [DSHWin]::GetForegroundWindow()
$fgT = [DSHWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [DSHWin]::GetCurrentThreadId()
$tgT = [DSHWin]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$a1 = $false; $a2 = $false
try {
  if ($fgT -ne $me) { $a1 = [DSHWin]::AttachThreadInput($me, $fgT, $true) }
  if ($tgT -ne $me) { $a2 = [DSHWin]::AttachThreadInput($me, $tgT, $true) }
  [void][DSHWin]::BringWindowToTop($hwnd)
  [void][DSHWin]::SetForegroundWindow($hwnd)
} finally {
  if ($a2) { [void][DSHWin]::AttachThreadInput($me, $tgT, $false) }
  if ($a1) { [void][DSHWin]::AttachThreadInput($me, $fgT, $false) }
}
Start-Sleep -Milliseconds 900

$now = Get-Title ([DSHWin]::GetForegroundWindow())
Write-Host "激活后前台：「$now」" -ForegroundColor DarkGray
if ($now -ne $target.MainWindowTitle) {
  Write-Host '  警告：前台窗口不是目标窗口，F5 可能发到别处 —— 已中止（不发按键）' -ForegroundColor Yellow
  exit 2
}

Shot $Before
Write-Host "刷新前截图：$Before" -ForegroundColor Green

# --- 发 F5 ---
# 先把鼠标移到窗口中心点一下，确保焦点在页面上（否则 SendKeys 可能不被页面接收）
$rect = New-Object DSHWin+RECT
[void][DSHWin]::GetWindowRect($hwnd, [ref]$rect)
$cx = [int](($rect.Left + $rect.Right) / 2)
$cy = [int](($rect.Top + $rect.Bottom) / 2)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
Start-Sleep -Milliseconds 250

[System.Windows.Forms.SendKeys]::SendWait('{F5}')
Write-Host '已发送 F5' -ForegroundColor Cyan

Start-Sleep -Seconds $WaitSec
Shot $After
Write-Host "刷新后截图：$After  $([math]::Round((Get-Item $After).Length/1KB)) KB" -ForegroundColor Green
exit 0
