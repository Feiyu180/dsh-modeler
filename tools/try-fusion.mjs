/**
 * 端到端跑一次"三视图 → AI 融合"，不经过浏览器。
 *
 * 目的：在让用户去面板里点之前，先把 host 的 /multi 和融合管线连起来验一遍 ——
 * 尤其是**三个 mesh 的朝向到底一不一致**（TripoSR 对每张输入图都输出"以该图为主视角"
 * 的模型，喂侧视图可能得到侧面朝前的模型；如果是那样，直接投票会叠出一坨）。
 *
 * 用法：node tools/try-fusion.mjs [图1 图2 图3...] [--out 输出前缀]
 *   默认用 samples/user 里的 front/side/back
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeMesh, meshToVoxels, mergeVoxelVotes, meshFromVoxels,
  meshStats, toOBJ, toSTLBinary,
} from '../src/core/geometry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const API = 'http://127.0.0.1:19387/dsh-modeler/api'

const argv = process.argv.slice(2)
let outPrefix = path.join(ROOT, 'tools', '_fusion')
const files = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') { outPrefix = argv[++i]; continue }
  files.push(argv[i])
}
if (!files.length) {
  for (const n of ['front', 'side', 'back']) {
    const p = path.join(ROOT, 'samples', 'user', `${n}.png`)
    if (fs.existsSync(p)) files.push(p)
  }
}
if (files.length < 2) {
  console.error('至少需要两张图')
  process.exit(1)
}

const b64 = (p) => fs.readFileSync(p).toString('base64')

console.log(`输入 ${files.length} 张：`)
for (const f of files) console.log(`  ${path.basename(f)}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`)

// ---- 1) 提交 ----
const post = await fetch(`${API}/multi`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ images: files.map(b64), mcResolution: 160, chunkSize: 200 }),
})
const j0 = await post.json()
if (!j0.ok) { console.error('提交失败：', j0.error); process.exit(1) }
console.log(`\njobId = ${j0.jobId}（每张约 1 分钟，共 ${files.length} 张）`)

// ---- 2) 轮询 ----
let meshes = null
const t0 = Date.now()
for (;;) {
  await new Promise((r) => setTimeout(r, 3000))
  const jr = await fetch(`${API}/job?id=${encodeURIComponent(j0.jobId)}`)
  const j = await jr.json()
  if (!j.ok) { console.error('查询失败：', j.error); process.exit(1) }
  const sec = ((Date.now() - t0) / 1000).toFixed(0)
  process.stdout.write(`\r  [${sec}s] ${j.state} · ${j.step}                    `)
  if (j.state === 'error') { console.error('\n重建失败：', j.error); process.exit(1) }
  if (j.state === 'done') { meshes = j.result.meshes; break }
}
console.log('\n')

// ---- 3) 逐个 mesh 的原始包围盒（用来判断朝向是否一致）----
console.log('三个 mesh 各自的原始包围盒（尺寸比例最关键）：')
const decoded = meshes.map((m, i) => {
  const positions = new Float32Array(Buffer.from(m.positions, 'base64').buffer,
    Buffer.from(m.positions, 'base64').byteOffset, m.vertexCount * 3)
  const idxBuf = Buffer.from(m.indices, 'base64')
  const indices = new Uint32Array(idxBuf.buffer, idxBuf.byteOffset, m.triangleCount * 3)
  return { positions, indices, meta: m }
})
for (let i = 0; i < decoded.length; i++) {
  const d = decoded[i]
  const nm = normalizeMesh(d.positions)
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < nm.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      const v = nm[k + a]
      if (v < lo[a]) lo[a] = v
      if (v > hi[a]) hi[a] = v
    }
  }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const maxE = Math.max(...ext)
  console.log(`  #${i} ${path.basename(files[i]).padEnd(10)} ` +
    `顶点 ${String(d.meta.vertexCount).padStart(6)} · ` +
    `归一化后比例 ${ext.map((v) => (v / maxE).toFixed(2)).join(' : ')}`)
}

// ---- 4) 融合 ----
console.log('\n融合中…')
const RES = 72
const grids = decoded.map((d) => meshToVoxels(normalizeMesh(d.positions), d.indices, RES))
const merged = mergeVoxelVotes(grids)
console.log(`  投票：${merged.stats.views} 个视图，保留 ${merged.stats.kept} 体素 · ` +
  `全体一致 ${merged.stats.unanimous} · 分歧度 ${(merged.stats.disagreement * 100).toFixed(1)}%`)

const vm = meshFromVoxels(merged.occupied, merged.nx, merged.ny, merged.nz, { smooth: 1 })
if (!vm.positions || !vm.positions.length) {
  console.error('  融合后为空 —— 几个视图矛盾太厉害')
  process.exit(1)
}

// 居中归一到单位尺寸（与面板里的做法一致）
const p = vm.positions
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < p.length; i += 3) {
  for (let a = 0; a < 3; a++) {
    if (p[i + a] < lo[a]) lo[a] = p[i + a]
    if (p[i + a] > hi[a]) hi[a] = p[i + a]
  }
}
const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
for (let i = 0; i < p.length; i += 3) {
  p[i] = (p[i] - c[0]) / ext
  p[i + 1] = (p[i + 1] - c[1]) / ext
  p[i + 2] = (p[i + 2] - c[2]) / ext
}

const st = meshStats(p, vm.indices)
console.log(`  融合结果：顶点 ${st.vertexCount} · 三角形 ${st.triangleCount} · 水密 ${st.watertight}`)
console.log(`  包围盒 ${st.extent.map((v) => v.toFixed(3)).join(' × ')}`)

// ---- 5) 落盘（OBJ + STL，方便直接看/打印）----
const base = path.basename(outPrefix)
fs.mkdirSync(path.dirname(outPrefix), { recursive: true })
fs.writeFileSync(`${outPrefix}.obj`, toOBJ(p, vm.indices, base))
fs.writeFileSync(`${outPrefix}.stl`, Buffer.from(toSTLBinary(p, vm.indices, base)))
console.log(`\n已写出：\n  ${outPrefix}.obj\n  ${outPrefix}.stl`)
