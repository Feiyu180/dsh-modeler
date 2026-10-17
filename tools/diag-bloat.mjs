/**
 * 诊断：雕刻结果偏大的来源。
 *
 * 对每个夹具做逐视图对照：
 *   输入剪影面积（像素）  vs  雕刻结果沿该轴投影后的面积（体素）
 * 两者应该同量级；差得多的那个视图就是误差来源。
 * 另外把"解析面积"也列出来，看是"输入图本身画大了"还是"雕刻放大了"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { silhouette, carve, projectViews } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const samples = path.join(here, '..', 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

const loadView = (shape, key) => {
  const meta = expected[shape]?.[key]
  if (!meta) return null
  const png = decodePNG(fs.readFileSync(path.join(samples, meta.file)))
  return silhouette({ data: png.rgba, width: png.width, height: png.height })
}
const area = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n }

const PARSED = {
  sphere: { front: Math.PI / 4 * 120 * 120, side: Math.PI / 4 * 120 * 120, top: Math.PI / 4 * 120 * 120 },
  cylinder: { front: 100 * 140, side: 100 * 140, top: Math.PI / 4 * 100 * 100 },
  cone: { front: 0.5 * 100 * 140, side: 0.5 * 100 * 140, top: Math.PI / 4 * 100 * 100 },
  box: { front: 120 * 60, side: 40 * 60, top: 120 * 40 },
  lshape: { front: 40 * 120 + 80 * 40, side: 60 * 120, top: 40 * 60 },
}

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log(pad('形状', 10), pad('视图', 7), pad('输入像素数', 11), pad('解析面积', 10),
  pad('差', 8), pad('投影体素数', 11), pad('投影/输入', 10), pad('投影/解析', 10))
console.log('-'.repeat(82))

for (const shape of ['box', 'sphere', 'cylinder', 'cone', 'lshape']) {
  const sils = {}
  for (const k of ['front', 'side', 'top']) {
    const s = loadView(shape, k)
    if (!s) { sils = null; break }
    sils[k] = s
  }
  if (!sils || !sils.front) continue

  const vol = carve(sils, { resolution: 120, padding: 0, smooth: 0 })
  const proj = projectViews(vol.occupied, vol.nx, vol.ny, vol.nz, 512)

  // projectViews 输出的投影是"压扁后"的，面积单位是它自己的像素；换算回体素单位
  const ratios = {
    front: [vol.nx, vol.ny],
    side: [vol.nz, vol.ny],
    top: [vol.nx, vol.nz],
  }
  for (const k of ['front', 'side', 'top']) {
    const inputArea = area(sils[k].mask)
    const p = proj[k]
    const projPx = area([...Array(p.width * p.height)].map((_, i) => (p.data[i * 4] ? 1 : 0)))
    // 投影像素 → 体素：投影把 nx×ny 映射到 p.width×p.height
    const cell = (ratios[k][0] * ratios[k][1]) / (p.width * p.height)
    const projVox = projPx * cell
    const parsed = PARSED[shape]?.[k] ?? NaN
    console.log(
      pad(shape, 10), pad(k, 7),
      pad(inputArea, 11), pad(Math.round(parsed), 10),
      pad((inputArea / parsed).toFixed(3), 8),
      pad(Math.round(projVox), 11),
      pad((projVox / inputArea).toFixed(3), 10),
      pad((projVox / parsed).toFixed(3), 10),
    )
  }
  console.log(pad('', 10), `网格 ${vol.nx}×${vol.ny}×${vol.nz}  实雕体素 ${vol.filled}  scale=${vol.scale.toFixed(4)}`)
  console.log()
}
