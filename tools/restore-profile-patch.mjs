/**
 * restore-profile-patch.mjs —— 把 profile 的 cordis.patch.yml 里**缺失的条目**补回来。
 *
 * 背景（我犯的错，写在这里免得后人重犯）：
 *   dsh-modeler 的第一版 install.ps1 会往 profile 的 cordis.patch.yml 追加一段
 *   `- insert: [{id: modeler, name: dsh-modeler}]`。这是错的：
 *     · 多余 —— 插件包自己声明了 dsh.bundle.patch，DSH 加载该 bundle 时会自动应用；
 *     · 危险 —— 那个文件是"用户 patch 层"，装着主题偏好、默认模型、插件禁用等设置，
 *       而且会被 DSH 的 config-editor **整体重写**。
 *   结果：2026-10-15 22:59 那次重写后，用户的 ui-theme / modlens / agent-default-model
 *   三条没了（DSH 只写回它当时管理的行）。幸好追加前做了备份。
 *
 * 本脚本的作用：把"备份里有、当前文件里没有"的条目**追加**回去。
 *   · 只追加缺失的 id，**绝不覆盖**当前文件已有的条目
 *     （那些是 DSH/用户的最新意图，比如 ui-settings: enabled: false）
 *   · 幂等：再跑一次会报"没有缺失"
 *   · 默认 DryRun，加 -Apply 才真正写；写前先备份当前文件
 *
 * 用法：
 *   node tools/restore-profile-patch.mjs              # 只看会补什么
 *   node tools/restore-profile-patch.mjs --apply      # 真正写入
 *   node tools/restore-profile-patch.mjs --from <路径> # 指定别的备份来源
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const TARGET = path.join(PROFILE, 'cordis.patch.yml')

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const fromIdx = argv.indexOf('--from')
const SOURCE = fromIdx >= 0 && argv[fromIdx + 1]
  ? argv[fromIdx + 1]
  : path.join(PROFILE, 'cordis.patch.yml.bak-modeler')

if (!fs.existsSync(TARGET)) {
  console.error('找不到目标文件：' + TARGET)
  process.exit(2)
}
if (!fs.existsSync(SOURCE)) {
  console.error('找不到备份来源：' + SOURCE)
  console.error('（用 --from <路径> 指定。profile 目录下的 *.bak-* 都可以试）')
  process.exit(2)
}

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')

/**
 * 把 YAML 文本按"顶层 `- id: xxx` / `- insert:` / `- disabled:` 起头"切成块。
 * 只做这一种切分，不做通用 YAML 解析 —— 因为这个文件的结构就是这么简单，
 * 而通用解析会引入依赖、还可能重排键顺序（那反而会破坏用户的文件）。
 */
function splitBlocks(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let head = []
  let cur = null
  for (const line of lines) {
    const isTop = /^- /.test(line)
    if (isTop) {
      if (cur) blocks.push(cur)
      cur = { lines: [line], id: idOf(line) }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      head.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return { head, blocks }
}

function idOf(line) {
  let m = /^-\s+id:\s*(.+?)\s*$/.exec(line)
  if (m) return m[1].replace(/^["']|["']$/g, '')
  m = /^-\s+insert:\s*$/.exec(line)
  if (m) return '(insert)'
  m = /^-\s+disabled:\s*$/.exec(line)
  if (m) return '(disabled)'
  return null
}

const targetText = read(TARGET)
const sourceText = read(SOURCE)
const t = splitBlocks(targetText)
const s = splitBlocks(sourceText)

const haveIds = new Set(t.blocks.map((b) => b.id).filter(Boolean))
const missing = s.blocks.filter((b) => {
  if (!b.id) return false
  if (b.id === '(insert)' || b.id === '(disabled)') return false // 这两类无法按 id 比对，跳过
  return !haveIds.has(b.id)
})

console.log('目标: ' + TARGET)
console.log('来源: ' + SOURCE)
console.log('')
console.log('当前文件条目 (' + t.blocks.length + '): ' + t.blocks.map((b) => b.id).join(', '))
console.log('来源文件条目 (' + s.blocks.length + '): ' + s.blocks.map((b) => b.id).join(', '))
console.log('')

if (!missing.length) {
  console.log('没有缺失的条目 —— 什么都不用做。')
  process.exit(0)
}

console.log('将补回 ' + missing.length + ' 条（只追加，不覆盖已有条目）:')
for (const b of missing) {
  console.log('  ── ' + b.id + ' ──')
  for (const l of b.lines) if (l.trim()) console.log('     ' + l)
}
console.log('')

if (!apply) {
  console.log('（这是 DryRun。确认无误后加 --apply 真正写入。）')
  process.exit(0)
}

const stamp = Date.now()
const backup = TARGET + '.bak-restore-' + stamp
fs.copyFileSync(TARGET, backup)
console.log('已备份当前文件 → ' + backup)

// 追加：保留当前文件全部内容，末尾接上缺失块
let out = targetText.replace(/\s*$/, '')
out += '\n\n# 以下条目由 tools/restore-profile-patch.mjs 从备份补回（' +
  new Date().toISOString() + '）\n'
for (const b of missing) out += b.lines.join('\n').replace(/\s*$/, '') + '\n'
fs.writeFileSync(TARGET, out, 'utf8')

console.log('已写入 ' + TARGET + '（' + Buffer.byteLength(out) + ' 字节）')
console.log('')
console.log('⚠ patch 层是**启动时**读取的，所以要让这些条目生效需要重启 DSH：')
console.log('   & powershell -NoProfile -ExecutionPolicy Bypass -File D:\\dsh-modeler\\restart-dsh.ps1')
