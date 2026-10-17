/**
 * 朝向对齐实验：找出让三个 AI mesh 互相吻合的旋转组合。
 *
 * 背景：TripoSR 对每张输入图都输出"以该图为主视角"的模型。所以喂正面图得到正面朝前的
 * 模型，喂侧视图得到**侧面朝前**的模型 —— 三个 mesh 朝向各不相同，直接投票会退化成
 * "把三个转不同角度的东西硬叠"，实测出来是一块薄板。
 *
 * 判据（客观可算，不靠肉眼看）：**分歧度**。三个 mesh 朝向对齐时它们会互相吻合，
 * 分歧度低；没对齐就各说各话，分歧度高。所以扫一遍旋转组合、挑分歧度最低的即可。
 *
 * 用法：node tools/fusion-sweep.mjs [--remesh] [图1 图2 图3]
 *   --remesh  强制重新跑 TripoSR（否则复用 tools/_meshes.json）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeMesh, meshToVoxels, mergeVoxelVotes, meshFromVoxels,
  meshStats, toSTLBinary,
} from '../src/core/geometry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const API = 'http://127.0.0.1:19387/dsh-modeler/api'
const CACHE = path.join(here, '_meshes.json')

const argv = process.argv.slice(2)
const remesh = argv.includes('--remesh')
const files = argv.filter((a) => !a.startsWith('--'))
if (!files.length) {
  for (const n of ['front.png', 'side.png', 'user-third.jpg']) {
    const p = path.join(ROOT, 'samples', 'user', n)
    if (fs.existsSync(p)) files.push(p)
  }
}

const decode = (m) => {
  const pb = Buffer.from(m.positions, 'base64')
  const ib = Buffer.from(m.indices, 'base64')
  return {
    positions: new Float32Array(pb.buffer, pb.byteOffset, m.vertexCount * 3),
    indices: new Uint32Array(ib.buffer, ib.byteOffset, m.triangleCount * 3),
    meta: m,
  }
}

// ---- 取三个 mesh（缓存或重跑）----
let decoded
if (!remesh && fs.existsSync(CACHE)) {
  console.log(`复用缓存 ${CACHE}`)
  decoded = JSON.parse(fs.readFileSync(CACHE, 'utf8')).map(decode)
} else {
  console.log(`跑 TripoSR（${files.length} 张，每张约 1 分钟）…`)
  const post = await fetch(`${API}/multi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: files.map((f) => fs.readFileSync(f).toString('base64')), mcResolution: 160, chunkSize: 200 }),
  })
  const j0 = await post.json()
  if (!j0.ok) { console.error('提交失败：', j0.error); process.exit(1) }
  const t0 = Date.now()
  let meshesRaw = null
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const j = await (await fetch(`${API}/job?id=${encodeURIComponent(j0.jobId)}`)).json()
    if (!j.ok) { console.error('查询失败：', j.error); process.exit(1) }
    process.stdout.write(`\r  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${j.step}          `)
    if (j.state === 'error') { console.error('\n失败：', j.error); process.exit(1) }
    if (j.state === 'done') { meshesRaw = j.result.meshes; break }
  }
  console.log()
  decoded = meshesRaw.map(decode)
  // 落盘缓存，之后 sweep 就不用再动 GPU 了（上一版这里写错，导致白跑一次）
  fs.writeFileSync(CACHE, JSON.stringify(meshesRaw))
  console.log(`已缓存到 ${CACHE}`)
}

console.log(`\n三个 mesh：${decoded.map((d, i) => `#${i}=${d.meta.vertexCount}顶点`).join(' ')}\n`)

/** 绕某轴旋转一组顶点（角度制） */
function rotatePositions(positions, rx, ry, rz) {
  const cx = Math.cos((rx * Math.PI) / 180), sx = Math.sin((rx * Math.PI) / 180)
  const cy = Math.cos((ry * Math.PI) / 180), sy = Math.sin((ry * Math.PI) / 180)
  const cz = Math.cos((rz * Math.PI) / 180), sz = Math.sin((rz * Math.PI) / 180)
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i], y = positions[i + 1], z = positions[i + 2]
    // X
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx
    y = y1; z = z1
    // Y
    let x1 = x * cy + z * sy, z2 = -x * sy + z * cy
    x = x1; z = z2
    // Z
    let x2 = x * cz - y * sz, y2 = x * sz + y * cz
    out[i] = x2; out[i + 1] = y2; out[i + 2] = z
  }
  return out
}

const RES = 72
const gridsFor = (angles) => decoded.map((d, i) => {
  const a = angles[i]
  const pos = a && (a[0] || a[1] || a[2])
    ? rotatePositions(new Float32Array(d.positions), a[0], a[1], a[2])
    : new Float32Array(d.positions)
  return meshToVoxels(normalizeMesh(pos), d.indices, RES)
})

// ---- 扫一遍旋转组合 ----
// #0 = 正面（不转，作为基准）；#1 = 侧面（试绕 Y）；#2 = 第三张（试绕 Y）
const results = []
console.log('扫旋转组合（判据：分歧度越低 = 三个 mesh 越吻合）')
console.log('  sideY  thirdY |  分歧度   保留体素   一致体素   轴比(min/max)')
console.log('  ' + '-'.repeat(62))

for (const sideY of [0, 90, 180, 270]) {
  for (const thirdY of [0, 90, 180, 270]) {
    const angles = [[0, 0, 0], [0, sideY, 0], [0, thirdY, 0]]
    let merged, vm
    try {
      merged = mergeVoxelVotes(gridsFor(angles))
      vm = meshFromVoxels(merged.occupied, merged.nx, merged.ny, merged.nz, { smooth: 1 })
    } catch (e) {
      console.log(`  ${String(sideY).padStart(4)}  ${String(thirdY).padStart(5)} |  失败: ${e.message}`)
      continue
    }
    if (!vm.positions || !vm.positions.length) {
      console.log(`  ${String(sideY).padStart(4)}  ${String(thirdY).padStart(5)} |  空网格`)
      continue
    }
    // 轴比：融合结果的最小轴 / 最大轴。薄板接近 0.2，立体人形应该明显更大
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < vm.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = vm.positions[i + a]
        if (v < lo[a]) lo[a] = v
        if (v > hi[a]) hi[a] = v
      }
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    const ratio = Math.min(...ext) / Math.max(...ext)

    const r = {
      sideY, thirdY,
      disagreement: merged.stats.disagreement,
      kept: merged.stats.kept,
      unanimous: merged.stats.unanimous,
      ratio, vm, merged,
    }
    results.push(r)
    console.log(`  ${String(sideY).padStart(4)}  ${String(thirdY).padStart(5)} | ` +
      `${(r.disagreement * 100).toFixed(1).padStart(7)}%  ${String(r.kept).padStart(8)}  ` +
      `${String(r.unanimous).padStart(8)}   ${ratio.toFixed(3)}`)
  }
}

if (!results.length) { console.error('\n所有组合都失败'); process.exit(1) }

results.sort((a, b) => a.disagreement - b.disagreement)
console.log('\n按分歧度排序，前 3：')
for (const r of results.slice(0, 3)) {
  console.log(`  sideY=${r.sideY} thirdY=${r.thirdY}  分歧度 ${(r.disagreement * 100).toFixed(1)}%  轴比 ${r.ratio.toFixed(3)}  体素 ${r.kept}`)
}

// 把前 3 名各导一份 STL，方便肉眼看三视图对照
console.log('\n导出前 3 名：')
for (let i = 0; i < Math.min(3, results.length); i++) {
  const r = results[i]
  const p = r.vm.positions
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < p.length; k += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[k + a] < lo[a]) lo[a] = p[k + a]
      if (p[k + a] > hi[a]) hi[a] = p[k + a]
    }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const e = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
  for (let k = 0; k < p.length; k += 3) {
    p[k] = (p[k] - c[0]) / e; p[k + 1] = (p[k + 1] - c[1]) / e; p[k + 2] = (p[k + 2] - c[2]) / e
  }
  const out = path.join(here, `_sweep-${i + 1}-side${r.sideY}-third${r.thirdY}.stl`)
  fs.writeFileSync(out, Buffer.from(toSTLBinary(p, r.vm.indices, 'sweep')))
  const st = meshStats(p, r.vm.indices)
  console.log(`  ${path.basename(out)}  三角形 ${st.triangleCount}  水密 ${st.watertight}`)
}
