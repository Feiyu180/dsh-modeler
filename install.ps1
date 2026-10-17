# install.ps1 —— 把 dsh-modeler 装进本机 DSH profile（幂等，可重复跑）
#
# 做三件事：
#   1. 校验插件自身完整性（package.json / client bundle / host 入口都能解析）
#   2. 把 "dsh-modeler": "link:D:\dsh-modeler" 写进 profile 的 package.json，
#      并把 dsh-modeler 追加进 dsh.profile.bundles（两处缺一不可）
#   3. 在 profile 目录跑 pnpm install，让 node_modules 里出现 dsh-modeler 软链
#
# **它故意不碰 profile 的 cordis.patch.yml** —— 详见 Step 3/3 处的长注释。
# 那个文件是"用户 patch 层"，装着用户的主题/默认模型/插件禁用等设置，且会被
# DSH 的 config-editor 整体重写；往里写任何东西都不安全，插件也不需要通过它生效
# （插件包自己的 dsh.bundle.patch 就够了）。
#
# 每步都会先做 check：已经装过就跳过，不重复写；改动前一律先备份。

param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$PluginDir = 'D:\dsh-modeler',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# --- 工具路径（本机 PATH 里没有 node/pnpm，必须用绝对路径）---
$NODE_DIR = 'C:\Users\YOURNAME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$NODE = Join-Path $NODE_DIR 'node.exe'
$PNPM = 'C:\Users\YOURNAME\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
if (-not (Test-Path $NODE)) { $NODE = 'C:\Users\YOURNAME\<node-v22>\node.exe' }
if (-not (Test-Path $NODE)) { throw "找不到 node.exe" }
if (-not (Test-Path $PNPM)) { throw "找不到 pnpm.mjs：$PNPM" }
if (-not (Test-Path $ProfileDir)) { throw "profile 目录不存在：$ProfileDir" }

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Skip($msg) { Write-Host "    --  $msg" -ForegroundColor DarkGray }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

$pkgJsonPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$pluginPkgPath = Join-Path $PluginDir 'package.json'

# ---------------------------------------------------------------------------
if ($Uninstall) {
  Step '1/2' "从 profile 移除 dsh-modeler"
  $pj = Get-Content $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  if ($pj.dependencies.'dsh-modeler') {
    $pj.dependencies.PSObject.Properties.Remove('dsh-modeler')
    $changed = $true
    Ok '已从 dependencies 移除'
  } else { Skip 'dependencies 里本来就没有' }
  if ($pj.dsh -and $pj.dsh.profile -and (@($pj.dsh.profile.bundles) -contains 'dsh-modeler')) {
    $pj.dsh.profile.bundles = @($pj.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-modeler' }
    $changed = $true
    Ok '已从 dsh.profile.bundles 移除'
  } else { Skip 'dsh.profile.bundles 里本来就没有' }
  if ($changed) {
    Copy-Item $pkgJsonPath "$pkgJsonPath.bak-modeler-uninstall" -Force
    $pj | ConvertTo-Json -Depth 20 | Set-Content $pkgJsonPath -Encoding UTF8
  }

  # 故意不碰 profile 的 cordis.patch.yml —— 那是 DSH/用户的文件（见下面 Step 3/3 的说明）。
  # 第一版安装脚本曾往里写过 insert 行，卸载时也来删；现在两端都不动它。
  Skip '不动 profile 的 cordis.patch.yml（那是 DSH 与用户的文件）'

  Step '2/2' 'pnpm install'
  Push-Location $ProfileDir
  try { & $NODE $PNPM install --config.confirmModulesPurge=false 2>&1 | Select-Object -Last 8 }
  finally { Pop-Location }
  Write-Host "`n完成。重启 DSH（或刷新页面）后生效。" -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------------------
Step '1/3' '校验插件完整性'

if (-not (Test-Path $pluginPkgPath)) { throw "插件 package.json 不存在：$pluginPkgPath" }
$pkg = Get-Content $pluginPkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
Ok "包名 $($pkg.name)  v$($pkg.version)"

$clientBundle = Join-Path $PluginDir 'lib\client.js'
if (-not (Test-Path $clientBundle)) {
  throw "客户端 bundle 不存在：$clientBundle`n先跑构建：`n  `"$NODE`" `"$PluginDir\build\build.mjs`""
}
$bundleKb = [math]::Round((Get-Item $clientBundle).Length / 1KB, 1)
$head = (Get-Content $clientBundle -Raw -Encoding UTF8).Substring(0, 80)
if ($head -notmatch '__ModuleLoader__') { throw "client.js 不是 DSH 客户端 bundle（缺少 __ModuleLoader__ 头）" }
Ok "客户端 bundle $bundleKb KB，头部协议正确"

$hostEntry = Join-Path $PluginDir 'src\host\index.js'
if (-not (Test-Path $hostEntry)) { throw "host 入口不存在：$hostEntry" }
Ok 'host 入口存在'

# 顺手验一下 host 能被 node 解析（不是 import，只做语法检查）
& $NODE --check $hostEntry 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "host 入口有语法错误：$hostEntry" }
Ok 'host 入口语法正确'

# ---------------------------------------------------------------------------
Step '2/3' '写入 profile 的 package.json'

$pjRaw = Get-Content $pkgJsonPath -Raw -Encoding UTF8
$pj = $pjRaw | ConvertFrom-Json
if (-not $pj.dependencies) { $pj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
$target = "link:$PluginDir"
$current = $pj.dependencies.'dsh-modeler'
$bundles = @()
if ($pj.dsh -and $pj.dsh.profile -and $pj.dsh.profile.bundles) { $bundles = @($pj.dsh.profile.bundles) }
$hasBundle = $bundles -contains 'dsh-modeler'

if ($current -eq $target -and $hasBundle) {
  Skip "dependencies 与 bundles 都已包含 dsh-modeler"
} else {
  Copy-Item $pkgJsonPath "$pkgJsonPath.bak-modeler" -Force
  if ($pj.dependencies.PSObject.Properties.Name -contains 'dsh-modeler') {
    $pj.dependencies.'dsh-modeler' = $target
  } else {
    $pj.dependencies | Add-Member -NotePropertyName 'dsh-modeler' -NotePropertyValue $target
  }
  # 关键：必须同时登记到 dsh.profile.bundles。
  # DSH 只把 bundles 里的包纳入启动组合；包不在 bundles 里就完全不加载
  # （而且不报错，表现为"侧栏里没有那个按钮"）。
  if (-not $hasBundle) {
    $pj.dsh.profile.bundles = @($bundles) + 'dsh-modeler'
  }
  $pj | ConvertTo-Json -Depth 20 | Set-Content $pkgJsonPath -Encoding UTF8
  Ok "已写入 dependencies=$target，并把 dsh-modeler 加入 dsh.profile.bundles（备份 $pkgJsonPath.bak-modeler）"
}

# ---------------------------------------------------------------------------
Step '3/3' '在 profile 里 pnpm install（建立 link）'
#
# ⚠ 这里**故意不再碰 profile 的 cordis.patch.yml**。
#
# 踩过的坑（2026-10-15）：第一版 install.ps1 会往 profile 的 cordis.patch.yml
# 追加一段 `- insert: [{id: modeler, name: dsh-modeler}]`，以为插件靠它生效。
# 两处都错：
#   1. **多余**：插件包自己声明了 `dsh.bundle.patch`（本仓库的 cordis.patch.yml），
#      DSH 加载该 bundle 时会自动应用它 —— 不需要写进 profile 的用户 patch 层。
#   2. **危险**：profile 的 cordis.patch.yml 是"用户 patch 层"，里面装着用户的
#      主题偏好、默认模型、插件禁用等设置，并且会被 DSH 的 config-editor 整体重写。
#      往里追加内容既可能被覆盖，也可能干扰它的重写（那次重写后用户的
#      ui-theme / modlens / agent-default-model 三条就没了）。
# 结论：这个文件**只归 DSH 和用户管**，安装脚本永远不碰。

Push-Location $ProfileDir
try {
  & $NODE $PNPM install --config.confirmModulesPurge=false 2>&1 | Select-Object -Last 12
  $code = $LASTEXITCODE
} finally { Pop-Location }

$linkPath = Join-Path $ProfileDir 'node_modules\dsh-modeler'
if (Test-Path $linkPath) {
  Ok "node_modules\dsh-modeler 已就位（$((Get-Item $linkPath).LinkType)）"
} else {
  Warn "pnpm install 退出码 $code，且 node_modules\dsh-modeler 不存在"
  Warn "请手工执行：cd $ProfileDir; & `"$NODE`" `"$PNPM`" install"
}

Write-Host @"

────────────────────────────────────────────────────────
装好了。生效方式（二选一）：

  A. 刷新页面        —— 浏览器 F5，client bundle 会重新拉取
                       （host 半边的工具需要 B）
  B. 重启 DSH 桌面端 —— 完全生效，host 的 modeler_save / modeler_load /
                       modeler_views 三个工具会出现在工具列表里

验证：左侧栏底部「设置」上方应出现「◧ 三视图建模」按钮，点开就是建模面板。

卸载：& "$PSCommandPath" -Uninstall
────────────────────────────────────────────────────────
"@ -ForegroundColor Green
