param(
  [string]$Dir = "$env:APPDATA\@deepseek-ai\dsh-desktop\Local Storage\leveldb"
)

# Parse the plugin's diagnostic breadcrumbs out of Chromium's localStorage and
# report the NEWEST record per tag, with the raw epoch turned into local time.
# (Earlier I printed the first matches, which were always the oldest lines and
# sent me chasing a stale failure.)

if (-not (Test-Path $Dir)) { Write-Host "no such dir: $Dir"; exit 1 }

$re = [regex]'([a-zA-Z][a-zA-Z0-9-]*)\|([^|]{0,200})\|(\d{13})'
$all = New-Object System.Collections.ArrayList

Get-ChildItem $Dir -File -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $fs = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $len = [int]$fs.Length
    if ($len -le 0 -or $len -gt 30MB) { $fs.Close(); return }
    $buf = New-Object byte[] $len
    [void]$fs.Read($buf, 0, $len)
    $fs.Close()
    $text = [System.Text.Encoding]::UTF8.GetString($buf)
    foreach ($m in $re.Matches($text)) {
      $ts = [int64]$m.Groups[3].Value
      # sanity: only accept plausible 2026-ish stamps
      if ($ts -lt 1700000000000) { continue }
      [void]$all.Add([pscustomobject]@{
        Tag   = $m.Groups[1].Value
        Extra = $m.Groups[2].Value
        Ts    = $ts
        Time  = ([datetime]'1970-01-01').AddMilliseconds($ts).ToLocalTime()
      })
    }
  } catch { }
}

# dedupe identical records, then show newest per tag
$uniq = $all | Sort-Object Ts -Unique
Write-Host "records: $($uniq.Count)  (now = $(Get-Date -Format 'HH:mm:ss'))"
Write-Host ''
$uniq | Group-Object Tag | ForEach-Object {
  $newest = $_.Group | Sort-Object Ts -Descending | Select-Object -First 1
  "  {0,-16} newest {1}  x{2}   {3}" -f $newest.Tag, $newest.Time.ToString('HH:mm:ss'), $_.Count, $newest.Extra
}
Write-Host ''
Write-Host '--- 最近 12 条（按时间）---'
$uniq | Sort-Object Ts -Descending | Select-Object -First 12 | ForEach-Object {
  "  {0}  {1,-14} {2}" -f $_.Time.ToString('HH:mm:ss'), $_.Tag, $_.Extra
}
