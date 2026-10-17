param([string]$ProcessName = 'DeepSeek Harness')

# Send one ESC to the DSH window (pure ASCII on purpose: PowerShell 5.1 reads
# .ps1 as GBK unless there is a BOM, so non-ASCII here would break parsing).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class EFg { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if ($p) {
  [void][EFg]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Milliseconds 800
  Write-Host "foreground set to PID $($p.Id)"
} else {
  Write-Host "process not found; sending anyway"
}

[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Write-Host 'ESC sent'
