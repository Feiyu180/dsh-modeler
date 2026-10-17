param(
  [string]$Dir = "$env:APPDATA\@deepseek-ai\dsh-desktop\Local Storage\leveldb",
  [string]$Needle = 'dsh-modeler-diag'
)

# Read the plugin's own diagnostic breadcrumbs out of Chromium's localStorage.
#
# Chromium stores localStorage in LevelDB; the files are locked by the running
# browser, so we open them with FileShare.ReadWrite instead of letting .NET take
# an exclusive lock. Values may be encoded as UTF-8 or UTF-16, so both are probed.

if (-not (Test-Path $Dir)) { Write-Host "no such dir: $Dir"; exit 1 }

$hits = New-Object System.Collections.ArrayList

Get-ChildItem $Dir -File -ErrorAction SilentlyContinue | ForEach-Object {
  $path = $_.FullName
  try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $len = [int]$fs.Length
    if ($len -le 0 -or $len -gt 20MB) { $fs.Close(); return }
    $buf = New-Object byte[] $len
    [void]$fs.Read($buf, 0, $len)
    $fs.Close()

    foreach ($enc in @('UTF8', 'Unicode')) {
      $text = if ($enc -eq 'UTF8') { [System.Text.Encoding]::UTF8.GetString($buf) } else { [System.Text.Encoding]::Unicode.GetString($buf) }
      foreach ($m in [regex]::Matches($text, [regex]::Escape($Needle) + '[\x20-\x7e]{0,160}')) {
        [void]$hits.Add([pscustomobject]@{ File = $_.Name; Enc = $enc; Text = $m.Value })
      }
    }
  } catch {
    # locked / unreadable: skip
  }
}

Write-Host "matches: $($hits.Count)"
if ($hits.Count -gt 0) {
  $hits | Select-Object -Last 16 | ForEach-Object { "  [{0}/{1}] {2}" -f $_.File, $_.Enc, $_.Text }
}
