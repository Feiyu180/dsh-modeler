/**
 * 用**用户给的真实素材**（角色三视图切出来的 front/side/top）跑一遍完整管线，
 * 并生成一个自包含的 three.js 预览页。
 *
 * 为什么要单独一个脚本：samples/ 里那批是我自己画的**工程夹具**（纯黑白剪影、
 * 尺寸自洽）。用户这张是**彩色角色设定图** —— 有渐变、描线、阴影、水印，
 * 而且三格是 前/侧/背（没有俯视）。它测的是另一件事：**真实素材上的鲁棒性**。
 *
 * 用法：node tools/user-triptych-test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'

import { silhouette, buildMesh, meshStats } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const ROOT = 'D:/dsh-modeler'
const USER_DIR = path.join(ROOT, 'samples', 'user')

const read = (f, opt) => {
  const png = decodePNG(fs.readFileSync(path.join(USER_DIR, f)))
  return { png, sil: silhouette({ data: png.rgba, width: png.width, height: png.height }, opt) }
}

console.log('=== 用户素材：角色三视图 ===\n')

// 这张是**白底彩色插画**：白围裙 / 浅肤色与白背景亮度几乎相同，亮度阈值只能取出"描线网"，
// 雕出来是一堆碎片。所以必须走 bgFlood（背景色 + 边界洪水填充）——
// 它靠"与图像边界是否连通"来分背景，于是被描线围住的白围裙能正确判成前景。
const OPT = { bgFlood: true, bgTol: 34 }

const front = read('front.png', OPT)
const side = read('side.png', OPT)
const top = read('top.png', OPT)

const show = (name, o, png) => {
  const b = o.bbox
  console.log(`  ${name.padEnd(6)} 位图 ${png.width}x${png.height}  剪影内容框 ${b.x0},${b.y0} → ${b.x1},${b.y1}` +
    `  = ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}  前景像素 ${o.count ?? o.filled ?? '?'}`)
}
show('front', front.sil, front.png)
show('side', side.sil, side.png)
show('top', top.sil, top.png)

// 三视图自洽性（上一轮刚加的检查会在这里给出答案）
const cases = [
  ['front+side+top（合成俯视）', { front: front.sil, side: side.sil, top: top.sil }],
  ['front+side（不用俯视）', { front: front.sil, side: side.sil }],
]

const out = []
for (const [label, views] of cases) {
  console.log(`\n--- ${label} ---`)
  let m
  try {
    m = buildMesh(views, { resolution: 128, padding: 0.06, smooth: 1 })
  } catch (e) {
    console.log(`  失败：${e.message}`)
    continue
  }
  const vc = m.meta.viewConsistency
  console.log(`  网格 ${m.meta.grid.join('x')}  三角形 ${m.meta.triangleCount}  顶点 ${m.meta.vertexCount}`)
  console.log(`  水密 ${m.meta.watertight}  体积 ${m.meta.volume.toFixed(4)}  空网格 ${m.meta.empty}`)
  console.log(`  薄特征修补 ${m.meta.thinRepair ? JSON.stringify(m.meta.thinRepair) : '未触发'}`)
  console.log(`  三视图自洽 stretched=${vc.stretched}${vc.inconsistent.length ? '  ' + vc.inconsistent.map(p => p.label + ' ' + p.ratio + 'x').join(' | ') : ''}`)
  out.push({ label, m })
}

if (!out.length) { console.error('\n两个用例都失败，无法出预览'); process.exit(1) }

// ---- 生成自包含 three.js 预览页 ----
const models = out.map(({ label, m }) => ({
  name: label,
  positions: Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength).toString('base64'),
  indices: Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength).toString('base64'),
  triangles: m.meta.triangleCount,
  watertight: m.meta.watertight,
  grid: m.meta.grid,
}))

const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'build', 'render-preview.mjs')],
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'], write: false,
  nodePaths: [path.join(ROOT, 'build', 'node_modules')],
  logLevel: 'warning',
})
const js = bundle.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>user-triptych-preview</title>
<style>
  html,body{margin:0;background:#070a10;color:#dbe6f5;font:13px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
  h1{font-size:15px;margin:14px 16px 4px}
  .note{margin:0 16px 12px;opacity:.6;font-size:12px}
  #grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:0 16px 16px;max-width:900px}
  .cell{background:#0d121b;border:1px solid rgba(120,150,200,.2);border-radius:10px;padding:10px;display:flex;flex-direction:column;align-items:center;gap:5px}
  .title{font-size:12.5px;font-weight:600;color:#a9c8ff}
  .sub{font-size:11px;opacity:.55}
  canvas{border-radius:6px;display:block;width:360px;height:360px}
</style></head><body>
<h1>用户素材（角色三视图）→ 体素雕刻重建</h1>
<p class="note">淡蓝 = 重建结果。三格原图是 前/侧/<b>背</b>，没有真实俯视；"合成俯视"那格用的是前视宽度 × 侧视中位厚度。</p>
<div id="grid"></div>
<script>window.__MODELS__ = ${JSON.stringify(models)};</script>
<script>${js}</script>
</body></html>`

const outFile = path.join(ROOT, 'tools', 'user-triptych-preview.html')
fs.writeFileSync(outFile, html, 'utf8')
console.log(`\n已写出 ${path.relative(ROOT, outFile)}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`)
