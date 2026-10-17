<#
type-at.ps1 —— DPI 感知地：可选点击某坐标 → 输入一段文本 → 可选回车。

用途：驱动 Windows"打开文件"对话框 —— 点一下"文件名(N):"输入框，把完整路径敲进去，
回车。比拖拽/剪贴板都可靠，因为它不依赖焦点是否落在网页元素上。

⚠ 坐标是**物理像素**（脚本先把自己设为 per-monitor DPI aware）。
⚠ SendKeys 只对 ASCII 安全；本脚本输入的路径都是 ASCII。
#>

param(
  [Parameter(Mandatory = $true)][string]$Text,
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [switch]$Enter,
  [switch]$ActivateDsh,
  [switch]$ActivateDialog,
  [int]$AfterClickMs = 350,
  [int]$AfterTypeMs = 400,
  [int]$AfterEnterMs = 1500,
  [string]$ShotAfter = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Typer {
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
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string title);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
}
'@

try { [void][Typer]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][Typer]::SetProcessDPIAware() } catch { }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Focus-Window([IntPtr]$h) {
  if ([Typer]::IsIconic($h)) { [void][Typer]::ShowWindow($h, 9) }
  [void][Typer]::ShowWindow($h, 5)
  $fg = [Typer]::GetForegroundWindow()
  $fgT = [Typer]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $me = [Typer]::GetCurrentThreadId()
  $tgT = [Typer]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
  $a1 = $false; $a2 = $false
  try {
    if ($fgT -ne $me) { $a1 = [Typer]::AttachThreadInput($me, $fgT, $true) }
    if ($tgT -ne $me) { $a2 = [Typer]::AttachThreadInput($me, $tgT, $true) }
    [void][Typer]::BringWindowToTop($h)
    [void][Typer]::SetForegroundWindow($h)
  } finally {
    if ($a2) { [void][Typer]::AttachThreadInput($me, $tgT, $false) }
    if ($a1) { [void][Typer]::AttachThreadInput($me, $fgT, $false) }
  }
}

if ($ActivateDialog) {
  # 找"打开"对话框（窗口类 #32770，标题 "打开"）
  $dlg = [Typer]::FindWindow('#32770', '打开')
  if ($dlg -eq [IntPtr]::Zero) { $dlg = [Typer]::FindWindow('#32770', $null) }
  if ($dlg -eq [IntPtr]::Zero) { Write-Host '没找到文件对话框（#32770），中止' -ForegroundColor Red; exit 1 }
  Focus-Window $dlg
  Write-Host '已激活文件对话框' -ForegroundColor Green
  Start-Sleep -Milliseconds 500
} elseif ($ActivateDsh) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { Write-Host '没找到 DSH 窗口' -ForegroundColor Red; exit 1 }
  Focus-Window $proc.MainWindowHandle
  Write-Host '已激活 DSH' -ForegroundColor Green
  Start-Sleep -Milliseconds 500
}

if ($ClickX -ge 0 -and $ClickY -ge 0) {
  [void][Typer]::SetCursorPos($ClickX, $ClickY)
  Start-Sleep -Milliseconds 180
  [Typer]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [Typer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "已点击 ($ClickX,$ClickY)" -ForegroundColor DarkGray
  Start-Sleep -Milliseconds $AfterClickMs
}

# 先全选清空，再输入（避免与已有内容拼接）
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait($Text)
Write-Host "已输入：$Text" -ForegroundColor Cyan
Start-Sleep -Milliseconds $AfterTypeMs

if ($Enter) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Host '已回车' -ForegroundColor Green
  Start-Sleep -Milliseconds $AfterEnterMs
}

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
