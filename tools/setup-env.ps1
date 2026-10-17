<#
setup-env.ps1 —— AI 运行环境安装向导（默认**只检查**，-Apply 才动手）

为什么不是"一键全自动"：
  · ComfyUI（约 2.5 GB portable）与 TripoSR 的 Python 3.11 + torch 属于重活，
    在受限网络下失败点多（GitHub 数据通道不稳、pytorch 轮子在国内要镜像），
    自动跑反而更难诊断。这里只自动做**安全且可重入**的步骤：
    目录结构、胶水脚本、TripoSR 源码、权重下载。
  · ComfyUI / Python 环境给的是**确切命令**，你自己在终端跑，进度和报错都看得见。

用法：
  powershell -ExecutionPolicy Bypass -File tools\setup-env.ps1            # 检查
  powershell -ExecutionPolicy Bypass -File tools\setup-env.ps1 -Apply     # 执行安全步骤
  powershell -ExecutionPolicy Bypass -File tools\setup-env.ps1 -Check -Root E:\ai   # 换数据目录

退出码：0 = 全部就绪；1 = 仍有缺项
#>

param(
  [switch]$Check,
  [switch]$Apply,
  [string]$Root = 'D:\dsh-data\dsh-triposr',
  [string]$ComfyRoot = 'D:\dsh-data\ComfyUI_windows_portable',
  [string]$Proxy = 'https://gh-proxy.com/',
  [string]$PipMirror = 'https://pypi.tuna.tsinghua.edu.cn/simple',
  [switch]$SkipWeights
)

$ErrorActionPreference = 'Stop'
if (-not $Apply) { $Check = $true }

$pkg = Split-Path -Parent $PSScriptRoot          # 插件根目录
$scriptDir = Join-Path $pkg 'tools\ai'           # 包内自带的胶水脚本
$triPy = Join-Path $Root 'python311\python.exe'
$triSrc = Join-Path $Root 'TripoSR-main'
$comfyPy = Join-Path $ComfyRoot 'python_embeded\python.exe'
$comfyDir = Join-Path $ComfyRoot 'ComfyUI'
$fastdl = Join-Path $Root 'fastdl.py'

$rows = @()

function Add-Row($id, $label, $ok, $detail, $todo) {
  $script:rows += [pscustomobject]@{ Id = $id; Label = $label; Ok = [bool]$ok; Detail = $detail; Todo = $todo }
}

# ---- 1. 目录 + 胶水脚本 ------------------------------------------------------
$need = @('hunyuan3d-run.py', 'hunyuan3d-mv-run.py', 'zero123-views-cli.py', 'fastdl.py', 'glb-to-json.py', 'patch-triposr.py')
$missingScripts = @($need | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missingScripts.Count -eq 0) {
  Add-Row 'scripts' '胶水脚本' $true "$Root" $null
} else {
  Add-Row 'scripts' '胶水脚本' $false ("缺 " + ($missingScripts -join ', ')) "从 $scriptDir 复制到 $Root"
}

# ---- 2. TripoSR 独立 Python 环境 ---------------------------------------------
if (Test-Path $triPy) {
  Add-Row 'python' 'TripoSR Python 3.11 + torch' $true $triPy $null
} else {
  $dl = $Proxy + 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
  Add-Row 'python' 'TripoSR Python 3.11 + torch' $false "缺 $triPy" @"
下载嵌入式 Python 后装依赖（最容易失败的一步，pytorch 轮子在国内需镜像）：
  curl.exe -L -o python311.zip "$dl"
  解压到 $Root\python311
  再跑 get-pip.py；然后用 $triPy -m pip install torch --index-url $PipMirror（torch 可能需要官方源）
  再装 transformers trimesh pillow numpy
"@
}

# ---- 3. ComfyUI（Hunyuan3D / Zero123 的推理宿主）-------------------------------
if ((Test-Path $comfyPy) -and (Test-Path $comfyDir)) {
  Add-Row 'comfy' 'ComfyUI（推理宿主）' $true $ComfyDir $null
} else {
  $rel = $Proxy + 'https://github.com/comfyanonymous/ComfyUI/releases'
  Add-Row 'comfy' 'ComfyUI（推理宿主）' $false "缺 $comfyDir" @"
脚本要 import comfy / comfy_extras（Hunyuan3D DiT、ShapeVAE、DINOv2、Stable Zero123）。
下载 portable 包（约 2.5 GB）并解压到 $ComfyRoot：
  $rel
注意：ComfyUI 是 GPL-3.0，所以它不进本仓库，只装到你自己的目录。
"@
}

# ---- 4. TripoSR 源码 ---------------------------------------------------------
if (Test-Path $triSrc) {
  Add-Row 'triposr-src' 'TripoSR 源码' $true $triSrc $null
} else {
  $zip = $Proxy + 'https://github.com/VAST-AI-Research/TripoSR/archive/refs/heads/main.zip'
  Add-Row 'triposr-src' 'TripoSR 源码' $false "缺 $triSrc" "curl.exe -L -o triposr.zip `"$zip`" 然后解压到 $Root"
}

# ---- 5. 权重（可以用面板的「一键安装」代替）------------------------------------
$weights = @{
  'dit-fp16.safetensors'       = 4930777530
  'vae-fp16.safetensors'       = 428455666
  'dinov2-giant.safetensors'   = 4546005432
}
$missW = @()
foreach ($k in $weights.Keys) {
  $f = Join-Path $Root "hunyuan-full\$k"
  $sz = 0
  if (Test-Path $f) { $sz = (Get-Item $f).Length }
  if ($sz -ne $weights[$k]) { $missW += $k }
}
if ($SkipWeights) {
  Add-Row 'weights' 'Hunyuan3D 权重（已跳过）' $true '按 -SkipWeights 不检查' $null
} elseif ($missW.Count -eq 0) {
  Add-Row 'weights' 'Hunyuan3D 权重' $true 'dit / vae / dinov2 都在' $null
} else {
  Add-Row 'weights' 'Hunyuan3D 权重' $false ("缺 " + ($missW -join ', ')) "面板「环境与模型」→ 一键安装；或 -Apply 用 fastdl.py 下"
}

# ---- 报告 -------------------------------------------------------------------
Write-Host ''
Write-Host "AI 运行环境检查（数据目录：$Root）" -ForegroundColor White
Write-Host ('─' * 66) -ForegroundColor DarkGray
foreach ($r in $rows) {
  $mark = if ($r.Ok) { 'OK  ' } else { '缺  ' }
  $color = if ($r.Ok) { 'Green' } else { 'Yellow' }
  Write-Host ("  [{0}] {1,-34} {2}" -f $mark, $r.Label, $r.Detail) -ForegroundColor $color
}
Write-Host ('─' * 66) -ForegroundColor DarkGray

$bad = @($rows | Where-Object { -not $_.Ok })
if ($bad.Count -eq 0) {
  Write-Host '全部就绪，可以直接用面板里的 AI 通道了。' -ForegroundColor Green
} else {
  Write-Host "仍有 $($bad.Count) 项缺：" -ForegroundColor Yellow
  foreach ($r in $bad) {
    if ($r.Todo) {
      Write-Host ''
      Write-Host "  ▶ $($r.Label)" -ForegroundColor Cyan
      $r.Todo -split "`n" | ForEach-Object { Write-Host "    $_" }
    }
  }
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '以上只是检查，什么都没改。要执行可自动化的部分（脚本/源码/权重）：' -ForegroundColor Cyan
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Apply" -ForegroundColor Cyan
  if ($bad.Count -gt 0) { exit 1 } else { exit 0 }
}

# ---- Apply：只做安全、可重入的步骤 ---------------------------------------------
Write-Host ''
Write-Host '开始执行（可重复运行，已完成的会跳过）…' -ForegroundColor White

foreach ($d in @($Root, (Join-Path $Root 'hunyuan-full'), (Join-Path $Root 'weights'))) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null; Write-Host "  + 建目录 $d" }
}

if ($missingScripts.Count -gt 0) {
  foreach ($s in $missingScripts) {
    $src = Join-Path $scriptDir $s
    if (-not (Test-Path $src)) { Write-Host "  ! 包里没有 $s，跳过" -ForegroundColor Red; continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $Root $s) -Force
    Write-Host "  + 脚本 $s"
  }
}

if (-not (Test-Path $triSrc)) {
  $zip = $Proxy + 'https://github.com/VAST-AI-Research/TripoSR/archive/refs/heads/main.zip'
  $tmp = Join-Path $Root 'triposr.zip'
  Write-Host "  下载 TripoSR 源码 → $tmp" -ForegroundColor DarkGray
  & curl.exe -L --fail --retry 3 -o $tmp $zip
  if ($LASTEXITCODE -eq 0) {
    Expand-Archive -LiteralPath $tmp -DestinationPath $Root -Force
    $extracted = Join-Path $Root 'TripoSR-main'
    Write-Host "  + TripoSR 源码 → $extracted"
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host '  ! TripoSR 源码下载失败（GitHub 通道不稳，可换 -Proxy 或稍后重试）' -ForegroundColor Red
  }
}

if (-not $SkipWeights -and $missW.Count -gt 0) {
  if (Test-Path $fastdl) {
    Write-Host '  权重请优先用面板「一键安装」（断点续传 + 精确跳过），这里不重复实现。' -ForegroundColor DarkGray
  } else {
    Write-Host '  ! fastdl.py 还没就位，权重请用面板一键安装' -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '完成。重新检查：' -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Check" -ForegroundColor Cyan
exit 0
