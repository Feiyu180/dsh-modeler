param([string]$ProcessName = 'DeepSeek Harness')

# Post F5 straight into the Chromium render widget of the DSH window.
#
# Why PostMessage instead of SendKeys: the machine is locked (LogonUI owns the
# input queue), so SendKeys / SendInput cannot reach the app. PostMessage drops a
# message directly into the target window's queue and does not require the window
# to be foreground or the session to be unlocked.
#
# Chromium does look at lParam for key messages, so we fill in repeat count and
# scan code (VK_F5 scancode = 0x3F) instead of passing 0.

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KMsg {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
'@

$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$VK_F5 = 0x74

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Host 'DSH main window not found'; exit 1 }

$top = $p.MainWindowHandle
Write-Host "top window handle: $top"

# Collect every child window whose class is the Chromium render widget.
$found = New-Object System.Collections.ArrayList
$cb = [KMsg+EnumProc] {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][KMsg]::GetClassName($h, $sb, 256)
  $cls = $sb.ToString()
  if ($cls -like '*RenderWidget*' -or $cls -like '*Chrome_WidgetWin*' -or $cls -like '*Intermediate*') {
    [void]$found.Add([pscustomobject]@{ Handle = $h; Class = $cls })
  }
  return $true
}
[void][KMsg]::EnumChildWindows($top, $cb, [IntPtr]::Zero)

Write-Host "candidate child windows: $($found.Count)"
foreach ($f in $found) { Write-Host ("  {0}  {1}" -f $f.Handle, $f.Class) }

# F5: repeat=1, scancode 0x3F  ->  down: 0x003F0001, up: 0xC03F0001
$down = [IntPtr]0x003F0001
$up = [IntPtr]([int64]0xC03F0001)

$targets = @($top)
foreach ($f in $found) { $targets += $f.Handle }

$sent = 0
foreach ($t in $targets) {
  if (-not [KMsg]::IsWindow($t)) { continue }
  [void][KMsg]::PostMessage($t, $WM_KEYDOWN, [IntPtr]$VK_F5, $down)
  Start-Sleep -Milliseconds 40
  [void][KMsg]::PostMessage($t, $WM_KEYUP, [IntPtr]$VK_F5, $up)
  Write-Host "posted F5 -> $t"
  $sent++
  Start-Sleep -Milliseconds 120
}
Write-Host "done, posted to $sent window(s)"
