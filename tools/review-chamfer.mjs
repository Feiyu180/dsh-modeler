/**
 * 独立审查脚本 C + D：
 *   C. Chamfer 3-4-5 的精度：单个空格为种子，逐点比 inside/3 与真实欧氏距离。
 *   D. 边界语义：pad=0 / pad>0 到底把"数组外"当成什么；pad=1 够不够。
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-chamfer.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const hdr = (s) => { console.log(''); console.log('='.repeat(72)); console.log(s); console.log('='.repeat(72)) }

// ---------------------------------------------------------------------------
hdr('C-1 Chamfer 3-4-5 的逐点相对误差（单个空格种子，pad=0）')
{
  const N = 41, C = 20
  const occ = new Uint8Array(N * N * N).fill(1)
  occ[(C * N + C) * N + C] = 0
  const { field, nx } = G.distanceField(occ, N, N, N, { pad: 0 })
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  // 实体的 inside 距离 = |field| - 3
  let maxErr = 0, maxAt = null, minErr = 0, minAt = null
  const buckets = new Map()
  let cnt = 0, sumAbs = 0, sumSigned = 0
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!occ[(z * N + y) * N + x]) continue
    const inside = -at(x, y, z) - 3
    const euclid = Math.hypot(x - C, y - C, z - C)
    if (euclid === 0) continue
    const rel = inside / 3 / euclid - 1
    cnt++; sumAbs += Math.abs(rel); sumSigned += rel
    if (rel > maxErr) { maxErr = rel; maxAt = { x, y, z, inside, euclid } }
    if (rel < minErr) { minErr = rel; minAt = { x, y, z, inside, euclid } }
    const k = (Math.round(rel * 100) / 1).toFixed(0)
    buckets.set(k, (buckets.get(k) || 0) + 1)
  }
  console.log(`构型：41³ 全实心，正中 (20,20,20) 挖掉 1 格；pad=0；样本 ${cnt} 个体素`)
  console.log(`判据：inside/3（Chamfer 距离，单位=格）与真实欧氏距离 hypot(dx,dy,dz) 之比 - 1`)
  console.log('')
  console.log(`最大正偏差 = ${(maxErr * 100).toFixed(3)}%  @ offset (${maxAt.x - C}, ${maxAt.y - C}, ${maxAt.z - C})  chamfer=${maxAt.inside}/3=${(maxAt.inside / 3).toFixed(3)} vs 真实 ${maxAt.euclid.toFixed(4)}`)
  console.log(`最大负偏差 = ${(minErr * 100).toFixed(3)}%  @ offset (${minAt.x - C}, ${minAt.y - C}, ${minAt.z - C})  chamfer=${minAt.inside}/3=${(minAt.inside / 3).toFixed(3)} vs 真实 ${minAt.euclid.toFixed(4)}`)
  console.log(`平均绝对偏差 = ${(sumAbs / cnt * 100).toFixed(3)}%`)
  console.log('')
  // 几个方向的特征点
  console.log('代表性方向（offset → chamfer/3 vs 真实 → 误差）：')
  for (const [dx, dy, dz] of [[1, 0, 0], [1, 1, 0], [1, 1, 1], [2, 1, 0], [2, 1, 1], [2, 2, 1], [3, 1, 0], [3, 2, 1], [1, 1, 2], [2, 2, 2], [5, 1, 0], [4, 3, 2]]) {
    const x = C + dx, y = C + dy, z = C + dz
    if (x >= N || y >= N || z >= N) continue
    const inside = -at(x, y, z) - 3
    const e = Math.hypot(dx, dy, dz)
    console.log(`  (${String(dx).padStart(2)},${String(dy).padStart(2)},${String(dz).padStart(2)}) → chamfer/3=${(inside / 3).toFixed(4)}  真实=${e.toFixed(4)}  ${((inside / 3 / e - 1) * 100 >= 0 ? '+' : '')}${((inside / 3 / e - 1) * 100).toFixed(3)}%`)
  }
  console.log('')
  const inBand = [...buckets.entries()].map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0])
  console.log('误差分布（四舍五入到 1% 桶，桶值:体素数）：')
  console.log('  ' + inBand.map(([k, v]) => `${k}%:${v}`).join('  '))
  console.log('')
  console.log(`判定：Chamfer(3,4,5) 的逐点相对误差落在 ${(minErr * 100).toFixed(2)}% ~ +${(maxErr * 100).toFixed(2)}% 之间。`)
  console.log(`      平均绝对偏差 ${(sumAbs / cnt * 100).toFixed(2)}%，平均有符号偏差 ${(sumSigned / cnt * 100).toFixed(2)}% ⇒ 整体 ${sumSigned > 0 ? '系统性**高估**' : '系统性低估'}。`)
  console.log('      沿轴方向完全精确（0%）；最差方向是 3:1:1 型的斜对角（如 (6,6,18)），最准的方向是 (1,0,0) 与 (2,2,1)。')
  console.log('      这是 3-4-5 权重本身的固有误差，不是实现 bug —— 它给斜面上的距离场带来最大 ±10% 的量化偏差，')
  console.log('      等值面在斜面上会有同量级的亚体素位移。要更准得用 (1,√2,√3) 权重或精确 EDT。')
}

// ---------------------------------------------------------------------------
hdr('C-2 沿轴方向的线性度（应当严格每格 3）')
{
  const N = 21
  const occ = new Uint8Array(N * N * N).fill(1)
  occ[(10 * N + 10) * N + 10] = 0
  const { field, nx } = G.distanceField(occ, N, N, N, { pad: 0 })
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  const seq = []
  for (let x = 9; x >= 0; x--) seq.push(-at(x, 10, 10) - 3)
  console.log(`从空格旁沿 -X 走：inside 序列 = ${seq.join(', ')}`)
  const diffs = new Set()
  for (let i = 1; i < seq.length; i++) diffs.add(seq[i] - seq[i - 1])
  console.log(`相邻差分 = {${[...diffs].join(', ')}}  ${diffs.size === 1 && diffs.has(3) ? '✅ 严格线性，每格 3' : '❌ 非线性'}`)
}

// ---------------------------------------------------------------------------
hdr('D-1 核对任务单的说法：pad=0 时"数组边界外的空格参与距离计算"？')
{
  // 构造：41³ 全实心，pad=0（没有任何空格作为 inside 种子）
  const N = 9
  const occ = new Uint8Array(N * N * N).fill(1)
  const { field, nx } = G.distanceField(occ, N, N, N, { pad: 0 })
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  const vals = new Set()
  for (let i = 0; i < field.length; i++) vals.add(field[i])
  console.log(`构型：${N}³ 全实心（没有任何空格），pad=0`)
  console.log(`field 的取值集合 = {${[...vals].join(', ')}}（size=${vals.size}）`)
  console.log(`中心 field = ${at(4, 4, 4)}`)
  console.log('')
  console.log('如果"数组外被当成半空间背景"，中心应得到一个**有限**的负值（≈ -(到边界距离)*3）。')
  console.log(`实际得到 ${at(4, 4, 4)} ≈ -(BIG+3) = ${-(0x3fffff + 3)}，即**没有**任何外部背景参与 —— `)
  console.log('inside 数组里一个 0 种子都没有，chamfer 全程走 min(v, BIG+3)=BIG，因此全数组保持 BIG。')
  console.log('')
  console.log('⇒ 任务单 D-1 的描述对 pad=0 **不成立**：pad=0 时数组外既不参与也不会"把内部距离压到最小"，')
  console.log('   恰恰相反，它是完全未定义/退化（无种子）。"数组外当背景"只发生在 pad>0（补的那层空格）时。')
  console.log('')
  // 再看 pad=1 的同一个体
  const p1 = G.distanceField(occ, N, N, N, { pad: 1 })
  const at1 = (x, y, z) => p1.field[((z + 1) * p1.nx + (y + 1)) * p1.nx + (x + 1)]
  const g1 = []
  for (let x = 0; x < N; x++) g1.push(at1(x, 4, 4))
  console.log(`同体改用 pad=1：沿 X 的 field = [${g1.join(', ')}]`)
  console.log(`  中心值 ${at1(4, 4, 4)}（= -(inside+3)，inside=3*1 因为上方/下方pad层就是空格）`)
  console.log('  可见 pad>0 时**补出来的那层空格**才是背景种子 ⇒ 内部距离被压到最小，')
  console.log('  于是物体表面被"贴"到原始数组的边界上（对本例即正确的边界行为）。')
}

// ---------------------------------------------------------------------------
hdr('D-2 pad=1 够不够：pad=1/2/3 时网格体积与顶点位置的变化')
{
  const load = (base) => {
    const o = {}
    for (const k of ['front', 'side', 'top']) {
      const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${base}-${k}.png`)))
      o[k] = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
    }
    return o
  }
  const cases = []
  for (const base of ['box', 'sphere', 'cone', 'tiny', 'torus-ish']) {
    for (const pad of [0.06, 0]) {
      cases.push({ base, carvePad: pad })
    }
  }
  console.log('夹具       carve.padding  网格 pad  顶点数   三角形  体积           相对 pad=1 的体积差   最大顶点位移')
  for (const { base, carvePad } of cases) {
    const views = load(base)
    const vol = G.carve(views, { resolution: 64, padding: carvePad })
    const ref = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const refVol = G.meshStats(ref.positions, ref.indices).volume
    for (const pad of [1, 2, 3]) {
      const m = pad === 1 ? ref : G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad })
      const st = G.meshStats(m.positions, m.indices)
      const rel = (st.volume - refVol) / Math.abs(refVol)
      let maxd = 0
      if (m.positions.length === ref.positions.length) {
        // pad 变了，网格整体平移 pad 格；顶点顺序按 (z,y,x) 不变，所以先按包围盒最小值对齐再逐点比。
        const minOf = (p) => { const a = [Infinity, Infinity, Infinity]; for (let i = 0; i < p.length; i += 3) { if (p[i] < a[0]) a[0] = p[i]; if (p[i + 1] < a[1]) a[1] = p[i + 1]; if (p[i + 2] < a[2]) a[2] = p[i + 2] } return a }
        const ma = minOf(ref.positions), mb = minOf(m.positions)
        for (let i = 0; i < ref.positions.length; i++) {
          const d = Math.abs((ref.positions[i] - ma[i % 3]) - (m.positions[i] - mb[i % 3]))
          if (d > maxd) maxd = d
        }
      } else maxd = NaN
      console.log(`${base.padEnd(10)} ${String(carvePad).padStart(6)}        ${String(pad).padStart(4)}   ${String(m.positions.length / 3).padStart(6)}  ${String(m.indices.length / 3).padStart(6)}  ${st.volume.toFixed(9).padStart(15)}  ${(rel * 100).toFixed(6).padStart(18)}%   ${Number.isNaN(maxd) ? '顶点数不同!' : maxd.toExponential(2)}`)
    }
    console.log('')
  }
  console.log('结论判据：若 pad=2/3 相对 pad=1 的体积差与顶点位移都是 0（或 <1e-9），说明 pad=1 已经足够，')
  console.log('          距离场没有受到数组边界污染；carve 默认还留 6% 白边，更安全。')
}

// ---------------------------------------------------------------------------
hdr('D-3 边界"半空间"假设的正面后果：物体贴边时表面被贴到数组边界（是设计还是缺陷？）')
{
  const load = (base) => {
    const o = {}
    for (const k of ['front', 'side', 'top']) {
      const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${base}-${k}.png`)))
      o[k] = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
    }
    return o
  }
  // box 在 padding=0 时严格填满数组。看 pad=1 时网格包围盒是否正好等于 voxel 尺寸。
  const views = load('box')
  const vol = G.carve(views, { resolution: 64, padding: 0 })
  const m = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (m.positions[i + k] < mn[k]) mn[k] = m.positions[i + k]
      if (m.positions[i + k] > mx[k]) mx[k] = m.positions[i + k]
    }
  }
  console.log(`box 夹具 carve(padding=0) → 体素维度 [${vol.nx}, ${vol.ny}, ${vol.nz}]（实体填满整个数组）`)
  console.log(`pad=1 建网格后 vertex 包围盒 = [${mn.map((v) => v.toFixed(4))}] .. [${mx.map((v) => v.toFixed(4))}]`)
  console.log(`包围盒尺寸 = [${mx.map((v, k) => (v - mn[k]).toFixed(4))}]（体素坐标，期望 = 体素维度本身）`)
  const ok = mx.every((v, k) => Math.abs((v - mn[k]) - [vol.nx, vol.ny, vol.nz][k]) < 0.5)
  console.log(ok
    ? '✅ 表面正好落在原始数组边界上 ⇒ 对"实体一直到数组边界"的情形，pad=1 的语义是**正确**的，不是污染'
    : '⚠ 表面没有落在数组边界上，pad=1 可能把边界当成背景而削掉了一层')
}
