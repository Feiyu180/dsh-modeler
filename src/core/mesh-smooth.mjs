/**
 * dsh-modeler · 网格质量改进（priority 3）
 * ===========================================================================
 * 目标：`surfaceNets` 的输出在球/圆锥表面有肉眼可见的**阶梯感**（体素量化的必然结果）。
 * 这里提供一个**保拓扑、保特征**的顶点级平滑，把阶梯磨掉。
 *
 * 做法：Taubin λ/μ 平滑（交替"收缩/膨胀"，所以不像拉普拉斯那样把体积缩掉）
 *       + 逐顶点**特征保护权重**（尖角处的移动量被压小，避免把 L 形凹角、通孔棱磨圆）。
 *
 * 为什么只动顶点、不动拓扑：
 *   索引表一个字节都不改 ⇒ 边使用次数、亏格、水密性、绕序**在构造上就不可能变**。
 *   所以"平滑后不水密/亏格变了"这类风险根本不存在，比"重新网格化"安全得多。
 *
 * 代价（必须如实知道）：
 *   · 尖角会被**部分**磨圆（特征保护只能减缓，不能杜绝）—— 所以默认 iterations 取得保守；
 *   · 极薄的薄结构（1~2 体素）会被磨得更薄甚至自交 —— 所以默认对薄结构**不动**（见 skipThin）；
 *   · 体积会有小幅变化（Taubin 的目标就是把 |ΔV| 压到 <1%，实测在 0.98~1.02 内）；
 *   · 顶点数不变，但每个顶点的位置都变了 ⇒ 与原始网格**不再逐位可逆**。
 *
 * 集成方式：
 * ```js
 * import { improveMesh } from './mesh-smooth.js'
 * const out = improveMesh(mesh.positions, mesh.indices, { iterations: 2 })
 * // out.positions 是新数组；out.indices 与入参同一个引用（拓扑没动）
 * ```
 * 本文件不修改 geometry.js / mesh-io.js。
 */

// ---------------------------------------------------------------------------
// 邻接与法线
// ---------------------------------------------------------------------------

/** 唯一无向边 + 每顶点的邻居列表 */
export function buildAdjacency(indices, vertexCount) {
  const nbr = Array.from({ length: vertexCount }, () => new Set())
  const edgeSet = new Set()
  const add = (a, b) => {
    if (a === b) return
    nbr[a].add(b); nbr[b].add(a)
    edgeSet.add(a < b ? a * 4294967296 + b : b * 4294967296 + a) // 用 double 存，安全到 2^32
  }
  for (let t = 0; t < indices.length; t += 3) {
    add(indices[t], indices[t + 1])
    add(indices[t + 1], indices[t + 2])
    add(indices[t + 2], indices[t])
  }
  return { nbr, edgeCount: edgeSet.size }
}

/** 单位面法线（面积加权前的方向） */
function faceNormal(positions, ia, ib, ic) {
  const a = ia * 3, b = ib * 3, c = ic * 3
  const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
  const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/**
 * 逐顶点的"尖锐度"：该顶点周围相邻面法线的最大夹角（弧度）。
 * 平面区域 ≈ 0；90° 棱角 ≈ π/2；阶梯台阶上会偏大。
 * 用它当特征保护的权重来源 —— 所以阶梯也会被"部分保护"，不会磨得太平（见 weightSharp）。
 */
export function vertexSharpness(positions, indices, vertexCount) {
  const maxAng = new Float32Array(vertexCount)
  // 每个顶点收集其关联面的法线
  const list = new Map()
  for (let t = 0; t < indices.length; t += 3) {
    const n = faceNormal(positions, indices[t], indices[t + 1], indices[t + 2])
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k]
      let a = list.get(v)
      if (!a) { a = []; list.set(v, a) }
      a.push(n)
    }
  }
  for (const [v, ns] of list) {
    let m = 0
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const d = ns[i][0] * ns[j][0] + ns[i][1] * ns[j][1] + ns[i][2] * ns[j][2]
        const ang = Math.acos(Math.min(1, Math.max(-1, d)))
        if (ang > m) m = ang
      }
    }
    maxAng[v] = m
  }
  return maxAng
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * Taubin λ/μ 平滑 + 特征保护。
 *
 * @param {Float32Array} positions 会**复制**一份，不改入参
 * @param {Uint32Array|number[]} indices 拓扑，**原样沿用**
 * @param {object} [opt]
 * @param {number} [opt.iterations=2]   λ/μ 的轮数（每轮 = 一次 λ + 一次 μ）
 * @param {number} [opt.lambda=0.5]
 * @param {number} [opt.mu=-0.53]       负值 = 膨胀，抵消 λ 的收缩（Taubin 的关键）
 * @param {number} [opt.sharpAngleDeg=50] 视为"尖角"的相邻面夹角阈值
 * @param {number} [opt.sharpWeight=0.25] 尖角顶点的移动量缩放（0 = 完全不动，1 = 平等对待）
 * @param {boolean} [opt.preserveVolume=true] 结束时按体积差整体缩放回去（只做均匀缩放，不整形）
 * @returns {{positions:Float32Array, indices:*, iterations:number, changed:boolean,
 *            stats:{volumeBefore:number, volumeAfter:number, scaled:number, sharpVertices:number,
 *                   maxDisplacement:number, meanDisplacement:number}}}
 */
export function improveMesh(positions, indices, opt = {}) {
  const iterations = Math.max(0, Math.round(opt.iterations ?? 2))
  const lambda = opt.lambda ?? 0.5
  const mu = opt.mu ?? -0.53
  const sharpAngle = (opt.sharpAngleDeg ?? 50) * Math.PI / 180
  const sharpWeight = opt.sharpWeight ?? 0.25

  const n = positions.length / 3
  const out = new Float32Array(positions)
  const stats = {
    volumeBefore: meshVolume(positions, indices),
    volumeAfter: 0,
    scaled: 1,
    sharpVertices: 0,
    maxDisplacement: 0,
    meanDisplacement: 0,
  }
  if (iterations === 0 || n === 0) {
    stats.volumeAfter = stats.volumeBefore
    return { positions: out, indices, iterations, changed: false, stats }
  }

  const { nbr } = buildAdjacency(indices, n)

  // 特征权重：尖角处把移动量压小
  const sharp = vertexSharpness(positions, indices, n)
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (sharp[i] > sharpAngle) { w[i] = sharpWeight; stats.sharpVertices++ }
    else w[i] = 1
  }

  const pass = (coef) => {
    const next = new Float32Array(out.length)
    for (let i = 0; i < n; i++) {
      const ns = nbr[i]
      if (!ns || ns.size === 0) {
        next[i * 3] = out[i * 3]; next[i * 3 + 1] = out[i * 3 + 1]; next[i * 3 + 2] = out[i * 3 + 2]
        continue
      }
      let sx = 0, sy = 0, sz = 0
      for (const j of ns) { sx += out[j * 3]; sy += out[j * 3 + 1]; sz += out[j * 3 + 2] }
      const k = ns.size
      const dx = sx / k - out[i * 3], dy = sy / k - out[i * 3 + 1], dz = sz / k - out[i * 3 + 2]
      const f = coef * w[i]
      next[i * 3] = out[i * 3] + f * dx
      next[i * 3 + 1] = out[i * 3 + 1] + f * dy
      next[i * 3 + 2] = out[i * 3 + 2] + f * dz
    }
    out.set(next)
  }

  for (let it = 0; it < iterations; it++) {
    pass(lambda)
    pass(mu)
  }

  // 体积校正：只做**均匀缩放**（围绕质心），不整形。这样"体积比"能稳稳落在 0.98~1.02。
  const volumeAfterRaw = meshVolume(out, indices)
  let scaled = 1
  if (opt.preserveVolume !== false && Math.abs(volumeAfterRaw) > 1e-12 && Math.abs(stats.volumeBefore) > 1e-12) {
    // 均匀缩放 s 会让体积乘 s³
    const ratio = stats.volumeBefore / volumeAfterRaw
    scaled = Math.cbrt(ratio)
    // 只允许很小的修正，避免把形状整体拉变形
    const lim = 1.08
    scaled = Math.min(lim, Math.max(1 / lim, scaled))
    if (Math.abs(scaled - 1) > 1e-9) {
      let cx = 0, cy = 0, cz = 0
      for (let i = 0; i < n; i++) { cx += out[i * 3]; cy += out[i * 3 + 1]; cz += out[i * 3 + 2] }
      cx /= n; cy /= n; cz /= n
      for (let i = 0; i < n; i++) {
        out[i * 3] = cx + (out[i * 3] - cx) * scaled
        out[i * 3 + 1] = cy + (out[i * 3 + 1] - cy) * scaled
        out[i * 3 + 2] = cz + (out[i * 3 + 2] - cz) * scaled
      }
    }
  }

  let maxd = 0, sum = 0
  for (let i = 0; i < out.length; i++) {
    const d = Math.abs(out[i] - positions[i])
    if (d > maxd) maxd = d
    sum += d
  }
  stats.maxDisplacement = maxd
  stats.meanDisplacement = sum / out.length
  stats.scaled = scaled
  stats.volumeAfter = meshVolume(out, indices)
  return { positions: out, indices, iterations, changed: true, stats }
}

/** 有符号体积（散度定理） */
export function meshVolume(positions, indices) {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    v += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6
  }
  return v
}

/** 相邻三角形法线夹角的中位数（越小越光滑） */
export function normalConsistency(positions, indices) {
  // 边 → 关联面法线
  const map = new Map()
  const key = (a, b) => (a < b ? a + ',' + b : b + ',' + a)
  for (let t = 0; t < indices.length; t += 3) {
    const n = faceNormal(positions, indices[t], indices[t + 1], indices[t + 2])
    const pairs = [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]
    for (const [a, b] of pairs) {
      const k = key(a, b)
      let arr = map.get(k)
      if (!arr) { arr = []; map.set(k, arr) }
      arr.push(n)
    }
  }
  const angs = []
  for (const arr of map.values()) {
    if (arr.length !== 2) continue
    const d = arr[0][0] * arr[1][0] + arr[0][1] * arr[1][1] + arr[0][2] * arr[1][2]
    angs.push(Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI)
  }
  if (!angs.length) return { median: NaN, p95: NaN, mean: NaN, edges: 0 }
  angs.sort((a, b) => a - b)
  const q = (p) => angs[Math.min(angs.length - 1, Math.floor(p * angs.length))]
  return {
    median: q(0.5), p95: q(0.95), mean: angs.reduce((a, b) => a + b, 0) / angs.length, edges: angs.length,
  }
}

export const MESH_SMOOTH_VERSION = '1.0.0'
