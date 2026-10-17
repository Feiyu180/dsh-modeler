<#
activate-and-shot.ps1 —— 把指定窗口切到前台并截图。

用途：验证 DSH 界面上的插件入口按钮是否真的出现（之前几次截图都被别的窗口挡住）。

参数：
  -ProcessName  进程名（默认 DeepSeek Harness 的 exe 名）
  -TitleMatch   窗口标题需包含的子串（可选，用于区分多窗口）
  -Out          截图输出路径

退出码：0=成功激活并截图；1=找不到窗口或激活失败
#>

param(
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$TitleMatch = '',
  [string]$Out = 'D:\dsh-modeler\tools\_dsl-front.png',
  [int]$WaitMs = 900
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('WBWin2' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WBWin2 {
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
  [void][WBWin2]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}

# --- 找窗口 ---
$cands = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $cands) {
  # 进程名可能带 .exe 或不同大小写，退化为模糊匹配
  $cands = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like "*$($ProcessName -replace ' ','*')*" }
}
if (-not $cands) { Write-Host "找不到进程「$ProcessName」的主窗口" -ForegroundColor Red; exit 1 }

$target = $null
foreach ($c in $cands) {
  $t = $c.MainWindowTitle
  if ($t -and ($TitleMatch -eq '' -or $t -like "*$TitleMatch*")) { $target = $c; break }
}
if (-not $target) { $target = $cands | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 }
if (-not $target) { Write-Host "找到了进程但没有带标题的主窗口" -ForegroundColor Red; exit 1 }

$hwnd = $target.MainWindowHandle
Write-Host "目标：PID $($target.Id)  标题「$($target.MainWindowTitle)」" -ForegroundColor Cyan

# --- 恢复 + 抢前台 ---
if ([WBWin2]::IsIconic($hwnd)) { [void][WBWin2]::ShowWindow($hwnd, 9) }   # SW_RESTORE
[void][WBWin2]::ShowWindow($hwnd, 5)                                       # SW_SHOW

$fg = [WBWin2]::GetForegroundWindow()
$fgT = [WBWin2]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [WBWin2]::GetCurrentThreadId()
$tgT = [WBWin2]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$a1 = $false; $a2 = $false
try {
  if ($fgT -ne $me) { $a1 = [WBWin2]::AttachThreadInput($me, $fgT, $true) }
  if ($tgT -ne $me) { $a2 = [WBWin2]::AttachThreadInput($me, $tgT, $true) }
  [void][WBWin2]::BringWindowToTop($hwnd)
  [void][WBWin2]::SetForegroundWindow($hwnd)
} finally {
  if ($a2) { [void][WBWin2]::AttachThreadInput($me, $tgT, $false) }
  if ($a1) { [void][WBWin2]::AttachThreadInput($me, $fgT, $false) }
}
Start-Sleep -Milliseconds $WaitMs

$nowTitle = Get-Title ([WBWin2]::GetForegroundWindow())
Write-Host "激活后前台：「$nowTitle」" -ForegroundColor DarkGray
if ($nowTitle -notlike "*$TitleMatch*" -and $TitleMatch -ne '') {
  Write-Host "  警告：前台标题不含「$TitleMatch」" -ForegroundColor Yellow
}

# --- 截图（整屏；窗口位置随用户拖拽而变，整屏最稳）---
Start-Sleep -Milliseconds 300
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$rect = New-Object WBWin2+RECT
[void][WBWin2]::GetWindowRect($hwnd, [ref]$rect)
Write-Host "窗口矩形：($($rect.Left),$($rect.Top)) - ($($rect.Right),$($rect.Bottom))" -ForegroundColor DarkGray
Write-Host "截图：$Out  $([math]::Round((Get-Item $Out).Length/1KB)) KB" -ForegroundColor Green
exit 0
