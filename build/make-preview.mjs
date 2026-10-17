/**
 * 生成一个**自包含**的预览页 tools/preview.html：内联 three.js + 内联网格数据。
 *
 * 为什么自包含：file:// 下加载 ES module 会被 CORS 拦，起 http 服务器又要多一步。
 * 把 three 和网格都内联成一个文件，双击就能看，也方便 headless 截图。
 *
 * 这个页面的用途（不只是好看）：
 *   1. 用**真实 three.js** 验证我导出的 { positions, indices } 能不能直接渲染
 *      （法线、绕序、光照）——这是自动化测试答不了的
 *   2. 让形状**可以被眼睛检查**：重建得像不像那三张视图
 *
 * 用法：node build/make-preview.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

import { silhouette, buildMesh } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const samples = path.join(root, 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

const VIEWS = ['front', 'side', 'top']

/** 用 samples 里的三视图夹具生成网格 */
function meshOf(shape, resolution = 96) {
  const sils = {}
  for (const k of VIEWS) {
    const meta = expected[shape][k]
    const png = decodePNG(fs.readFileSync(path.join(samples, meta.file)))
    sils[k] = silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  return buildMesh(sils, { resolution, padding: 0.06, smooth: 1 })
}

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64')

const SHAPES = [
  ['box', '长方体 120×60×40'],
  ['sphere', '球 d=120'],
  ['cylinder', '圆柱 d=100 h=140'],
  ['cone', '圆锥 d=100 h=140'],
  ['lshape', 'L 形柱体（凹角）'],
  ['torus-ish', '带方孔方板（通孔）'],
  ['asym', '左右不对称台阶'],
  ['tiny', '极小主体（6×6 放大）'],
]

console.log('生成模型：')
const models = []
for (const [shape, label] of SHAPES) {
  const m = meshOf(shape)
  models.push({
    name: label,
    shape,
    positions: b64(m.positions),
    indices: b64(m.indices),
    triangles: m.meta.triangleCount,
    watertight: m.meta.watertight,
    empty: m.meta.empty,
    volume: m.meta.volume,
    grid: m.meta.grid,
  })
  console.log(`  ${shape.padEnd(11)} ${m.meta.triangleCount.toString().padStart(7)} 三角形  ` +
    `网格 ${m.meta.grid.join('×')}  水密 ${m.meta.watertight ? '是' : '否'}  体积 ${m.meta.volume.toFixed(4)}`)
}

// ---- 打包渲染入口 ----
const bundle = await esbuild.build({
  entryPoints: [path.join(here, 'render-preview.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  write: false,
  nodePaths: [path.join(here, 'node_modules')],
  logLevel: 'warning',
})
const js = bundle.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>dsh-modeler 预览（three.js 实渲染）</title>
<style>
  html, body { margin: 0; background: #070a10; color: #dbe6f5;
    font: 13px/1.5 ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif; }
  h1 { font-size: 15px; margin: 14px 16px 4px; font-weight: 600; }
  .note { margin: 0 16px 12px; opacity: .6; font-size: 12px; }
  #grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 0 16px 16px; }
  .cell { background: #0d121b; border: 1px solid rgba(120,150,200,.2); border-radius: 10px;
    padding: 8px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .title { font-size: 12px; font-weight: 600; color: #a9c8ff; }
  .sub { font-size: 11px; opacity: .55; }
  canvas { border-radius: 6px; display: block; width: 320px; height: 320px; }
</style>
</head>
<body>
<h1>dsh-modeler · 三视图重建结果（three.js 实渲染）</h1>
<p class="note">每个模型都是由「前/侧/俯」三张剪影雕刻 + 对偶等值面重建出来的水密网格，直接用 BufferGeometry 渲染。</p>
<div id="grid"></div>
<script>window.__MODELS__ = ${JSON.stringify(models)};</script>
<script>${js}</script>
</body>
</html>
`

const out = path.join(here, '..', 'tools', 'preview.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`\n已写出 ${path.relative(root, out)}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB（three.js 与网格数据都已内联）`)
