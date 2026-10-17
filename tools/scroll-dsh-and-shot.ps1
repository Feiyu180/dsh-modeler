<#
scroll-dsh-and-shot.ps1 —— 把 DSH 窗口切到前台、滚到会话底部，然后截图。

为什么需要：DSH 的对话区很长时，输入框与 `conversation.composer.dock` 槽位
（"Ambient entries below the composer card"）会被推到可视区之外，普通截图看不到。
先 Ctrl+End 滚到底再截，才能看到输入框那一带。

只做两件事：抢前台 + 发 Ctrl+End + 截图。不点击、不输入文字。
#>

param(
  [string]$Out = 'D:\dsh-modeler\tools\_dsl-scrolled.png',
  [switch]$Top     # 加 -Top 则滚到顶部（Ctrl+Home）
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('WBWin3' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WBWin3 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@
}

$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Host '找不到 DSH 窗口' -ForegroundColor Red; exit 1 }

$hwnd = $proc.MainWindowHandle
if ([WBWin3]::IsIconic($hwnd)) { [void][WBWin3]::ShowWindow($hwnd, 9) }
[void][WBWin3]::ShowWindow($hwnd, 5)

# 抢前台（与窗口派活脚本同一套 AttachThreadInput 手法）
$fg = [WBWin3]::GetForegroundWindow()
$fgT = [WBWin3]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [WBWin3]::GetCurrentThreadId()
$tgT = [WBWin3]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$a1 = $false; $a2 = $false
try {
  if ($fgT -ne $me) { $a1 = [WBWin3]::AttachThreadInput($me, $fgT, $true) }
  if ($tgT -ne $me) { $a2 = [WBWin3]::AttachThreadInput($me, $tgT, $true) }
  [void][WBWin3]::BringWindowToTop($hwnd)
  [void][WBWin3]::SetForegroundWindow($hwnd)
} finally {
  if ($a2) { [void][WBWin3]::AttachThreadInput($me, $tgT, $false) }
  if ($a1) { [void][WBWin3]::AttachThreadInput($me, $fgT, $false) }
}
Start-Sleep -Milliseconds 900

$fgNow = [WBWin3]::GetForegroundWindow()
if ($fgNow -ne $hwnd) { Write-Host '抢前台失败，为避免误按键盘，已中止' -ForegroundColor Red; exit 1 }
Write-Host 'DSH 已在前台' -ForegroundColor Green

# 滚到会话末尾（或开头）。只发这一个组合键。
if ($Top) {
  [System.Windows.Forms.SendKeys]::SendWait('^{HOME}')
  Write-Host '已发 Ctrl+Home'
} else {
  [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  Write-Host '已发 Ctrl+End'
}
Start-Sleep -Milliseconds 1200

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "截图：$Out  $([math]::Round((Get-Item $Out).Length/1KB)) KB" -ForegroundColor Green
exit 0
