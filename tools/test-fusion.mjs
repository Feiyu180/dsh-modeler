/**
 * 融合管线的自检：归一化 → 体素化 → 多数票合并 → 等值面重建。
 *
 * 为什么要单独测：这条链上有三处容易静默出错的地方 ——
 *   1. meshToVoxels 的 flood fill 如果判反了（把内部当外部），结果会是**空网格**，
 *      而空网格和"真的没东西"看起来一样；
 *   2. 三个 mesh 不归一化就体素化，是拿不同坐标系硬比，取交集会退化成一团；
 *   3. mergeVoxelVotes 的阈值算错（比如把"过半"写成"全部"），三视图分歧时结果会空。
 *
 * 测试用程序生成的球，故意做出"两个相近 + 一个偏差很大"的组合，验证多数票确实
 * 把那个离群的压掉了。
 *
 * 用法：node tools/test-fusion.mjs
 */

import {
  normalizeMesh, meshToVoxels, mergeVoxelVotes, meshFromVoxels,
} from '../src/core/geometry.js'

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`) }
}

/** 生成一个 UV 球（保证水密：经纬网格 + 两极封口） */
function makeSphere(radius = 1, seg = 24, ring = 16, cx = 0, cy = 0, cz = 0) {
  const pos = [], idx = []
  for (let i = 0; i <= ring; i++) {
    const phi = (i / ring) * Math.PI
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2
      pos.push(
        cx + radius * Math.sin(phi) * Math.cos(th),
        cy + radius * Math.cos(phi),
        cz + radius * Math.sin(phi) * Math.sin(th),
      )
    }
  }
  const W = seg + 1
  for (let i = 0; i < ring; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

const triCount = (m) => Math.round(m.indices.length / 3)

/** 生成一个长方体（12 个三角形，水密） */
function makeBox(sx = 1, sy = 1, sz = 1) {
  const x = sx / 2, y = sy / 2, z = sz / 2
  const v = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ]
  const f = [
    [0, 2, 1], [0, 3, 2], // -Z
    [4, 5, 6], [4, 6, 7], // +Z
    [0, 1, 5], [0, 5, 4], // -Y
    [3, 6, 2], [3, 7, 6], // +Y
    [0, 7, 3], [0, 4, 7], // -X
    [1, 2, 6], [1, 6, 5], // +X
  ]
  const pos = [], idx = []
  for (const p of v) pos.push(p[0], p[1], p[2])
  for (const t of f) idx.push(t[0], t[1], t[2])
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

console.log('[1] 单个球：能否体素化出实体')
{
  const s = makeSphere(1, 24, 16)
  const g = meshToVoxels(normalizeMesh(s.positions), s.indices, 40)
  const total = g.nx * g.ny * g.nz
  const ratio = g.filled / total
  // 球的体积占比 = (4/3)πr³ / (2r)³ ≈ 0.5236；栅格是长方体所以按各轴比例会不同，
  // 这里只做量级检查：内部体素不该是 0（flood fill 判反了就是 0），也不该接近满格。
  ok('内部体素非空', g.filled > 0, `filled=${g.filled}`)
  ok('内部体素不占满整格', ratio < 0.75, `占 ${(ratio * 100).toFixed(1)}%`)
  ok('壳层非空', g.shellCount > 0, `shell=${g.shellCount}`)
  ok('壳在内部之外（壳 ⊂ 占据）', g.shellCount <= g.filled + 1, `${g.shellCount} vs ${g.filled}`)
}

console.log('[2] 多数票：三个网格里混一个形状明显不同的，应该被压掉')
{
  // ⚠ 用**形状不同**的网格来制造分歧。
  // 第一版这里是"三个同样的球、只挪位置"，结果三者归一化后完全重合、分歧度 0% ——
  // 那不是算法错，而是 normalizeMesh 按设计把它们居中对齐了。要制造真分歧必须换形状。
  const sphere = makeSphere(1, 20, 14)
  const box = makeBox(1, 1, 1.6)

  const RES = 48
  const nSphere = normalizeMesh(sphere.positions)
  const nBox = normalizeMesh(box.positions)
  const g1 = meshToVoxels(nSphere, sphere.indices, RES)
  const g2 = meshToVoxels(nSphere, sphere.indices, RES)
  const g3 = meshToVoxels(nBox, box.indices, RES)

  const merged = mergeVoxelVotes([g1, g2, g3])
  ok('三视图默认阈值 = 过半', merged.stats.needVotes === 2, `needVotes=${merged.stats.needVotes}`)
  ok('合并后非空', merged.stats.kept > 0, `kept=${merged.stats.kept}`)
  // 共识体积应该**等于多数派**（两个相同的球）—— 不是"小于任何单个网格"，
  // 第一版断言就是这个写错了：多数派那边本来就该被完整保留。
  ok('共识 = 多数派的体积', Math.abs(merged.stats.kept - g1.filled) / g1.filled < 0.02,
    `merged=${merged.stats.kept} sphere=${g1.filled}`)
  // 真正该验的：少数派（长方体）独有的那部分必须被剔掉。
  // 直接查"共识里有没有任何一个体素是多数派（球）没有的" —— 有就说明没剔干净。
  let outsideMajority = 0
  for (let i = 0; i < merged.occupied.length; i++) {
    if (merged.occupied[i] && !g1.occupied[i]) outsideMajority++
  }
  ok('共识全部落在多数派之内（少数派独占体积已被剔除）', outsideMajority === 0,
    `越界体素 ${outsideMajority}`)
  ok('存在部分视图才认可的体积（分歧被记录）', merged.stats.disagreement > 0,
    `分歧度 ${(merged.stats.disagreement * 100).toFixed(1)}%`)
  ok('一致体素 <= 任何单个网格', merged.stats.unanimous <= g1.filled,
    `unanimous=${merged.stats.unanimous}`)

  // 严格交集（要求全票）必须比多数票小或相等 —— 这是"多数票更宽容"的直接证据。
  // 全票 = 球 ∩ 长方体，所以它应该明显小于多数票。
  const strict = mergeVoxelVotes([g1, g2, g3], { threshold: 3 })
  ok('全票阈值严格小于多数票', strict.stats.kept < merged.stats.kept,
    `strict=${strict.stats.kept} vs majority=${merged.stats.kept}`)
}

console.log('[3] 全一致时：多数票结果应约等于原体积')
{
  const s = makeSphere(1, 20, 14)
  const RES = 40
  const n = normalizeMesh(s.positions)
  const gs = [0, 1, 2].map(() => meshToVoxels(n, s.indices, RES))
  const merged = mergeVoxelVotes(gs)
  ok('全部体素都是一致票', merged.stats.unanimous === merged.stats.kept,
    `unanimous=${merged.stats.unanimous} kept=${merged.stats.kept}`)
  ok('分歧度为 0', merged.stats.disagreement === 0)
}

console.log('[4] 等值面重建：融合结果能出闭合网格')
{
  const s = makeSphere(1, 20, 14)
  const RES = 40
  const n = normalizeMesh(s.positions)
  const merged = mergeVoxelVotes([meshToVoxels(n, s.indices, RES), meshToVoxels(n, s.indices, RES)])
  const vm = meshFromVoxels(merged.occupied, merged.nx, merged.ny, merged.nz, { smooth: 0 })
  ok('重建出非空网格', !!vm.positions && vm.positions.length > 0, `${triCount(vm)} 三角形`)
  ok('顶点数合理', vm.positions.length / 3 > 50, `${vm.positions.length / 3} 顶点`)

  // 每个三角形索引都必须落在顶点范围内 —— 越界会让 three 静默画错甚至崩
  let maxIdx = -1
  for (const i of vm.indices) if (i > maxIdx) maxIdx = i
  ok('索引不越界', maxIdx < vm.positions.length / 3, `maxIdx=${maxIdx} verts=${vm.positions.length / 3}`)
}

console.log('[5] 尺寸不一致的栅格必须报错，而不是静默算错')
{
  const s = makeSphere(1, 16, 12)
  const n = normalizeMesh(s.positions)
  const a = meshToVoxels(n, s.indices, 24)
  const b = meshToVoxels(n, s.indices, 32)
  let threw = false
  try { mergeVoxelVotes([a, b]) } catch { threw = true }
  ok('尺寸不一致时抛错', threw)
}

console.log()
console.log(`TEST-FUSION-${fail === 0 ? 'OK' : 'FAIL-' + fail}  (${pass} passed, ${fail} failed)`)
process.exit(fail ? 1 : 0)
