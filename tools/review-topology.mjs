/**
 * 独立审查脚本 B：Surface Nets 的拓扑正确性。
 *
 * 关键：**不用仓库里的 meshStats()**，全部自己实现一遍，用不同的数据结构。
 *   B-1 每条无向边被几个三角形共享（用字符串 key，避开仓库里 p*2^21+q 的整数拼 key）
 *   B-2 散度定理独立算体积：Σ (a·(b×c))/6
 *   B-3 零面积 / 退化三角形（顶点重合）
 *   B-4 **非流形顶点**（bowtie）：meshStats 只查边，不查顶点 —— 朴素 Surface Nets
 *       在"一个格里等值面分成两片"时会产生夹住的顶点，这里补上
 *   B-5 连通壳数 + 每壳的有符号体积（判断绕序是否一致朝外）
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-topology.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const hdr = (s) => { console.log(''); console.log('='.repeat(72)); console.log(s); console.log('='.repeat(72)) }
const load = (base) => {
  const o = {}
  for (const k of ['front', 'side', 'top']) {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${base}-${k}.png`)))
    o[k] = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  return o
}

// ---------------------------------------------------------------------------
// 独立实现（全部自己写）
// ---------------------------------------------------------------------------

/** B-1：无向边 → 使用次数。key 用字符串，完全独立于仓库的整数拼 key。 */
function edgeUse(pos, idx) {
  const m = new Map()
  const add = (p, q) => { const k = p < q ? `${p}|${q}` : `${q}|${p}`; m.set(k, (m.get(k) || 0) + 1) }
  for (let t = 0; t < idx.length; t += 3) { add(idx[t], idx[t + 1]); add(idx[t + 1], idx[t + 2]); add(idx[t + 2], idx[t]) }
  return m
}

/** B-2：散度定理体积 */
function volumeDivergence(pos, idx) {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2]
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  return v
}

/** B-3 + 顶点重合统计 */
function degenerate(pos, idx) {
  let zeroArea = 0, tiny = 0, minArea = Infinity
  const coincident = new Set()
  for (let t = 0; t < idx.length; t += 3) {
    const [i, j, k] = [idx[t], idx[t + 1], idx[t + 2]]
    if (i === j || j === k || i === k) coincident.add(`idx:${t / 3}`)
    const a = i * 3, b = j * 3, c = k * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const area = 0.5 * Math.hypot(nx, ny, nz)
    if (area < minArea) minArea = area
    if (area === 0) zeroArea++
    else if (area < 1e-12) tiny++
  }
  // 完全重合的顶点对（坐标逐位相同）
  const byPos = new Map()
  let dupPos = 0
  for (let i = 0; i < pos.length; i += 3) {
    const k = `${pos[i]}|${pos[i + 1]}|${pos[i + 2]}`
    if (byPos.has(k)) dupPos++
    else byPos.set(k, i / 3)
  }
  return { zeroArea, tiny, minArea, dupPos, badIndex: coincident.size }
}

/**
 * B-4：非流形顶点（bowtie / pinch）。
 * 判据：顶点 v 的 one-ring。把 v 的每个关联三角形映射成"对边"(p,q)，
 * 若这些周边能连成 **1 条** 闭合链 ⇒ 流形；连成多条 ⇒ 非流形顶点。
 */
function nonManifoldVertices(idx, nv) {
  const incident = new Map() // v → 关联三角形 id 列表
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k]
      let a = incident.get(v)
      if (!a) { a = []; incident.set(v, a) }
      a.push(t)
    }
  }
  let bad = 0
  const badList = []
  for (const [v, tris] of incident) {
    if (tris.length < 4) continue // 少于 4 个面不可能夹
    // 每个三角形 → 该顶点的两个邻居构成的"周边"
    const link = new Map() // 顶点 → 相邻顶点集合（只在 v 的 one-ring 内）
    for (const t of tris) {
      const s = [idx[t], idx[t + 1], idx[t + 2]]
      const others = s.filter((x) => x !== v)
      if (others.length !== 2) continue
      const [p, q] = others
      if (!link.has(p)) link.set(p, new Set())
      if (!link.has(q)) link.set(q, new Set())
      link.get(p).add(q); link.get(q).add(p)
    }
    // 数 link 的连通分量
    const seen = new Set()
    let comps = 0
    for (const start of link.keys()) {
      if (seen.has(start)) continue
      comps++
      const st = [start]
      seen.add(start)
      while (st.length) {
        const x = st.pop()
        for (const y of link.get(x)) if (!seen.has(y)) { seen.add(y); st.push(y) }
      }
    }
    if (comps > 1) { bad++; if (badList.length < 12) badList.push({ v, tris: tris.length, comps }) }
  }
  return { bad, badList, nv }
}

/** B-5：三角形连通壳 + 每壳有符号体积 */
function shells(pos, idx) {
  // 顶点并查集（按共享顶点连通，足以刻画壳）
  const nv = pos.length / 3
  const parent = new Int32Array(nv)
  for (let i = 0; i < nv; i++) parent[i] = i
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (let t = 0; t < idx.length; t += 3) { uni(idx[t], idx[t + 1]); uni(idx[t + 1], idx[t + 2]) }
  const vol = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2]
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
    const v = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
    const r = find(idx[t])
    vol.set(r, (vol.get(r) || 0) + v)
  }
  return [...vol.values()].sort((x, y) => Math.abs(y) - Math.abs(x))
}

// ---------------------------------------------------------------------------
hdr('B · 各夹具：自己实现的拓扑体检（不使用 meshStats）')
const fixtures = ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']
const rows = []
for (const base of fixtures) {
  const views = load(base)
  for (const res of [64, 96]) {
    const m = G.buildMesh(views, { resolution: res, padding: 0.06, smooth: 0 })
    const pos = m.positions, idx = m.indices
    const eu = edgeUse(pos, idx)
    let n1 = 0, n2 = 0, n3plus = 0
    const hist = new Map()
    for (const c of eu.values()) {
      hist.set(c, (hist.get(c) || 0) + 1)
      if (c === 1) n1++
      else if (c === 2) n2++
      else n3plus++
    }
    const vol = volumeDivergence(pos, idx)
    const deg = degenerate(pos, idx)
    const nm = nonManifoldVertices(idx, pos.length / 3)
    const sh = shells(pos, idx)
    const row = {
      base, res, V: pos.length / 3, T: idx.length / 3, edges: eu.size,
      n1, n2, n3plus, vol, metaVol: m.meta.volume,
      deg, nm, sh,
      stat: G.meshStats(pos, idx),
      _pos: pos, _idx: idx,
    }
    rows.push(row)
  }
}

hdr('B-1 每条无向边被几个三角形共享（自己实现，字符串 key）')
console.log('夹具        res  顶点     三角形   边数     边使用次数分布(次数→边数)            全=2?')
for (const r of rows) {
  const hist = new Map()
  for (const c of edgeUse(r._pos, r._idx).values()) hist.set(c, (hist.get(c) || 0) + 1)
  const dist = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' ')
  const allTwo = hist.size === 1 && hist.has(2)
  console.log(`${r.base.padEnd(11)} ${String(r.res).padStart(3)}  ${String(r.V).padStart(6)}  ${String(r.T).padStart(7)}  ${String(r.edges).padStart(6)}   ${dist.padEnd(32)}  ${allTwo ? '✅ 是' : '❌ 否'}`)
}
console.log('')
console.log('欧拉关系核对：闭合三角网格应有 T = 2V - 4 + 2*(壳数-1)*…（这里直接看边全=2 更硬）')

// ---------------------------------------------------------------------------
hdr('B-2 散度定理独立算体积 vs meta.volume（并检查符号为正 = 绕序朝外）')
let volBad = 0
for (const r of rows) {
  const diff = Math.abs(r.vol - r.metaVol)
  const rel = diff / Math.abs(r.vol || 1)
  const ok = rel < 1e-9 && r.vol > 0
  if (!ok) volBad++
  console.log(`${r.base.padEnd(11)} res=${String(r.res).padStart(3)}  我算的=${r.vol.toFixed(9).padStart(18)}  meta.volume=${r.metaVol.toFixed(9).padStart(18)}  相对差=${rel.toExponential(2)}  ${ok ? '✅' : '❌'}`)
}
console.log('')
console.log(volBad === 0
  ? '✅ 全部一致且为正：散度定理独立复算与 meta.volume 吻合，绕序朝外'
  : `❌ 有 ${volBad} 项不符`)
console.log('（诚实说明：这是同一个散度公式的重新实现，只证明 meshStats 的实现没写错，')
console.log('  不能算"另一种方法"。下面的 B-2b 才是真正独立的方法。）')

// ---------------------------------------------------------------------------
hdr('B-2b 蒙特卡洛射线求交独立测体积（与散度定理完全不同的方法）')
{
  // 做法：在包围盒内均匀撒点，沿 +X 打射线，用 Möller–Trumbore 数穿面次数；
  // 奇数 ⇒ 在实体内部。体积 = 包围盒体积 × 内部比例。
  // 只看量级与正负，不看小数点后几位（统计误差 ~1/n^0.5）。
  // 射线方向固定为 +X：Möller–Trumbore
  const mt = (ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    // p = d × e2，d = (1,0,0) ⇒ p = (0, -e2z, e2y)
    const px = 0, py = -e2z, pz = e2y
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) return -1
    const inv = 1 / det
    const tx = ox - ax, ty = oy - ay, tz = oz - az
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) return -1
    // q = tvec × e1
    const qx = ty * e1z - tz * e1y
    const qy = tz * e1x - tx * e1z
    const qz = tx * e1y - ty * e1x
    // v = d·q / det = qx / det
    const v = qx * inv
    if (v < 0 || u + v > 1) return -1
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv
    return t
  }
  const mcVolume = (pos, idx, nSamples = 40000) => {
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < minx) minx = pos[i]; if (pos[i] > maxx) maxx = pos[i]
      if (pos[i + 1] < miny) miny = pos[i + 1]; if (pos[i + 1] > maxy) maxy = pos[i + 1]
      if (pos[i + 2] < minz) minz = pos[i + 2]; if (pos[i + 2] > maxz) maxz = pos[i + 2]
    }
    const ex = maxx - minx, ey = maxy - miny, ez = maxz - minz
    // 确定性伪随机，保证可复现
    let s = 123456789 >>> 0
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    let inside = 0
    for (let n = 0; n < nSamples; n++) {
      const ox = minx - 1 + rnd() * (ex + 2)
      const oy = miny + rnd() * ey
      const oz = minz + rnd() * ez
      let cross = 0
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
        const hit = mt(ox, oy, oz, pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2])
        if (hit >= 0) cross++
      }
      if (cross % 2 === 1) inside++
    }
    return { volume: (ex + 2) * ey * ez * inside / nSamples, ratio: inside / nSamples, box: [ex, ey, ez] }
  }
  for (const [base, res] of [['box', 48], ['sphere', 48], ['torus-ish', 48]]) {
    const m = G.buildMesh(load(base), { resolution: res, padding: 0.06, smooth: 0 })
    const est = mcVolume(m.positions, m.indices, 40000)
    const ref = m.meta.volume
    const rel = Math.abs(est.volume - ref) / Math.abs(ref)
    console.log(`${base.padEnd(11)} res=${res}  蒙特卡洛=${est.volume.toFixed(5)}  散度=${ref.toFixed(5)}` +
      `  相对差=${(rel * 100).toFixed(2)}%  三角形=${m.indices.length / 3}  ${rel < 0.03 ? '✅ 量级一致（统计误差内）' : '⚠ 偏差偏大'}`)
  }
  console.log('')
  console.log('说明：40k 采样的 1σ 统计误差约 0.2~0.8%，所以判据取 3%；这一步只排除"量级错/符号错/方法错"。')
}

// ---------------------------------------------------------------------------
hdr('B-3 退化三角形 / 重合顶点')
let degBad = 0
for (const r of rows) {
  const d = r.deg
  const ok = d.zeroArea === 0 && d.tiny === 0 && d.dupPos === 0 && d.badIndex === 0
  if (!ok) degBad++
  console.log(`${r.base.padEnd(11)} res=${String(r.res).padStart(3)}  零面积=${d.zeroArea} 极小面积(<1e-12)=${d.tiny} 最小面积=${d.minArea.toExponential(3)} 坐标重合顶点对=${d.dupPos} 索引重复=${d.badIndex}  ${ok ? '✅' : '⚠'}`)
}
console.log('')
console.log(degBad === 0
  ? '✅ 没有零面积三角形，也没有坐标完全重合的顶点 —— STL 不会被退化面污染'
  : `⚠ 有 ${degBad} 项出现退化（见上）`)

// ---------------------------------------------------------------------------
hdr('B-4 非流形顶点（bowtie / pinch）—— meshStats 只查边、不查这个')
let nmBad = 0
for (const r of rows) {
  const { bad, badList, nv } = r.nm
  if (bad) nmBad++
  console.log(`${r.base.padEnd(11)} res=${String(r.res).padStart(3)}  非流形顶点数=${String(bad).padStart(5)} / ${nv}  ${bad === 0 ? '✅' : '⚠'}`)
  if (bad && badList.length) console.log(`            例：${badList.map((x) => `v${x.v}(面${x.tris},环${x.comps}段)`).join(' ')}`)
}
console.log('')
console.log(nmBad === 0
  ? '✅ 所有顶点的一环都连成单条闭环 ⇒ 顶点流形'
  : `⚠ 有 ${nmBad} 项出现非流形顶点：边流形但顶点被"夹住"，3D 打印切片器/布尔运算可能出问题`)

// ---------------------------------------------------------------------------
hdr('B-5 连通壳数 + 每壳有符号体积（判断是否所有壳都朝外）')
for (const r of rows) {
  const s = r.sh
  const allPos = s.every((v) => v > 0)
  console.log(`${r.base.padEnd(11)} res=${String(r.res).padStart(3)}  壳数=${String(s.length).padStart(2)}  各壳体积=[${s.map((v) => v.toExponential(4)).join(', ')}]  ${allPos ? '✅ 全部为正（一致朝外）' : '⚠ 有壳为负'}`)
}

// ---------------------------------------------------------------------------
hdr('B-6 与仓库 meshStats 的交叉核对（我算的 vs 它算的）')
for (const r of rows) {
  const st = r.stat
  const same = st.boundaryEdges === r.n1 && (st.nonManifoldEdges === r.n3plus) && st.vertexCount === r.V && st.triangleCount === r.T
  console.log(`${r.base.padEnd(11)} res=${String(r.res).padStart(3)}  边界边 我=${r.n1} 它=${st.boundaryEdges} | 非流形边 我=${r.n3plus} 它=${st.nonManifoldEdges} | watertight 它=${st.watertight}  ${same ? '✅ 一致' : '❌ 不一致'}`)
}
console.log('')
console.log('说明：meshStats 的 bump() 用 key = min*2^21 + max。当顶点下标 ≥ 2^21 = 2097152 时')
console.log('      这个整数拼 key 会与另一条边碰撞 —— 小模型看不出来，超大模型会漏判。见 G 段。')

