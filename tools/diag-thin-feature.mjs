/**
 * 复现审查报告里那条 [高] 的端到端案例，并分析薄条的**连通性**。
 *
 * 它的案例：三视图 = 主体 + 一条**悬空**的 1px 薄条
 *   薄条厚 1px ⇒ 网格 Y 范围 1..81（薄条整条没了）
 *   薄条厚 2px ⇒ 网格 Y 范围 1..121（薄条在）
 *
 * 我要先弄清一件事：薄条在体素栅格里是**独立连通域**，还是与主体连在一起？
 * 这决定修法 ——
 *   独立连通域 ⇒ 可以"逐连通域判最大内部距离"来识别（简单可靠）
 *   与主体相连 ⇒ 需要局部窗口/形态学分析（复杂得多）
 */

import { silhouette, carve, distanceField, buildMesh } from '../src/core/geometry.js'

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
const view = (w, h, f) => silhouette(bitmap(w, h, f))

/**
 * 三视图 = 主体（下方，高 bodyH）+ 顶部一条悬空的横条（1px 或 stripH px）
 * 坐标系：图像 y 从上往下；世界 Y 从下往上。图像顶部 = 世界 Y 大。
 */
function makeViews({ bodyH = 80, gap = 39, stripH = 1, W = 120, D = 40 } = {}) {
  const H = bodyH + gap + stripH
  // 前视图：下方主体 + 顶部横条（中间留空 = 悬空）
  const front = view(W, H, (x, y) => {
    const fromTop = y
    const stripTop = 0
    const stripBottom = stripH - 1
    if (fromTop >= stripTop && fromTop <= stripBottom) return true   // 顶部薄条
    const bodyTop = stripH + gap
    return fromTop >= bodyTop                                         // 下方主体
  })
  const side = front   // 同轮廓（沿 Z 拉伸）
  const top = view(W, D, () => true)   // 俯视满矩形
  return { front, side, top }
}

/** 6-邻域连通域标记，返回 { labels, sizes, count } */
function labelClusters(occ, nx, ny, nz) {
  const labels = new Int32Array(occ.length).fill(-1)
  const sizes = []
  const S = nx, T = nx * ny
  let next = 0
  for (let start = 0; start < occ.length; start++) {
    if (!occ[start] || labels[start] >= 0) continue
    const id = next++
    let size = 0
    const stack = [start]
    labels[start] = id
    while (stack.length) {
      const p = stack.pop()
      size++
      const x = p % S
      const y = ((p / S) | 0) % ny
      const z = (p / T) | 0
      if (x > 0) v(p - 1)
      if (x < S - 1) v(p + 1)
      if (y > 0) v(p - S)
      if (y < ny - 1) v(p + S)
      if (z > 0) v(p - T)
      if (z < nz - 1) v(p + T)
      function v(q) {
        if (occ[q] && labels[q] < 0) { labels[q] = id; stack.push(q) }
      }
    }
    sizes.push(size)
  }
  return { labels, sizes, count: next }
}

console.log('=== 复现端到端案例 ===\n')

for (const stripH of [1, 2]) {
  const views = makeViews({ stripH })
  const vol = carve(views, { resolution: 120, padding: 0, smooth: 0 })
  const { occupied, nx, ny, nz } = vol

  // 各 j 层的实体数（看薄条在哪一层）
  const perLayer = []
  for (let j = 0; j < ny; j++) {
    let c = 0
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) c += occupied[(z * ny + j) * nx + x]
    perLayer.push(c)
  }
  const nonEmpty = perLayer.map((c, j) => [j, c]).filter(([, c]) => c > 0)
  const jMin = nonEmpty[0][0]
  const jMax = nonEmpty[nonEmpty.length - 1][0]
  // 找出所有"连续段"
  const runs = []
  let runStart = null
  for (let j = 0; j < ny; j++) {
    if (perLayer[j] > 0 && runStart === null) runStart = j
    if ((perLayer[j] === 0 || j === ny - 1) && runStart !== null) {
      runs.push([runStart, perLayer[j] > 0 ? j : j - 1])
      runStart = null
    }
  }

  const cl = labelClusters(occupied, nx, ny, nz)
  const { field } = distanceField(occupied, nx, ny, nz, { pad: 0 })

  // 逐连通域的最大"到最近空格的距离"（格）——即该域的局部厚度的一半
  const maxInsidePerCluster = new Array(cl.count).fill(0)
  for (let i = 0; i < occupied.length; i++) {
    if (!occupied[i]) continue
    const inside = -field[i] - 3   // field = -(inside + D1)
    if (inside > maxInsidePerCluster[cl.labels[i]]) maxInsidePerCluster[cl.labels[i]] = inside
  }

  const m = buildMesh(views, { resolution: 120, padding: 0, smooth: 0 })
  let gyMin = Infinity, gyMax = -Infinity
  for (let i = 1; i < m.positions.length; i += 3) {
    if (m.positions[i] < gyMin) gyMin = m.positions[i]
    if (m.positions[i] > gyMax) gyMax = m.positions[i]
  }

  console.log(`薄条厚 ${stripH}px：`)
  console.log(`  carve 网格 = ${nx}×${ny}×${nz}   实体数 = ${vol.filled}`)
  console.log(`  实体层的连续段（体素 j 区间）= ${JSON.stringify(runs)}`)
  console.log(`  连通域个数 = ${cl.count}，各域体素数 = ${JSON.stringify(cl.sizes)}`)
  console.log(`  各域"最大内部距离" = ${JSON.stringify(maxInsidePerCluster)}  （单位×3；3 ≈ 厚度 2 格）`)
  console.log(`  网格 Y 范围 = ${gyMin.toFixed(2)} .. ${gyMax.toFixed(2)}   三角形 = ${m.meta.triangleCount}`)
  console.log(`  ⇒ 薄条${runs.length > 1 ? '是否独立成段：是' : '是否独立成段：否'}；` +
    `薄条${cl.count > 1 ? '是独立连通域' : '与主体同属一个连通域'}`)
  console.log()
}
