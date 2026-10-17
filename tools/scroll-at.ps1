<#
scroll-at.ps1 —— DPI 感知地在指定物理坐标处滚动鼠标滚轮。

用途：dsh-modeler 面板里三张视图卡很高，three.js 视口被顶到面板下方，
需要滚动面板内容才能看到重建结果。

⚠ 坐标是物理像素（脚本先设为 per-monitor DPI aware）。
#>

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$Clicks = 5,          # 正数=向下滚，负数=向上滚
  [int]$Step = 120,          # 每格滚动的 WHEEL_DELTA
  [switch]$ActivateDsh,
  [int]$SettleMs = 1200,
  [string]$ShotAfter = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Scroller {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr extra);
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

try { [void][Scroller]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][Scroller]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($ActivateDsh) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    $h = $proc.MainWindowHandle
    if ([Scroller]::IsIconic($h)) { [void][Scroller]::ShowWindow($h, 9) }
    [void][Scroller]::ShowWindow($h, 5)
    $fg = [Scroller]::GetForegroundWindow()
    $fgT = [Scroller]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $me = [Scroller]::GetCurrentThreadId()
    $tgT = [Scroller]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
    $a1 = $false; $a2 = $false
    try {
      if ($fgT -ne $me) { $a1 = [Scroller]::AttachThreadInput($me, $fgT, $true) }
      if ($tgT -ne $me) { $a2 = [Scroller]::AttachThreadInput($me, $tgT, $true) }
      [void][Scroller]::BringWindowToTop($h)
      [void][Scroller]::SetForegroundWindow($h)
    } finally {
      if ($a2) { [void][Scroller]::AttachThreadInput($me, $tgT, $false) }
      if ($a1) { [void][Scroller]::AttachThreadInput($me, $fgT, $false) }
    }
    Start-Sleep -Milliseconds 600
  }
}

[void][Scroller]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 250
# MOUSEEVENTF_WHEEL = 0x0800；正数向上，负数向下
$delta = if ($Clicks -gt 0) { -$Step } else { $Step }
for ($i = 0; $i -lt [Math]::Abs($Clicks); $i++) {
  [Scroller]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 90
}
Write-Host "已在 ($X,$Y) 滚动 $Clicks 格（每格 $Step）" -ForegroundColor Green

Start-Sleep -Milliseconds $SettleMs

if ($ShotAfter -ne '') {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
  $g.Dispose()
  $bmp.Save($ShotAfter, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "截图：$ShotAfter" -ForegroundColor Green
}
exit 0
