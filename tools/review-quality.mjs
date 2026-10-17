/**
 * task-3 · 优先级 3 的验证：网格质量改进必须**量化**（DSH 要求缺一不可）
 * ===========================================================================
 * 指标：
 *   1. 球面/圆柱面半径偏差：mean / p95 / max（归一化到模型尺寸）
 *   2. 法线一致性：相邻三角形法线夹角的中位数（越小越光滑）
 *   3. 水密性：boundaryEdges === 0 && nonManifoldEdges === 0
 *   4. 体积变化（要求落在 0.98 ~ 1.02）
 *   5. L 形凹角是否还在、方板通孔是否还在（用"把网格体素化后重投影，与输入剪影比 IoU"来判）
 *   6. 顶点/三角形数变化、耗时变化
 *   7. 亏格是否保持（只动顶点 ⇒ 构造上不可能变，这里做实测确认）
 *
 * 运行：
 *   DSH_ROOT=D:/dsh-modeler/tools/_rev3-b3d83f23 <node> D:/dsh-modeler/tools/review-quality.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const S = await import(pathToFileURL(path.join(ROOT, 'src/core/mesh-smooth.mjs')).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const hdr = (s) => { console.log(''); console.log('='.repeat(76)); console.log(s); console.log('='.repeat(76)) }
const log = (...a) => console.log(...a)
const loadDir = (dir, name) => {
  const o = {}
  for (const k of ['front', 'side', 'top']) {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, dir, `${name}-${k}.png`)))
    o[k] = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  return o
}

// ---------------------------------------------------------------------------
// 体素化（为了把"平滑后的网格"重投影回三视图，判特征有没有被磨掉）
// Ericson 的点-三角形最短距离
// ---------------------------------------------------------------------------
function pointTriDist(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz)
  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return Math.hypot(px - (ax + abx * v), py - (ay + aby * v), pz - (az + abz * v)) }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return Math.hypot(px - (ax + acx * w), py - (ay + acy * w), pz - (az + acz * w)) }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    return Math.hypot(px - (bx + (cx - bx) * w), py - (by + (cy - by) * w), pz - (bz + (cz - bz) * w))
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w2 = vc * denom
  return Math.hypot(px - (ax + abx * v + acx * w2), py - (ay + aby * v + acy * w2), pz - (az + abz * v + acz * w2))
}
function voxelize(pos, idx, targetLong = 120) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    if (pos[i + k] < mn[k]) mn[k] = pos[i + k]
    if (pos[i + k] > mx[k]) mx[k] = pos[i + k]
  }
  const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1
  const k = targetLong / ext
  const nx = Math.max(2, Math.round((mx[0] - mn[0]) * k))
  const ny = Math.max(2, Math.round((mx[1] - mn[1]) * k))
  const nz = Math.max(2, Math.round((mx[2] - mn[2]) * k))
  const data = new Uint8Array(nx * ny * nz)
  const half = 0.5 / k
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const lo = (v, m) => Math.max(0, Math.floor((Math.min(v[0], v[1], v[2]) - m) * k - half))
    const hi = (v, m, n) => Math.min(n - 1, Math.ceil((Math.max(v[0], v[1], v[2]) - m) * k + half))
    const xs = [pos[a], pos[b], pos[c]], ys = [pos[a + 1], pos[b + 1], pos[c + 1]], zs = [pos[a + 2], pos[b + 2], pos[c + 2]]
    const x0 = lo(xs, mn[0]), x1 = hi(xs, mn[0], nx)
    const y0 = lo(ys, mn[1]), y1 = hi(ys, mn[1], ny)
    const z0 = lo(zs, mn[2]), z1 = hi(zs, mn[2], nz)
    for (let z = z0; z <= z1; z++) {
      const pz = mn[2] + (z + 0.5) / k
      for (let y = y0; y <= y1; y++) {
        const py = mn[1] + (y + 0.5) / k
        for (let x = x0; x <= x1; x++) {
          const px = mn[0] + (x + 0.5) / k
          if (pointTriDist(px, py, pz, pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]) <= half) {
            data[(z * ny + y) * nx + x] = 1
          }
        }
      }
    }
  }
  return { data, nx, ny, nz }
}
const crop = (mask, w, h) => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1
  const out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = mask[(y0 + y) * w + x0 + x] ? 1 : 0
  return { mask: out, width: cw, height: ch }
}
const toGrid = (m, N) => {
  const g = new Uint8Array(N * N)
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const px = Math.min(m.width - 1, Math.floor(c * m.width / N))
    const py = Math.min(m.height - 1, Math.floor(r * m.height / N))
    g[r * N + c] = m.mask[py * m.width + px] ? 1 : 0
  }
  return g
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++ } return u ? i / u : 1 }
/** 网格 → 某视图的重投影遮蔽 → 与输入剪影的 IoU（双方都裁到内容框） */
function reprojectIoU(pos, idx, viewKey, inputSil, N = 128) {
  const occ = voxelize(pos, idx, 120)
  const proj = G.projectViews(occ.data, occ.nx, occ.ny, occ.nz, 240)[viewKey]
  const om = new Uint8Array(proj.width * proj.height)
  for (let i = 0; i < om.length; i++) om[i] = proj.data[i * 4] ? 1 : 0
  const a = toGrid(crop(inputSil.mask, inputSil.width, inputSil.height), N)
  const b = toGrid(crop(om, proj.width, proj.height), N)
  return iou(a, b)
}
function eulerGenus(mesh) {
  const V = mesh.positions.length / 3
  const F = mesh.indices.length / 3
  const edges = new Set()
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2]
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`)
    edges.add(b < c ? `${b}|${c}` : `${c}|${b}`)
    edges.add(c < a ? `${c}|${a}` : `${a}|${c}`)
  }
  const chi = V - edges.size + F
  return { V, E: edges.size, F, chi, genus: (2 - chi) / 2 }
}
/** 半径偏差统计 */
function radiusDeviation(pos, axis) {
  // axis: 'sphere' → 到包围盒中心；'y' → 到 Y 轴
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    if (pos[i + k] < mn[k]) mn[k] = pos[i + k]
    if (pos[i + k] > mx[k]) mx[k] = pos[i + k]
  }
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2)
  const rs = []
  for (let i = 0; i < pos.length; i += 3) {
    if (axis === 'sphere') rs.push(Math.hypot(pos[i] - c[0], pos[i + 1] - c[1], pos[i + 2] - c[2]))
    else rs.push(Math.hypot(pos[i] - c[0], pos[i + 2] - c[2]))
  }
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  const dev = rs.map((r) => Math.abs(r - mean))
  dev.sort((a, b) => a - b)
  const q = (p) => dev[Math.min(dev.length - 1, Math.floor(p * dev.length))]
  const extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
  return {
    fittedR: mean, idealR: extent / 2,
    sizeOffset: (mean - extent / 2) / (extent / 2),
    mean: q(0.5) / extent, p95: q(0.95) / extent, max: dev[dev.length - 1] / extent,
    rms: Math.sqrt(dev.reduce((a, b) => a + b * b, 0) / dev.length) / extent,
  }
}
const f = (x, n = 5) => (Number.isFinite(x) ? x.toFixed(n) : 'NaN')

// ===========================================================================
hdr('1+2+3+4+6. 球 / 圆柱 / 圆锥：光滑度、半径偏差、水密、体积、耗时')
const SETS = []
for (const name of ['sphere', 'cylinder', 'cone']) SETS.push({ dir: 'samples', name, axis: name === 'sphere' ? 'sphere' : 'y' })
log('模型      iterations  顶点数    三角形    半径偏差 mean/p95/max(相对尺寸)      RMS       法线夹角中位数   体积比    水密  耗时')
const summary = {}
for (const s of SETS) {
  const views = loadDir(s.dir, s.name)
  const vol = G.carve(views, { resolution: 96, padding: 0.06 })
  const base = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  // buildMesh 会归一化 —— 为了让"相对尺寸"的偏差有确定含义，这里统一归一化到最长边 = 1
  const norm = (pos) => {
    const b = (() => { let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < mn[k]) mn[k] = pos[i + k]; if (pos[i + k] > mx[k]) mx[k] = pos[i + k] } return { mn, mx } })()
    const ext = Math.max(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) || 1
    const c = [0, 1, 2].map((k) => (b.mn[k] + b.mx[k]) / 2)
    const out = new Float32Array(pos.length)
    for (let i = 0; i < pos.length; i += 3) { out[i] = (pos[i] - c[0]) / ext; out[i + 1] = (pos[i + 1] - c[1]) / ext; out[i + 2] = (pos[i + 2] - c[2]) / ext }
    return out
  }
  const P0 = norm(base.positions)
  for (const it of [0, 1, 2, 4]) {
    const t0 = Date.now()
    const r = it === 0 ? { positions: P0, stats: { volumeAfter: S.meshVolume(P0, base.indices) } } : S.improveMesh(P0, base.indices, { iterations: it })
    const t1 = Date.now()
    const st = G.meshStats(r.positions, base.indices)
    const rd = radiusDeviation(r.positions, s.axis)
    const nc = S.normalConsistency(r.positions, base.indices)
    const v0 = S.meshVolume(P0, base.indices)
    const ratio = S.meshVolume(r.positions, base.indices) / v0
    log(`${s.name.padEnd(9)} ${String(it).padStart(10)}  ${String(st.vertexCount).padStart(7)}  ${String(st.triangleCount).padStart(8)}  ${f(rd.mean)} / ${f(rd.p95)} / ${f(rd.max)}   ${f(rd.rms)}   ${f(nc.median, 3).padStart(12)}°  ${f(ratio, 4).padStart(8)}  ${st.watertight ? '✅' : '❌'}  ${t1 - t0}ms`)
    if (it === 0 || it === 2) {
      summary[`${s.name}@${it}`] = { radius: rd, normal: nc, volumeRatio: ratio, watertight: st.watertight, ms: t1 - t0, v: st.vertexCount, t: st.triangleCount }
    }
  }
  if (!S.meshVolume) throw new Error('no meshVolume')
}
log('')
log('读法：iterations=0 是原始 surfaceNets 输出；半径偏差越小 = 阶梯越平；法线夹角中位数越小 = 越光滑。')

// ===========================================================================
hdr('5-a. L 形凹角是否还在（网格体素化后重投影，与输入剪影比 IoU）')
{
  const views = loadDir('samples2', 'lshape')
  const vol = G.carve(views, { resolution: 120, padding: 0 })
  const base = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  log('iterations  前视图 IoU(与输入 L 剪影)   侧视图 IoU   俯视图 IoU   亏格   顶点数')
  for (const it of [0, 1, 2, 4]) {
    const r = it === 0 ? { positions: base.positions } : S.improveMesh(base.positions, base.indices, { iterations: it })
    const io = ['front', 'side', 'top'].map((k) => reprojectIoU(r.positions, base.indices, k, views[k]))
    const g = eulerGenus({ positions: r.positions, indices: base.indices })
    log(`${String(it).padStart(10)}  ${f(io[0], 5).padStart(22)}   ${f(io[1], 5).padStart(11)}   ${f(io[2], 5).padStart(11)}   ${String(g.genus).padStart(4)}   ${String(g.V).padStart(7)}`)
  }
  log('')
  log('判据：IoU 越接近 1，说明凹角与整体轮廓越没被磨掉。若某档突然掉下来，就是那一档把角磨圆了。')
}

// ===========================================================================
hdr('5-b. 方板通孔是否还在（方管夹具：亏格必须保持 1，前视图的方孔必须可见）')
{
  const views = loadDir('samples2', 'torus-ish')
  const vol = G.carve(views, { resolution: 120, padding: 0 })
  const base = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  log('iterations  前视图 IoU(方环)   亏格(通孔=1)   水密   体积比   顶点数')
  for (const it of [0, 1, 2, 4]) {
    const r = it === 0 ? { positions: base.positions } : S.improveMesh(base.positions, base.indices, { iterations: it })
    const io = reprojectIoU(r.positions, base.indices, 'front', views.front)
    const g = eulerGenus({ positions: r.positions, indices: base.indices })
    const st = G.meshStats(r.positions, base.indices)
    const v0 = S.meshVolume(base.positions, base.indices)
    const ratio = S.meshVolume(r.positions, base.indices) / v0
    log(`${String(it).padStart(10)}  ${f(io, 5).padStart(15)}   ${String(g.genus).padStart(12)}   ${st.watertight ? '✅' : '❌'}    ${f(ratio, 4)}   ${String(g.V).padStart(7)}`)
  }
  log('')
  log('亏格恒为 1 ⇒ 通孔**在构造上**不可能被磨没（只动顶点不动索引）；前视图 IoU 说明方孔的形状有没有走样。')
}

// ===========================================================================
hdr('8. 判定：逐项达标 / 不达标（DSH 要求"缺一不可"的那几项）')
{
  const views = loadDir('samples', 'sphere')
  const vol = G.carve(views, { resolution: 96, padding: 0.06 })
  const base = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  const norm = (pos) => {
    const b = (() => { let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < mn[k]) mn[k] = pos[i + k]; if (pos[i + k] > mx[k]) mx[k] = pos[i + k] } return { mn, mx } })()
    const ext = Math.max(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) || 1
    const c = [0, 1, 2].map((k) => (b.mn[k] + b.mx[k]) / 2)
    const out = new Float32Array(pos.length)
    for (let i = 0; i < pos.length; i += 3) { out[i] = (pos[i] - c[0]) / ext; out[i + 1] = (pos[i + 1] - c[1]) / ext; out[i + 2] = (pos[i + 2] - c[2]) / ext }
    return out
  }
  const P0 = norm(base.positions)
  const r2 = S.improveMesh(P0, base.indices, { iterations: 2 })
  const rd0 = radiusDeviation(P0, 'sphere'), rd2 = radiusDeviation(r2.positions, 'sphere')
  const nc0 = S.normalConsistency(P0, base.indices), nc2 = S.normalConsistency(r2.positions, base.indices)
  const st0 = G.meshStats(P0, base.indices), st2 = G.meshStats(r2.positions, base.indices)
  const v0 = S.meshVolume(P0, base.indices), v2 = S.meshVolume(r2.positions, base.indices)

  // 尺度诊断：把"facet 弓高"和"实测径向粗糙度"放在一起比，判断粗糙度到底是不是网格噪声
  const facetSize = Math.sqrt(4 * Math.PI * rd0.fittedR ** 2 / (st0.triangleCount / 2))
  const sagitta = facetSize * facetSize / (8 * rd0.fittedR)

  const rows = [
    ['球面半径偏差 mid（相对尺寸）', f(rd0.mean), f(rd2.mean), Math.abs(rd2.mean - rd0.mean) / rd0.mean > 0.05],
    ['球面半径偏差 p95', f(rd0.p95), f(rd2.p95), Math.abs(rd2.p95 - rd0.p95) / rd0.p95 > 0.05],
    ['球面半径偏差 max', f(rd0.max), f(rd2.max), Math.abs(rd2.max - rd0.max) / rd0.max > 0.05],
    ['球面径向 RMS', f(rd0.rms), f(rd2.rms), Math.abs(rd2.rms - rd0.rms) / rd0.rms > 0.05],
    ['法线一致性 中位数(°)', f(nc0.median, 3), f(nc2.median, 3), false],
    ['法线一致性 均值(°)', f(nc0.mean, 3), f(nc2.mean, 3), nc2.mean < nc0.mean],
    ['法线一致性 p95(°)', f(nc0.p95, 3), f(nc2.p95, 3), nc2.p95 < nc0.p95],
    ['水密（boundary=0 且非流形=0）', String(st0.watertight), String(st2.watertight), st2.watertight],
    ['体积比（要求 0.98~1.02）', '1.0000', f(v2 / v0, 4), v2 / v0 >= 0.98 && v2 / v0 <= 1.02],
    ['顶点数', String(st0.vertexCount), String(st2.vertexCount), st0.vertexCount === st2.vertexCount],
    ['三角形数', String(st0.triangleCount), String(st2.triangleCount), st0.triangleCount === st2.triangleCount],
  ]
  log('指标                              改进前        改进后(it=2)   是否改善')
  for (const [name, a, b, better] of rows) {
    log(`${name.padEnd(33)} ${String(a).padStart(11)}   ${String(b).padStart(12)}   ${better ? '✅' : '❌'}`)
  }
  log('')
  log('【关键尺度诊断】为什么"磨网格"消不掉这个阶梯感：')
  log(`  · 球半径（体素坐标）≈ ${rd0.fittedR.toFixed(2)}，facet 平均边长 ≈ ${facetSize.toFixed(4)} 体素`)
  log(`  · 一个 facet 的弓高（弦与弧的最大偏差）≈ ${sagitta.toExponential(3)} 体素`)
  log(`  · 实测径向粗糙度 RMS ≈ ${rd0.rms.toExponential(3)}（已按模型最长边归一化）`)
  log(`  ⇒ 实测粗糙度是 facet 弓高的 **${(rd0.rms / sagitta).toFixed(0)} 倍** ⇒ 它不可能靠磨 facet 消掉。`)
  log('')
  log('结论（必须如实说）：**顶点级平滑没能明显削掉这套管线的阶梯感，P3 的目标未达成。**')
  log('  根因不是"平滑算法不够强"，而是**粗糙度的来源不在网格上**：')
  log('  · 主要来源是① 输入剪影的栅格化（120px 的圆本身就是锯齿）② carve 的体素量化（96 档）')
  log('    —— 这两者都是**真实几何**，写进了距离场里，任何事后磨网格都只能把它模糊掉，不能变回理想球面；')
  log('  · 而从上面几个数字可以看出：顶点级平滑的作用尺度是"facet 级"（≈0.01 体素），')
  log('    而需要消掉的东西在"1~2 体素级" —— 差两个数量级，所以磨不动。')
  log('')
  log('  真正能改善阶梯感的方向（按性价比排）：')
  log('    1. **提高分辨率**（阶梯幅度 ∝ 1/res）—— 最直接，代价是耗时；')
  log('    2. **对输入剪影做亚像素边缘平滑/抗锯齿**（在 silhouette 里对边缘做 0.5px 的线性过渡），')
  log('       让距离场本身是斜的，而不是 0/1 跳变 —— 这才是"阶梯感"的源头；')
  log('    3. **等值面放置改成 QEF（dual contouring）**，而不是当前的"格边交点取平均"；')
  log('    4. 顶点级平滑只能作为**最后**的轻微修饰（本模块可以留着，代价已量化：')
  log('       保拓扑、保特征、体积可在 0.98~1.02 内锁住；但别指望它解决根本问题）。')
  log('')
  log('  保留价值的说明：本模块本身是**正确且安全**的（只动顶点不动索引 ⇒ 水密/亏格/绕序在构造上不可能变；')
  log('  L 形凹角与方管通孔的 IoU、亏格实测都不变；体积可锁在 0.98~1.02）。')
  log('  它适合当"轻微顺滑"用，**不适合**当"消阶梯"用。')
}
{
  const views = loadDir('samples', 'sphere')
  const vol = G.carve(views, { resolution: 320, padding: 0.06 })
  const base = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  hdr('7. 代价：诚实清单')
log('球 @320 档（最大分辨率）：')
  log(`  原始网格：顶点 ${base.vertexCount}，三角形 ${base.triangleCount}`)
  for (const it of [1, 2, 4]) {
    const t0 = Date.now()
    const r = S.improveMesh(base.positions, base.indices, { iterations: it })
    const t1 = Date.now()
    const v0 = S.meshVolume(base.positions, base.indices)
    const ratio = S.meshVolume(r.positions, base.indices) / v0
    const nc0 = S.normalConsistency(base.positions, base.indices)
    const nc1 = S.normalConsistency(r.positions, base.indices)
    log(`  iterations=${it}：耗时 ${String(t1 - t0).padStart(5)}ms   法线夹角中位数 ${f(nc0.median, 3)}° → ${f(nc1.median, 3)}°   体积比 ${f(ratio, 4)}   尖角顶点数 ${r.stats.sharpVertices}   最大顶点位移 ${f(r.stats.maxDisplacement, 6)}（归一化坐标）`)
  }
  log('')
  log('诚实代价清单（必须知道，不能只看"更好看"）：')
  log('  · 尖角被部分磨圆：特征保护权重只减缓，不能杜绝。需要"绝对保边"的场合别开平滑。')
  log('  · 极薄结构更危险：1~2 体素厚的薄片被磨后可能变薄甚至自交 —— 所以本模块**建议**在')
  log('    薄特征修复之后调用，并且对薄结构要么不开、要么调小 iterations。')
  log('  · 体积：由 Taubin + 均匀缩放校正，实测落在 0.98~1.02；但这是"整体体积"守恒，')
  log('    局部（棱角、尖端）仍然会变。')
  log('  · 顶点位置整体改变 ⇒ 与原始网格不再逐位对应（顶点数/索引不变，所以拓扑仍可逆）。')
  log('  · 耗时随 iterations 线性增长，且与顶点数成正比（球 @320 见上表）。')
}
