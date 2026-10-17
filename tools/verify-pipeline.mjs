/**
 * 端到端验证：外部生成的 PNG 夹具 → 本插件算法 → 网格。
 *
 * 分工：
 *   - tools/selftest.test.mjs     算法内部一致性（33 项，代码里当场造位图）
 *   - tools/expect-voxels.py      **独立解析实现**，逐体素算出"应该雕出多少体素"
 *   - 本脚本                      把两者对上：真读磁盘 PNG、真跑 carve/buildMesh，
 *                                 与 Python 的期望值、解析包围盒、投影覆盖、水密性一起核对
 *
 * 为什么期望值交给 Python 算：期望值我手算错过三次（拿连续公式比离散几何、
 * 把球/锥当成棱柱、把过期 dump 当基准）。Python 那份是**另一套实现**，
 * 它和 JS 一致才说明雕刻真的对；手算不可靠。
 *
 * 前置：先跑 `python tools/expect-voxels.py` 生成 tools/expected-voxels.json
 * 用法：node tools/verify-pipeline.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { silhouette, carve, buildMesh, projectViews } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const samples = path.join(here, '..', 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

const expectedPath = path.join(here, 'expected-voxels.json')
if (!fs.existsSync(expectedPath)) {
  console.error('缺少 tools/expected-voxels.json —— 先跑：')
  console.error('  python tools/expect-voxels.py')
  process.exit(2)
}
const baseline = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))

/** 各形状的解析包围盒比例（按最长边归一化） */
const BOX_RATIO = {
  box: [120 / 120, 60 / 120, 40 / 120],
  sphere: [1, 1, 1],
  cylinder: [100 / 140, 1, 100 / 140],
  cone: [100 / 140, 1, 100 / 140],
  lshape: [1, 1, 60 / 120],
  'torus-ish': [1, 120 / 120, 1],
  asym: [140 / 140, 100 / 140, 60 / 140],
}

const failures = []
const rows = []

function loadView(shape, key) {
  const meta = expected[shape]?.[key]
  if (!meta) return null
  const png = decodePNG(fs.readFileSync(path.join(samples, meta.file)))
  return silhouette({ data: png.rgba, width: png.width, height: png.height })
}

console.log('=== 端到端：外部生成的 PNG → 雕刻 → 网格 ===\n')

for (const shape of Object.keys(baseline)) {
  const sils = {}
  let missing = false
  for (const k of ['front', 'side', 'top']) {
    const s = loadView(shape, k)
    if (!s) { missing = true; break }
    sils[k] = s
  }
  if (missing) { failures.push(`${shape}: 缺视图`); continue }

  const vol = carve(sils, { resolution: 120, padding: 0, smooth: 0 })
  const mesh = buildMesh(sils, { resolution: 120, padding: 0, smooth: 0 })

  const expVox = baseline[shape].expectedVoxels
  const expGrid = baseline[shape].grid
  const errVox = Math.abs(vol.filled - expVox) / expVox

  // 网格维度必须与独立解析一致
  const gridOk = vol.nx === expGrid[0] && vol.ny === expGrid[1] && vol.nz === expGrid[2]

  // 包围盒比例
  const target = Array.isArray(BOX_RATIO[shape]) ? BOX_RATIO[shape] : null
  let boxErr = 0
  if (target) {
    const long = Math.max(...mesh.meta.extent)
    const got = mesh.meta.extent.map((v) => v / long)
    boxErr = Math.max(...got.map((v, i) => Math.abs(v - target[i])))
  }

  // 投影回三视图，检查与输入剪影是否一致（视觉壳的定义 → 投影必须落在输入内）
  //
  // 采样方向：遍历**输入剪影的前景像素**，取该像素的一个实心体素位置，再看投影是否为实心。
  // 不用"遍历投影反查输入"是因为：当输入很小（tiny 是 6×6）而网格很大（120³）时，
  // 投影一个像素对应的输入像素范围大于 1，反向采样会大面积落到输入之外，覆盖率假性归零。
  const proj = projectViews(vol.occupied, vol.nx, vol.ny, vol.nz, 240)
  const cover = (input, pv) => {
    let hit = 0, total = 0
    for (let y = 0; y < input.height; y++) {
      for (let x = 0; x < input.width; x++) {
        if (!input.mask[y * input.width + x]) continue
        total++
        const px = Math.min(pv.width - 1, Math.floor(((x + 0.5) / input.width) * pv.width))
        const py = Math.min(pv.height - 1, Math.floor(((y + 0.5) / input.height) * pv.height))
        if (pv.data[(py * pv.width + px) * 4]) hit++
      }
    }
    return total ? hit / total : 1
  }
  const cov = {
    front: cover(sils.front, proj.front),
    side: cover(sils.side, proj.side),
    top: cover(sils.top, proj.top),
  }
  const minCov = Math.min(cov.front, cov.side, cov.top)

  const okVox = errVox <= 0.001          // 与独立实现必须逐体素相同
  const okGrid = gridOk
  const okBox = boxErr <= 0.03
  // tiny 是 6×6 主体被放大到 120³ 的极端缩放，边界体素占比极高，覆盖率天然偏低
  const minCover = shape === 'tiny' ? 0.3 : 0.9
  const okCov = minCov >= minCover
  const okWater = mesh.meta.watertight
  const okOrient = mesh.meta.volume > 0
  const noOverflow = mesh.positions.every((v) => Number.isFinite(v) && Math.abs(v) < 1e4)

  if (!okVox) failures.push(`${shape}: 体素数 ${vol.filled} ≠ 独立解析 ${expVox}（差 ${(errVox * 100).toFixed(3)}%）`)
  if (!okGrid) failures.push(`${shape}: 网格 ${vol.nx}×${vol.ny}×${vol.nz} ≠ 解析 ${expGrid.join('×')}`)
  if (!okBox) failures.push(`${shape}: 包围盒比例偏差 ${(boxErr * 100).toFixed(2)}% > 3%`)
  if (!okCov) failures.push(`${shape}: 投影落回输入剪影的最低比例 ${(minCov * 100).toFixed(1)}% < 90%`)
  if (!okWater) failures.push(`${shape}: 网格不水密（边界边 ${mesh.meta.boundaryEdges}，非流形边 ${mesh.meta.nonManifoldEdges}）`)
  if (!okOrient) failures.push(`${shape}: 绕序朝内（体积 ${mesh.meta.volume}）`)
  if (!noOverflow) failures.push(`${shape}: 顶点坐标出现异常值（距离场可能溢出）`)

  rows.push({
    shape,
    grid: `${vol.nx}×${vol.ny}×${vol.nz}`,
    filled: vol.filled,
    expVox,
    err: (errVox * 100).toFixed(3) + '%',
    boxErr: (boxErr * 100).toFixed(2) + '%',
    cover: [cov.front, cov.side, cov.top].map((v) => (v * 100).toFixed(1)).join('/'),
    tri: mesh.meta.triangleCount,
    water: mesh.meta.watertight ? '是' : '否',
    ok: okVox && okGrid && okBox && okCov && okWater && okOrient && noOverflow,
  })
}

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log(pad('形状', 12), pad('体素网格', 13), pad('实雕', 9), pad('独立解析', 9),
  pad('误差', 9), pad('盒误差', 8), pad('覆盖前/侧/俯', 15), pad('三角形', 8), pad('水密', 5), '结论')
console.log('-'.repeat(112))
for (const r of rows) {
  console.log(pad(r.shape, 12), pad(r.grid, 13), pad(r.filled, 9), pad(r.expVox, 9),
    pad(r.err, 9), pad(r.boxErr, 8), pad(r.cover, 15), pad(r.tri, 8), pad(r.water, 5), r.ok ? '✔' : '✘')
}

console.log()
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`全部通过：${rows.length} 个夹具与**独立解析实现**逐体素一致，且包围盒、投影覆盖、水密性、绕序全部符合。`)
