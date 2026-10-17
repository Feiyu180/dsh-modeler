<#
paste-images-to-dsh.ps1 —— 把若干张本机图片依次粘贴进 dsh-modeler 面板。

原理：面板在 window 上监听 paste，遇到 image/* 就自动填进**第一个空槽**
（`VIEW_META.find(m => !vs[m.key])`，顺序 front → side → top）。
所以只要按 front/side/top 的顺序依次把图片放进剪贴板再 Ctrl+V 即可。

流程（对每张图）：设剪贴板 → 确保 DSH 在前台 → 点一下面板标题栏（把焦点从输入框挪开）
→ Ctrl+V → 等一会儿。

⚠ DPI：脚本先把自己设为 per-monitor DPI aware，所以 -PanelTitleX/-PanelTitleY 是**物理像素**。
#>

param(
  [Parameter(Mandatory = $true)][string[]]$Images,
  [int]$PanelTitleX = 620,
  [int]$PanelTitleY = 234,
  [int]$PerImageWaitMs = 2500,
  [string]$ShotAfter = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Paster {
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

try { [void][Paster]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][Paster]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Focus-Dsh {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { throw '找不到 DSH 窗口' }
  $h = $proc.MainWindowHandle
  if ([Paster]::IsIconic($h)) { [void][Paster]::ShowWindow($h, 9) }
  [void][Paster]::ShowWindow($h, 5)
  $fg = [Paster]::GetForegroundWindow()
  $fgT = [Paster]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $me = [Paster]::GetCurrentThreadId()
  $tgT = [Paster]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
  $a1 = $false; $a2 = $false
  try {
    if ($fgT -ne $me) { $a1 = [Paster]::AttachThreadInput($me, $fgT, $true) }
    if ($tgT -ne $me) { $a2 = [Paster]::AttachThreadInput($me, $tgT, $true) }
    [void][Paster]::BringWindowToTop($h)
    [void][Paster]::SetForegroundWindow($h)
  } finally {
    if ($a2) { [void][Paster]::AttachThreadInput($me, $tgT, $false) }
    if ($a1) { [void][Paster]::AttachThreadInput($me, $fgT, $false) }
  }
  Start-Sleep -Milliseconds 700
  if ([Paster]::GetForegroundWindow() -ne $h) { throw 'DSH 没抢到前台，中止（避免按键落到别的窗口）' }
}

$i = 0
foreach ($p in $Images) {
  $i++
  if (-not (Test-Path $p)) { throw "找不到图片：$p" }

  # 剪贴板放位图（SetDataObject 让数据在 PowerShell 退出后依然有效）
  $img = [System.Drawing.Image]::FromFile($p)
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $img
  [System.Windows.Forms.Clipboard]::SetDataObject($bmp, $true)
  $img.Dispose(); $bmp.Dispose()
  Write-Host "[$i/$($Images.Count)] 剪贴板 ← $(Split-Path $p -Leaf)" -ForegroundColor Cyan

  Focus-Dsh

  # 先点面板标题栏：把焦点从输入框挪开，避免 DSH 的输入框把图片当附件吃掉
  [void][Paster]::SetCursorPos($PanelTitleX, $PanelTitleY)
  Start-Sleep -Milliseconds 200
  [Paster]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Paster]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300

  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Write-Host "    已发 Ctrl+V，等 $PerImageWaitMs ms" -ForegroundColor DarkGray
  Start-Sleep -Milliseconds $PerImageWaitMs
}

if ($ShotAfter -ne '') {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp2 = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp2)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
  $g.Dispose()
  $bmp2.Save($ShotAfter, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp2.Dispose()
  Write-Host "截图：$ShotAfter  $([math]::Round((Get-Item $ShotAfter).Length/1KB)) KB" -ForegroundColor Green
}
exit 0
