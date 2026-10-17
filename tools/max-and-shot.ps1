<#
max-and-shot.ps1 —— 把 DSH 窗口最大化后截图，用于看清底部（输入框下方的插件入口条）。

之前那几张截图看不到 composer 的 dock 区，怀疑是窗口比屏幕高、底部超出屏幕。
SW_MAXIMIZE 之后整窗都在屏幕内，就能看到入口按钮在不在 —— 那是判断 client 半边
有没有加载成功最直接的证据。
#>

param(
  [string]$ProcessName = 'DeepSeek Harness',
  [string]$Out = 'D:\dsh-modeler\tools\_max-shot.png',
  [int]$WaitMs = 1200
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if (-not ('DSHMax' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DSHMax {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

$cands = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $cands) { Write-Host "找不到 $ProcessName 主窗口" -ForegroundColor Red; exit 1 }
$target = $cands | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if (-not $target) { Write-Host '没有带标题的主窗口' -ForegroundColor Red; exit 1 }
$hwnd = $target.MainWindowHandle
Write-Host "目标：PID $($target.Id)「$($target.MainWindowTitle)」" -ForegroundColor Cyan

$rect = New-Object DSHMax+RECT
[void][DSHMax]::GetWindowRect($hwnd, [ref]$rect)
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "窗口矩形：($($rect.Left),$($rect.Top))-($($rect.Right),$($rect.Bottom))  屏幕 $($scr.Width)x$($scr.Height)" -ForegroundColor DarkGray

if ([DSHMax]::IsIconic($hwnd)) { [void][DSHMax]::ShowWindow($hwnd, 9) }
[void][DSHMax]::ShowWindow($hwnd, 3)   # SW_MAXIMIZE

$fg = [DSHMax]::GetForegroundWindow()
$fgT = [DSHMax]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$me = [DSHMax]::GetCurrentThreadId()
$tgT = [DSHMax]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$a1 = $false; $a2 = $false
try {
  if ($fgT -ne $me) { $a1 = [DSHMax]::AttachThreadInput($me, $fgT, $true) }
  if ($tgT -ne $me) { $a2 = [DSHMax]::AttachThreadInput($me, $tgT, $true) }
  [void][DSHMax]::BringWindowToTop($hwnd)
  [void][DSHMax]::SetForegroundWindow($hwnd)
} finally {
  if ($a2) { [void][DSHMax]::AttachThreadInput($me, $tgT, $false) }
  if ($a1) { [void][DSHMax]::AttachThreadInput($me, $fgT, $false) }
}
Start-Sleep -Milliseconds $WaitMs

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$rect2 = New-Object DSHMax+RECT
[void][DSHMax]::GetWindowRect($hwnd, [ref]$rect2)
Write-Host "最大化后：($($rect2.Left),$($rect2.Top))-($($rect2.Right),$($rect2.Bottom))" -ForegroundColor DarkGray
Write-Host "截图：$Out  $([math]::Round((Get-Item $Out).Length/1KB)) KB" -ForegroundColor Green
exit 0
