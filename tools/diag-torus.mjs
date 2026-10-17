/**
 * 定位分歧：torus-ish 的 JS carve 给出 1728000，独立解析给 1253000。
 * 直接看中心体素在三张视图上的采样结果。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { silhouette, carve } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '..', 'samples')
const E = JSON.parse(fs.readFileSync(path.join(S, 'expected.json'), 'utf8'))

const load = (k) => {
  const meta = E['torus-ish'][k]
  const png = decodePNG(fs.readFileSync(path.join(S, meta.file)))
  return { sil: silhouette({ data: png.rgba, width: png.width, height: png.height }), file: meta.file }
}

const F = load('front'), SI = load('side'), T = load('top')
for (const [name, v] of [['front', F], ['side', SI], ['top', T]]) {
  const s = v.sil
  console.log(`${name.padEnd(6)} ${v.file}  尺寸 ${s.width}x${s.height}  bbox`, JSON.stringify(s.bbox))
  // 中心行游程，确认孔还在
  const cy = Math.floor(s.height / 2)
  let runs = [], cur = s.mask[cy * s.width], st = 0
  for (let x = 1; x < s.width; x++) {
    const v2 = s.mask[cy * s.width + x]
    if (v2 !== cur) { runs.push(`${cur}@${st}..${x - 1}`); cur = v2; st = x }
  }
  runs.push(`${cur}@${st}..${s.width - 1}`)
  console.log(`       中心行 y=${cy}: ${runs.join('  ')}`)
  console.log(`       中心点 (${cy},${cy}) = ${s.mask[cy * s.width + cy]}  （0 = 孔）`)
}

const sils = { front: F.sil, side: SI.sil, top: T.sil }
const vol = carve(sils, { resolution: 120, padding: 0, smooth: 0 })
console.log()
console.log('JS carve →', `${vol.nx}x${vol.ny}x${vol.nz}`, 'filled =', vol.filled, 'scale =', vol.scale)
const at = (x, y, z) => vol.occupied[(z * vol.ny + y) * vol.nx + x]
console.log('中心体素 (60,60,60) =', at(60, 60, 60), '（0 = 孔，1 = 实心）')
console.log('角落 (0,0,0) =', at(0, 0, 0))

// 手动复刻一遍采样，看 JS 内部到底算了什么
const W = vol.nx, H = vol.ny, D = vol.nz
const bb = (s) => s.bbox
const bf = bb(F.sil), bs = bb(SI.sil), bt = bb(T.sil)
const uRange = (s, b) => [(b.x0 + 0.5) / s.width, (b.x1 + 0.5) / s.width]
const vRange = (s, b) => [(b.y1 + 0.5) / s.height, (b.y0 + 0.5) / s.height]
const vRangeTop = (s, b) => [(b.y0 + 0.5) / s.height, (b.y1 + 0.5) / s.height]

const uf = uRange(F.sil, bf), vf = vRange(F.sil, bf)
const us = uRange(SI.sil, bs), vs = vRange(SI.sil, bs)
const ut = uRange(T.sil, bt), vt = vRangeTop(T.sil, bt)

const i = 60, j = 60, k = 60
const ufi = uf[0] + (i + 0.5) / W * (uf[1] - uf[0])
const vfj = vf[0] + (j + 0.5) / H * (vf[1] - vf[0])
const usk = us[0] + (k + 0.5) / D * (us[1] - us[0])
const vsj = vs[0] + (j + 0.5) / H * (vs[1] - vs[0])
const uti = ut[0] + (i + 0.5) / W * (ut[1] - ut[0])
const vtk = vt[0] + (k + 0.5) / D * (vt[1] - vt[0])

const sample = (s, u, v) => {
  const x = Math.floor(u * s.width), y = Math.floor(v * s.height)
  return s.mask[y * s.width + x]
}

console.log()
console.log('手动采样（中心体素）：')
console.log('  front u=', ufi.toFixed(5), 'v=', vfj.toFixed(5), '→ 命中', sample(F.sil, ufi, vfj))
console.log('  side  u=', usk.toFixed(5), 'v=', vsj.toFixed(5), '→ 命中', sample(SI.sil, usk, vsj))
console.log('  top   u=', uti.toFixed(5), 'v=', vtk.toFixed(5), '→ 命中', sample(T.sil, uti, vtk))
