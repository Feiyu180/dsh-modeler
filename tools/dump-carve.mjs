/**
 * 生成 tools/_py-carve-dump.json —— 供 Python 交叉验证脚本（expect-voxels.py /
 * verify-carve.py）对照用的"JS 侧实雕结果"。
 *
 * 为什么要单独一个脚本：这份 dump 是**跨语言对数的锚点**。以前它是手工跑一段
 * inline 脚本产生的，于是它会过期 —— 表现是 Python 明明和自己的解析实现一致，
 * 却报"与 JS 不一致"，害我查了半天。现在把它固化成一个每次验证都会重跑的步骤。
 *
 * 用法：node tools/dump-carve.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { silhouette, carve, buildMesh } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const samples = path.join(here, '..', 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'lshape', 'torus-ish', 'asym', 'tiny']

const loadView = (shape, key) => {
  const meta = expected[shape]?.[key]
  if (!meta) return null
  const png = decodePNG(fs.readFileSync(path.join(samples, meta.file)))
  return silhouette({ data: png.rgba, width: png.width, height: png.height })
}

const out = {}
for (const shape of SHAPES) {
  const sils = {}
  let ok = true
  for (const k of ['front', 'side', 'top']) {
    const v = loadView(shape, k)
    if (!v) { ok = false; break }
    sils[k] = v
  }
  if (!ok) continue

  const vol = carve(sils, { resolution: 120, padding: 0, smooth: 0 })
  const mesh = buildMesh(sils, { resolution: 120, padding: 0, smooth: 0 })
  out[shape] = {
    nx: vol.nx,
    ny: vol.ny,
    nz: vol.nz,
    filled: vol.filled,
    scale: vol.scale,
    triangles: mesh.meta.triangleCount,
    watertight: mesh.meta.watertight,
    volume: Number(mesh.meta.volume.toFixed(6)),
  }
}

const file = path.join(here, '_py-carve-dump.json')
fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8')
console.log(`已写出 ${path.relative(path.join(here, '..'), file)}：${Object.keys(out).length} 个形状`)
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k.padEnd(11)} ${v.nx}×${v.ny}×${v.nz}  filled=${v.filled}  三角形=${v.triangles}  水密=${v.watertight ? '是' : '否'}`)
}
