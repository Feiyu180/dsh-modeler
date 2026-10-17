/**
 * toMeshJSON 的回归测试：**写出来必须能读回来**，而且几何要和源网格一致。
 *
 * 为什么要单独测：JSON 是自己造的格式，没有第三方解析器兜底 ——
 * 一旦顶点/索引的平铺约定写错（比如索引写成 1 起头，或 positions 少乘 3），
 * 导出的文件看上去"有内容"，导进别的程序却是烂的。所以这里做闭环：
 *   mesh → JSON → JSON.parse → 逐点对比 → 再喂给 meshStats 核对拓扑统计。
 */
import assert from 'node:assert/strict'
import { toMeshJSON, meshStats } from '../src/core/geometry.js'
import { meshFromVoxels, mergeVoxelVotes } from '../src/core/geometry.js'

const failures = []
const ok = (cond, msg) => { if (!cond) failures.push(msg) }

// 造一个"有厚度"的盒子网格。
// ⚠ meshFromVoxels 的签名是 (occ, nx, ny, nz, opt) —— 尺寸是**分开传**的，不是放在对象里；
// 1 体素厚的结构重建不出网格（见 README §4.3b），所以每个轴都留够厚度。
const N = 24
const box = (x0, x1) => {
  const data = new Uint8Array(N * N * N)
  for (let z = 6; z < 18; z++) {
    for (let y = 6; y < 18; y++) {
      for (let x = x0; x < x1; x++) data[x + N * (y + N * z)] = 1
    }
  }
  return { nx: N, ny: N, nz: N, data, occupied: data, origin: [0, 0, 0], step: 1 / N }
}
const occ = box(4, 20)
const mesh = meshFromVoxels(occ.data, N, N, N, { smooth: 0 })
assert.ok(mesh.indices.length > 0, '夹具网格不该是空的')

const text = toMeshJSON(mesh.positions, mesh.indices, {
  name: 'fixture',
  createdAt: '2026-01-01T00:00:00.000Z',
  source: 'views-carve',
  stats: { vertexCount: mesh.positions.length / 3, triangleCount: mesh.indices.length / 3, watertight: true },
  params: { resolution: 24, smooth: 0 },
  inputs: { carvingViews: { front: true, side: false, top: true }, aiViews: [] },
})

// 1. 是合法 JSON，且是自证的
const doc = JSON.parse(text)
assert.equal(doc.format, 'dsh-modeler.mesh')
assert.equal(doc.version, 1)
assert.equal(doc.name, 'fixture')
assert.equal(doc.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt 应原样透传，便于复现')
assert.equal(doc.source, 'views-carve')
assert.equal(doc.precision, 1e-6)
assert.ok(doc.layout && doc.layout.positions && doc.layout.indices, 'layout 说明必须存在')
assert.equal(doc.params.resolution, 24)
assert.deepEqual(doc.inputs.carvingViews, { front: true, side: false, top: true })

// 2. 计数自洽
assert.equal(doc.vertexCount, mesh.positions.length / 3)
assert.equal(doc.triangleCount, mesh.indices.length / 3)
assert.equal(doc.positions.length, doc.vertexCount * 3, 'positions 必须是 3 的倍数长度')
assert.equal(doc.indices.length, doc.triangleCount * 3, 'indices 必须是 3 的倍数长度')

// 3. 几何逐点/逐索引一致（精度 1e-6 内）
let maxErr = 0
for (let i = 0; i < mesh.positions.length; i++) {
  maxErr = Math.max(maxErr, Math.abs(doc.positions[i] - mesh.positions[i]))
}
ok(maxErr <= 1e-6, `坐标误差 ${maxErr} 超过 1e-6`)
for (let i = 0; i < mesh.indices.length; i++) {
  if (doc.indices[i] !== mesh.indices[i]) { ok(false, `索引第 ${i} 项不一致：${doc.indices[i]} != ${mesh.indices[i]}`); break }
}
// 索引必须是 0 起头且都在范围内（写成 1 起头会在这里露馅）
const vmax = doc.vertexCount
let idxMin = Infinity, idxMax = -Infinity
for (const v of doc.indices) { if (v < idxMin) idxMin = v; if (v > idxMax) idxMax = v }
ok(idxMin === 0, `索引最小应是 0（0 起头），实际 ${idxMin}`)
ok(idxMax < vmax, `索引最大 ${idxMax} 超出顶点数 ${vmax}（可能被写成 1 起头了）`)

// 4. 读回来的拓扑统计与源网格一致 —— 这才是"文件真的可用"的证明
const a = meshStats(mesh.positions, mesh.indices)
const b = meshStats(Float32Array.from(doc.positions), Uint32Array.from(doc.indices))
ok(a.vertexCount === b.vertexCount, '读回后顶点数变了')
ok(a.triangleCount === b.triangleCount, '读回后三角形数变了')
ok(a.watertight === b.watertight, '读回后水密判定变了')
// 体积用**相对**容差：坐标按 1e-6 取整，体积是几百万个小四面体累加，绝对误差会被放大。
// 这里要证的是"取整没把几何搞坏"（拓扑/水密不变、体积相对误差 ~1e-9），不是"逐位相等"。
const volRel = Math.abs(a.volume - b.volume) / Math.max(Math.abs(a.volume), 1e-9)
ok(volRel < 1e-6, `读回后体积相对误差 ${volRel} 过大：${a.volume} vs ${b.volume}`)

// 5. Float32 之外的输入也要能吃（Uint32Array / 普通数组）
const t2 = toMeshJSON([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], { name: 'tri' })
const d2 = JSON.parse(t2)
assert.deepEqual(d2.positions, [0, 0, 0, 1, 0, 0, 0, 1, 0])
assert.deepEqual(d2.indices, [0, 1, 2])
assert.equal(d2.source, 'unknown', '没给 source 时应是 unknown，而不是空字符串')
assert.equal(d2.stats, null)
assert.equal(d2.params, null)

// 6. mergeVoxelVotes 的产物也要能导出（AI 融合那条路的网格结构一致）
const merged = mergeVoxelVotes([box(4, 20), box(6, 18)])
assert.ok(merged && merged.stats.kept > 0, '融合出的体素不该是空的')
const mesh2 = meshFromVoxels(merged.occupied, merged.nx, merged.ny, merged.nz, { smooth: 0 })
assert.ok(mesh2.indices.length > 0, '融合网格不该是空的')
const d3 = JSON.parse(toMeshJSON(mesh2.positions, mesh2.indices, { name: 'fusion', source: 'views-ai-fusion' }))
assert.equal(d3.source, 'views-ai-fusion')
assert.equal(d3.positions.length, d3.vertexCount * 3)
assert.equal(d3.indices.length, d3.triangleCount * 3)

if (failures.length) {
  console.error('toMeshJSON 测试失败：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`toMeshJSON 测试通过：${doc.vertexCount} 顶点 / ${doc.triangleCount} 三角形，`
  + `${(text.length / 1024).toFixed(1)} KB，最大坐标误差 ${maxErr}，读回拓扑一致（水密=${b.watertight}）`)
