<#
shot-dpi-aware.ps1 —— **DPI 感知**的整屏截图。

为什么必须单独写一个：
  这台机器是 150% 缩放（物理 2560x1600 / 逻辑 1707x1067）。
  DPI-unaware 的 PowerShell 进程里，`Screen.PrimaryScreen.Bounds` 返回**逻辑**尺寸
  1707x1067，而 `Graphics.CopyFromScreen` 又按**物理**坐标去取像素 ——
  结果只截到物理屏左上角的 1707x1067，也就是**整屏的 2/3 见方**。
  窗口的下缘（输入框、侧栏底部）从来没进过画面。

  我因此误判了整整一轮：把"窗口下方那片桌面"当成了"侧栏 footer 区渲染空白"。

修法：先 SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2) 再截图，
这样 Bounds 与 CopyFromScreen 的坐标系就一致了（都按物理像素）。
#>

param(
  [string]$Out = 'D:\dsh-modeler\tools\_shot-full.png',
  [string]$TitleMatch = 'DeepSeek',
  [switch]$ActivateFirst
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiFix {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
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

# --- 关键：先把自己变成 per-monitor DPI aware（-4 = PER_MONITOR_AWARE_V2）---
try { [void][DpiFix]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][DpiFix]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($ActivateFirst) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    $h = $proc.MainWindowHandle
    if ([DpiFix]::IsIconic($h)) { [void][DpiFix]::ShowWindow($h, 9) }
    [void][DpiFix]::ShowWindow($h, 5)
    $fg = [DpiFix]::GetForegroundWindow()
    $fgT = [DpiFix]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $me = [DpiFix]::GetCurrentThreadId()
    $tgT = [DpiFix]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
    $a1 = $false; $a2 = $false
    try {
      if ($fgT -ne $me) { $a1 = [DpiFix]::AttachThreadInput($me, $fgT, $true) }
      if ($tgT -ne $me) { $a2 = [DpiFix]::AttachThreadInput($me, $tgT, $true) }
      [void][DpiFix]::BringWindowToTop($h)
      [void][DpiFix]::SetForegroundWindow($h)
    } finally {
      if ($a2) { [void][DpiFix]::AttachThreadInput($me, $tgT, $false) }
      if ($a1) { [void][DpiFix]::AttachThreadInput($me, $fgT, $false) }
    }
    Start-Sleep -Milliseconds 900
  }
}

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "DPI-aware 后的 Bounds: $($b.Width) x $($b.Height)" -ForegroundColor Cyan

$bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "截图：$Out  $([math]::Round((Get-Item $Out).Length/1KB)) KB" -ForegroundColor Green
exit 0
