/**
 * 生成 tools/mv-render-test.html：把一个**已知的非对称网格**和打包好的渲染入口内联成
 * 一个自包含页面（file:// 直接能开），用真 three.js 渲出前/左/后/右四张着色图。
 *
 * 用法：node build/make-mv-render-test.mjs
 *
 * 网格为什么要"非对称且带遮挡特征"：这样才测得出多视图的价值 ——
 * 单图重建看不到的那一面只能靠猜，多视图能把它钉住。方盒子测不出任何区别。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { meshFromVoxels } from '../src/core/geometry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// ---- 夹具：一个"只有从某些角度看得出特征"的物体 ----
// 主体 20×20×20 的方块，另外：
//   · +X 侧鼓出一个台阶（从右侧能看见、从左侧看不见）
//   · +Y 顶上一个细烟囱
//   · **+Z 侧伸出一根"鼻子"**（关键）：从正面看它只是个中间的方块，**深度纯靠猜**；
//     从左侧/右侧看才能量出它伸出去多长。这正是多视图相对单图的价值所在 ——
//     方盒子测不出任何区别，所以夹具必须留一个"单图看不到的信息"。
const N = 32
const occ = new Uint8Array(N * N * N)
const set = (x, y, z, v = 1) => {
  if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) return
  occ[x + N * (y + N * z)] = v
}
for (let z = 6; z < 26; z++) for (let y = 4; y < 24; y++) for (let x = 6; x < 26; x++) set(x, y, z)
for (let z = 10; z < 22; z++) for (let y = 8; y < 20; y++) for (let x = 26; x < 31; x++) set(x, y, z)   // 右侧台阶
for (let y = 24; y < 30; y++) for (let x = 14; x < 18; x++) for (let z = 14; z < 18; z++) set(x, y, z)   // 顶上烟囱
for (let z = 26; z < 32; z++) for (let y = 16; y < 22; y++) for (let x = 8; x < 14; x++) set(x, y, z)    // 前方"鼻子"（+Z）

// 理论包围盒（体素域）——测试时拿它当参照：单图版基本猜不出 +Z 那根鼻子的长度
const extentOf = (axis) => {
  let lo = Infinity, hi = -Infinity
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!occ[x + N * (y + N * z)]) continue
    const v = axis === 0 ? x : axis === 1 ? y : z
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo + 1
}
console.log(`理论外框（体素）x=${extentOf(0)} y=${extentOf(1)} z=${extentOf(2)}`)

const built = meshFromVoxels(occ, N, N, N, { smooth: 0 })
if (!built.indices.length) throw new Error('夹具网格是空的')
const positions = Float32Array.from(built.positions)
const indices = Uint32Array.from(built.indices)
console.log(`夹具网格：${positions.length / 3} 顶点 / ${indices.length / 3} 三角形`)

const b64 = (buf) => Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64')
const meshJson = JSON.stringify({
  positions: b64(positions),
  indices: b64(indices),
})

const bundled = await build({
  entryPoints: [path.join(here, 'mv-render.mjs')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  target: ['chrome110'],
  nodePaths: [path.join(here, 'node_modules')],
  logLevel: 'warning',
})
const js = bundled.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>mv-render-test</title>
<style>
  body { font: 13px/1.6 ui-monospace, Consolas, monospace; background: #111; color: #eee; padding: 10px; }
  #out { white-space: pre-wrap; word-break: break-all; font-size: 9px; opacity: .35; max-height: 40px; overflow: hidden; }
</style>
</head>
<body>
<h3>把已知网格渲染成多视角着色图（给 Hunyuan3D-2mv 当输入）</h3>
<div id="verdict">running…</div>
<div id="out"></div>
<script>window.__MESH__ = ${meshJson};</script>
<script>${js}</script>
</body>
</html>
`

const out = path.join(root, 'tools', 'mv-render-test.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`已写出 ${path.relative(root, out)}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`)
