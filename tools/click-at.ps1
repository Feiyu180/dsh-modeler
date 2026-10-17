<#
click-at.ps1 —— DPI 感知地在屏幕**物理坐标**上点一下（用于自我验证 GUI 交互）。

⚠ 坐标系：脚本先把自己设为 per-monitor DPI aware，所以 -X/-Y 是**物理像素**
（这台机器 150% 缩放：物理 2560x1600 / 逻辑 1707x1067）。
如果你按逻辑坐标量，先乘 1.5。

只做单击，不拖动、不输入。
#>

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$SettleMs = 1200,
  [string]$ShotAfter = '',
  [switch]$ActivateDsh
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Clicker {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
'@

try { [void][Clicker]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][Clicker]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($ActivateDsh) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    $h = $proc.MainWindowHandle
    if ([Clicker]::IsIconic($h)) { [void][Clicker]::ShowWindow($h, 9) }
    [void][Clicker]::ShowWindow($h, 5)
    $fg = [Clicker]::GetForegroundWindow()
    $fgT = [Clicker]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $me = [Clicker]::GetCurrentThreadId()
    $tgT = [Clicker]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
    $a1 = $false; $a2 = $false
    try {
      if ($fgT -ne $me) { $a1 = [Clicker]::AttachThreadInput($me, $fgT, $true) }
      if ($tgT -ne $me) { $a2 = [Clicker]::AttachThreadInput($me, $tgT, $true) }
      [void][Clicker]::BringWindowToTop($h)
      [void][Clicker]::SetForegroundWindow($h)
    } finally {
      if ($a2) { [void][Clicker]::AttachThreadInput($me, $tgT, $false) }
      if ($a1) { [void][Clicker]::AttachThreadInput($me, $fgT, $false) }
    }
    Start-Sleep -Milliseconds 800
  }
}

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "物理屏 $($b.Width)x$($b.Height)；点击 ($X,$Y)" -ForegroundColor Cyan
if ($X -lt 0 -or $Y -lt 0 -or $X -ge $b.Width -or $Y -ge $b.Height) {
  Write-Host "坐标越界，已中止" -ForegroundColor Red; exit 1
}

[void][Clicker]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 250
# MOUSEEVENTF_LEFTDOWN = 0x0002, LEFTUP = 0x0004
[Clicker]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Clicker]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Host "已点击" -ForegroundColor Green

Start-Sleep -Milliseconds $SettleMs

if ($ShotAfter -ne '') {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
  $g.Dispose()
  $bmp.Save($ShotAfter, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "点击后截图：$ShotAfter  $([math]::Round((Get-Item $ShotAfter).Length/1KB)) KB" -ForegroundColor Green
}
exit 0
