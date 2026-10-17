<#
drag-at.ps1 —— DPI 感知的鼠标拖拽（用于验证 three.js 视口的 OrbitControls 旋转）。

只做一次"按下 → 分几步移动 → 松开"，不点按其他东西。
坐标是**物理像素**。
#>

param(
  [Parameter(Mandatory = $true)][int]$FromX,
  [Parameter(Mandatory = $true)][int]$FromY,
  [Parameter(Mandatory = $true)][int]$ToX,
  [Parameter(Mandatory = $true)][int]$ToY,
  [int]$Steps = 12,
  [switch]$ActivateDsh,
  [int]$SettleMs = 1200,
  [string]$ShotAfter = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Dragger {
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

try { [void][Dragger]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][Dragger]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($ActivateDsh) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    $h = $proc.MainWindowHandle
    if ([Dragger]::IsIconic($h)) { [void][Dragger]::ShowWindow($h, 9) }
    [void][Dragger]::ShowWindow($h, 5)
    $fg = [Dragger]::GetForegroundWindow()
    $fgT = [Dragger]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $me = [Dragger]::GetCurrentThreadId()
    $tgT = [Dragger]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
    $a1 = $false; $a2 = $false
    try {
      if ($fgT -ne $me) { $a1 = [Dragger]::AttachThreadInput($me, $fgT, $true) }
      if ($tgT -ne $me) { $a2 = [Dragger]::AttachThreadInput($me, $tgT, $true) }
      [void][Dragger]::BringWindowToTop($h)
      [void][Dragger]::SetForegroundWindow($h)
    } finally {
      if ($a2) { [void][Dragger]::AttachThreadInput($me, $tgT, $false) }
      if ($a1) { [void][Dragger]::AttachThreadInput($me, $fgT, $false) }
    }
    Start-Sleep -Milliseconds 600
  }
}

[void][Dragger]::SetCursorPos($FromX, $FromY)
Start-Sleep -Milliseconds 250
[Dragger]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 120
for ($i = 1; $i -le $Steps; $i++) {
  $x = [int]($FromX + ($ToX - $FromX) * $i / $Steps)
  $y = [int]($FromY + ($ToY - $FromY) * $i / $Steps)
  [void][Dragger]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 35
}
Start-Sleep -Milliseconds 120
[Dragger]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
Write-Host "已拖拽 ($FromX,$FromY) → ($ToX,$ToY)" -ForegroundColor Green

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
