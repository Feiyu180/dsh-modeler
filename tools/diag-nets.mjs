/**
 * 诊断：网格拓扑指标。闭合曲面要求
 *   boundaryEdges = 0（没有只被 1 个三角形用到的边）
 *   nonManifoldEdges = 0（没有超过 2 个三角形共用的边）
 *   volume > 0（绕序朝外）
 */
import { silhouette, carve, distanceField, surfaceNets, buildMesh, meshStats } from '../src/core/geometry.js'

function bitmap(w, h, isSolid) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const v = isSolid(x, y) ? 0 : 255
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
    }
  }
  return { data, width: w, height: h }
}
const ellipseSolid = (w, h) => (x, y) =>
  ((x + 0.5 - w / 2) / (w / 2)) ** 2 + ((y + 0.5 - h / 2) / (h / 2)) ** 2 <= 1
const mk = (w, h, f) => silhouette(bitmap(w, h, f))

// --- A. 直接用 surfaceNets 喂解析场：验证 mesher 本身 ---
console.log('=== A. surfaceNets 对解析场 ===')
{
  const n = 24, c = n / 2, r = n * 0.3
  const f = new Int32Array((n + 1) ** 3)
  for (let z = 0; z <= n; z++)
    for (let y = 0; y <= n; y++)
      for (let x = 0; x <= n; x++)
        f[(z * (n + 1) + y) * (n + 1) + x] = Math.round((Math.hypot(x - c, y - c, z - c) - r) * 3)
  const m = surfaceNets(f, n, n, n)
  const st = meshStats(m.positions, m.indices)
  console.log('球场  ', `V=${st.vertexCount} T=${st.triangleCount} boundary=${st.boundaryEdges} nonManifold=${st.nonManifoldEdges} vol=${st.volume.toFixed(3)}`)
}

// --- B. 端到端 ---
console.log('=== B. buildMesh 端到端 ===')
const sphere = mk(40, 40, ellipseSolid(40, 40))
const cases = [
  ['球 res24 pad0', { front: sphere, side: sphere, top: sphere }, { resolution: 24, padding: 0, smooth: 0 }],
  ['球 res48 pad0.05', { front: sphere, side: sphere, top: sphere }, { resolution: 48, padding: 0.05, smooth: 0 }],
  ['球 res48 pad0.05 sm1', { front: sphere, side: sphere, top: sphere }, { resolution: 48, padding: 0.05, smooth: 1 }],
  ['1x1 res8 三视图', { front: mk(1, 1, () => true), side: mk(1, 1, () => true), top: mk(1, 1, () => true) }, { resolution: 8, padding: 0, smooth: 0 }],
  ['1x1 res8 单视图', { front: mk(1, 1, () => true) }, { resolution: 8, padding: 0, smooth: 0 }],
  ['长方体 res60', { front: mk(40, 60, () => true), side: mk(20, 60, () => true), top: mk(40, 20, () => true) }, { resolution: 60, padding: 0, smooth: 0 }],
  ['圆柱 res96', { front: mk(50, 70, () => true), side: mk(50, 70, () => true), top: mk(50, 50, ellipseSolid(50, 50)) }, { resolution: 96, padding: 0, smooth: 0 }],
]

for (const [name, views, opt] of cases) {
  try {
    const { positions, indices, meta } = buildMesh(views, opt)
    const st = meshStats(positions, indices)
    console.log(
      name.padEnd(22),
      'grid', String(meta.grid).padEnd(14),
      `V=${String(st.vertexCount).padEnd(6)} T=${String(st.triangleCount).padEnd(7)}`,
      `boundary=${String(st.boundaryEdges).padEnd(5)} nonManifold=${String(st.nonManifoldEdges).padEnd(5)}`,
      `vol=${st.volume.toFixed(6)}`,
      st.watertight ? '水密✔' : '不水密✘',
      st.volume > 0 ? '朝向✔' : '朝向✘',
    )
  } catch (e) {
    console.log(name.padEnd(22), '失败:', e.message)
  }
}

// --- C. 距离场自检：实心块内部必须为负 ---
console.log('=== C. 距离场符号 ===')
{
  const n = 9
  const occ = new Uint8Array(n * n * n).fill(1)
  const { field, nx: bx } = distanceField(occ, n, n, n, { pad: 0 })
  const at = (x, y, z) => field[(z * bx + y) * bx + x]
  console.log(`全实心 9³：中心 ${at(4, 4, 4)}（应为负且最小），角 ${at(0, 0, 0)}（应为负，量级小）`)

  const one = new Uint8Array(n * n * n)
  one[(4 * n + 4) * n + 4] = 1
  const r1 = distanceField(one, n, n, n, { pad: 0 })
  const a1 = (x, y, z) => r1.field[(z * r1.nx + y) * r1.nx + x]
  console.log(`单体素：中心 ${a1(4, 4, 4)}（应=-3），邻格 ${a1(5, 4, 4)}（应=+3），远处 ${a1(8, 4, 4)}（应>0）`)

  const r2 = distanceField(one, n, n, n, { pad: 2 })
  console.log(`补 2 层后维度 ${r2.nx}×${r2.ny}×${r2.nz}（应为 13），中心 ${r2.field[((4 + 2) * r2.nx + (4 + 2)) * r2.nx + (4 + 2)]}`)
}
