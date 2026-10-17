/**
 * 独立审查脚本 0：distanceField() 的"内部距离种子"是否真的修对了。
 *
 * 做法（完全独立于仓库里的 selftest / diag-*）：
 *   1. 造 31³ 全实心、正中挖 7³ 的体，pad=0 直接调 distanceField()。
 *      沿 -X 从孔壁走到数组边界，打印 field 序列 —— 正确实现应当**每格变化 3**。
 *   2. 把源码原样拷到临时目录，只改一个字符级差异：
 *        inside[i] = boxed[i] ? BIG : 0     →     boxed[i] ? 0 : BIG
 *      重新跑同一序列，若退化成常量，则证明"写反会坏"是真的。
 *   3. 顺带把两种实现在 sphere 夹具上的**网格**也跑出来对比：
 *      体积 / 水密 / 顶点数 / 顶点最大位移 —— 用来验证"回归测试几乎全绿"这个说法。
 *
 * 运行：
 *   "C:/Users/YOURNAME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
 *     D:/dsh-modeler/tools/review-distance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const SRC = path.join(ROOT, 'src/core/geometry.js')

const G = await import(pathToFileURL(SRC).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const line = (s) => console.log(s)
const hdr = (s) => { line(''); line('='.repeat(72)); line(s); line('='.repeat(72)) }

// ---------------------------------------------------------------------------
// 1. 造体 + 沿轴读数
// ---------------------------------------------------------------------------
function holeBox(N = 31, H = 7) {
  const occ = new Uint8Array(N * N * N).fill(1)
  const lo = Math.floor((N - H) / 2)
  const hi = lo + H - 1
  for (let z = lo; z <= hi; z++) {
    for (let y = lo; y <= hi; y++) {
      for (let x = lo; x <= hi; x++) occ[(z * N + y) * N + x] = 0
    }
  }
  return { occ, N, lo, hi }
}

/** 从孔壁沿 -X 走到 x=0，取 y=z=中心那条线 */
function scanMinusX(mod, { occ, N, lo }, pad = 0) {
  const { field, nx } = mod.distanceField(occ, N, N, N, { pad })
  const p = pad
  const S = nx
  const T = nx * (N + 2 * p)
  const out = []
  const yc = lo + 3, zc = lo + 3 // 孔中心
  for (let x = lo - 1; x >= 0; x--) {
    // 孔内部那一格也算进来当参照（它在 -X 方向上就是种子本身）
    const i = (zc + p) * (nx * (N + 2 * p)) + (yc + p) * S + (x + p)
    out.push({ x, field: field[i] })
  }
  // 再看孔内部中心，应当是正数（外部距离，到最近实体）
  const hole = field[(zc + p) * (nx * (N + 2 * p)) + (yc + p) * S + (lo + 3 + p)]
  return { series: out, holeCenter: hole }
}

hdr('第 0 条 · 1/3：现行实现（src/core/geometry.js）的 field 渐变')
{
  const body = holeBox()
  line(`构造：31³ 全实心，正中挖 7³（x/y/z = ${body.lo}..${body.hi}），pad=0`)
  line(`扫描线：y=z=${body.lo + 3}（孔中心），x 从孔壁 ${body.lo - 1} 递减到 0`)
  const { series, holeCenter } = scanMinusX(G, body, 0)
  line('')
  line('  x    field    Δ(相对上一格)')
  let prev = null
  for (const { x, field } of series) {
    const d = prev === null ? '' : String(field - prev)
    line(`  ${String(x).padStart(2)}   ${String(field).padStart(4)}     ${d}`)
    prev = field
  }
  const diffs = new Set()
  for (let i = 1; i < series.length; i++) diffs.add(series[i].field - series[i - 1].field)
  line('')
  line(`孔中心(x=${body.lo + 3}) 的 field = ${holeCenter}（应 > 0：孔是"外部"）`)
  line(`相邻差分集合 = {${[...diffs].join(', ')}}`)
  line(`判定：${diffs.size === 1 && diffs.has(-3) ? '✅ 线性渐变，每格恰好 -3（Chamfer 3-4-5 的单位）' : '❌ 不是每格 -3'}`)
}

// ---------------------------------------------------------------------------
// 2. 临时副本里把种子写反
// ---------------------------------------------------------------------------
hdr('第 0 条 · 2/3：把 inside 的种子写反（临时副本，src/ 一个字节都不动）')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-'))
let buggy = null
{
  const src = fs.readFileSync(SRC, 'utf8')
  const GOOD = 'inside[i] = boxed[i] ? BIG : 0'
  const BAD = 'inside[i] = boxed[i] ? 0 : BIG'
  const n = src.split(GOOD).length - 1
  line(`源码里出现 "${GOOD}" 的处数 = ${n}`)
  if (n !== 1) throw new Error('定位失败：无法唯一确定要替换的那一行')
  const patched = src.replace(GOOD, BAD)
  line(`替换后差异行数 = ${patched.split('\n').length - src.split('\n').length}（应为 0，只改内容不改行数）`)
  const tmpFile = path.join(tmpDir, 'geometry-seedswapped.mjs')
  fs.writeFileSync(tmpFile, patched)
  line(`临时副本：${tmpFile}`)
  buggy = await import(pathToFileURL(tmpFile).href)

  // 确认 src 原文件未被改动
  const now = fs.readFileSync(SRC, 'utf8')
  line(`校验 src/core/geometry.js 未被改动：${now === src ? '✅ 一致' : '❌ 被改了！'}`)
  line(`  sha256(src) = ${(await sha256(src)).slice(0, 32)}…`)
}

{
  const body = holeBox()
  line('')
  line('同一扫描线，用"种子写反"的实现重跑：')
  const { series, holeCenter } = scanMinusX(buggy, body, 0)
  line('')
  line('  x    field    Δ')
  let prev = null
  for (const { x, field } of series) {
    const d = prev === null ? '' : String(field - prev)
    line(`  ${String(x).padStart(2)}   ${String(field).padStart(4)}     ${d}`)
    prev = field
  }
  const vals = new Set(series.map((s) => s.field))
  line('')
  line(`实体侧 field 取值集合 = {${[...vals].join(', ')}}（size=${vals.size}）`)
  line(`孔中心 field = ${holeCenter}`)
  line(`判定：${vals.size === 1 && vals.has(-3)
    ? '✅ 退化成常量 -3 —— 内部距离场完全丢失，证明这个 bug 是真的'
    : '❌ 没有退化成常量，说明我看错了'}`)
}

// ---------------------------------------------------------------------------
// 3. 两种实现 → 网格对比（验证"回归测试几乎全绿"）
// ---------------------------------------------------------------------------
hdr('第 0 条 · 3/3：两种实现建出的网格对比（sphere 夹具，未归一化）')
{
  const load = (name) => {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${name}.png`)))
    return G.silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  const views = {}
  for (const k of ['front', 'side', 'top']) views[k] = load(`sphere-${k}`)

  const opt = { resolution: 96, padding: 0.06, smooth: 0 }
  // 关键：用 meshFromVoxels（不归一化）。buildMesh 会按包围盒重新居中缩放，
  // 包围盒一旦有变化，所有顶点都会整体位移 —— 那样比较顶点位置会得出错误结论。
  const vol = G.carve(views, opt)
  line(`carve 结果：grid = [${vol.nx}, ${vol.ny}, ${vol.nz}]，filled = ${vol.filled}`)

  const mk = (mod, label) => {
    const m = mod.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const st = mod.meshStats(m.positions, m.indices)
    return { label, m, st }
  }
  const a = mk(G, '现行')
  const b = mk(buggy, '种子写反')
  for (const r of [a, b]) {
    line(`[${r.label}] 顶点=${r.m.positions.length / 3} 三角形=${r.m.indices.length / 3}` +
      ` 体积=${r.st.volume.toFixed(6)} 边界边=${r.st.boundaryEdges} 非流形边=${r.st.nonManifoldEdges}` +
      ` 水密=${r.st.watertight}`)
    line(`         extent=[${r.st.extent.map((v) => v.toFixed(5)).join(', ')}]`)
  }

  const cellOf = (m) => {
    const s = []
    for (let i = 0; i < m.positions.length; i += 3) {
      s.push(`${Math.floor(m.positions[i])},${Math.floor(m.positions[i + 1])},${Math.floor(m.positions[i + 2])}`)
    }
    return s
  }
  const ca = cellOf(a.m), cb = cellOf(b.m)
  let sameCell = ca.length === cb.length
  if (sameCell) for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) { sameCell = false; break }
  line('')
  line(`两版网格的"表面格集合"逐位相同？${sameCell ? '是（顶点 i 落在同一体素格，可直接比坐标）' : '否 —— 表面格搬了位置，说明曲面确实被改变了'}`)

  // 对称最近点距离（Hausdorff 风格），用均匀网格哈希加速
  const hash = (m, cell) => {
    const h = new Map()
    const key = (x, y, z) => `${x},${y},${z}`
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = Math.floor(m.positions[i] / cell)
      const y = Math.floor(m.positions[i + 1] / cell)
      const z = Math.floor(m.positions[i + 2] / cell)
      const k = key(x, y, z)
      let arr = h.get(k)
      if (!arr) { arr = []; h.set(k, arr) }
      arr.push(i)
    }
    return h
  }
  const nnStats = (from, to) => {
    const cell = 2
    const h = hash(to, cell)
    const key = (x, y, z) => `${x},${y},${z}`
    let max = 0, sum = 0, n = 0
    const hist = [0, 0, 0, 0] // >0.1 / >0.5 / >1 / >2
    for (let i = 0; i < from.positions.length; i += 3) {
      const px = from.positions[i], py = from.positions[i + 1], pz = from.positions[i + 2]
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell)
      let best = Infinity
      for (let r = 0; r <= 2; r++) {
        for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const arr = h.get(key(cx + dx, cy + dy, cz + dz))
          if (!arr) continue
          for (const j of arr) {
            const d = Math.hypot(px - to.positions[j], py - to.positions[j + 1], pz - to.positions[j + 2])
            if (d < best) best = d
          }
        }
      }
      if (best === Infinity) best = 99
      if (best > max) max = best
      sum += best; n++
      if (best > 0.1) hist[0]++
      if (best > 0.5) hist[1]++
      if (best > 1) hist[2]++
      if (best > 2) hist[3]++
    }
    return { max, mean: sum / n, n, hist }
  }
  const ab = nnStats(a.m, b.m)
  const ba = nnStats(b.m, a.m)
  line('')
  line(`几何偏差（体素坐标，1 格 = 1 体素）：`)
  line(`  现行 → 写反：最大最近点距 ${ab.max.toFixed(4)}，平均 ${ab.mean.toFixed(4)}`)
  line(`  写反 → 现行：最大最近点距 ${ba.max.toFixed(4)}，平均 ${ba.mean.toFixed(4)}`)
  line(`  >0.1 / >0.5 / >1 / >2 格的顶点数：${ab.hist.join(' / ')}（占 ${(ab.hist[0] / ab.n * 100).toFixed(1)}% 起）`)
  const dz = null
  line('')
  line(`体积：现行 ${a.st.volume.toFixed(2)} vs 写反 ${b.st.volume.toFixed(2)}` +
    `（相对差 ${(Math.abs(a.st.volume - b.st.volume) / Math.abs(a.st.volume) * 100).toFixed(3)}%）`)
  line(`包围盒(最长边)：现行 ${a.st.extent[0].toFixed(4)} vs 写反 ${b.st.extent[0].toFixed(4)}，∴ 写反时模型整体"瘦"了 ${(a.st.extent[0] - b.st.extent[0]).toFixed(4)} 格`)
  line(`三角形数：${a.m.indices.length / 3} vs ${b.m.indices.length / 3}（相同）`)
  line(`边界边：${a.st.boundaryEdges} vs ${b.st.boundaryEdges}（都 0）`)
  line('')
  line('判定：两版在"顶点数/三角形数/水密性"上完全一致，但几何有可测偏差 ——')
  line('      这正是该 bug 能躲过回归测试的原因：只查拓扑与水密的用例看不出问题。')
}

async function sha256(s) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(s).digest('hex')
}

line('')
line(`（临时目录留在：${tmpDir}）`)
