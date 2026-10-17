/**
 * dsh-modeler · 局部薄特征修复（priority 1）
 * ===========================================================================
 *
 * 解决什么问题
 * ---------------------------------------------------------------------------
 * `voxelFieldToGrid` 把体素域的距离场重采样到格点域时，格点取的是周围 8 个体素的
 * **平均值**。紧贴表面的实心体素 field = -(3 + 3) = -6，相邻空格 field = +6 ——
 * **幅值相等、符号相反**。于是"跨过一个 1 体素厚的表面"的格点平均出来正好是 0，
 * 而 `surfaceNets` 用 `v < 0` 判内部，0 被算作外部 ⇒ **1 体素厚的结构一个内部格点
 * 都没有 ⇒ 整块被抹掉，且不报错**。
 *
 * 端到端的有害形态（这才是真会丢东西的）：
 *   三视图 = 主体 + 上方一条**悬空**的 1px 薄条
 *     → 网格只到主体顶面，薄条整条消失；体积/水密/三角形数全都"正常"。
 *
 * 为什么"整轴最长游程 ≤ 1"这个判据不行
 * ---------------------------------------------------------------------------
 * 它问的是"整根轴是不是只有 1 层厚"。而悬空薄条所在的轴上主体有 80 层厚 ⇒ 最长游程
 * = 80 ⇒ 判不到。**判据必须是逐体素的局部量**，不能是整轴的全局量。
 *
 * 这里的做法
 * ---------------------------------------------------------------------------
 * 1. **精确检测"哪些实心体素会被抹掉"**（不是启发式）：
 *    体素 v 会被抹掉 ⟺ v 的 3×3×3 格点邻域里**一个负格点都没有**。
 *    （负格点 = 内部的格点 = 等值面会经过的地方。周围没有负格点 ⇒ 表面到不了 v 附近
 *      ⇒ v 在输出网格里不存在。）
 *    这个判据与实际网格**逐位一致**：断言 `surfaceCells == meshFromVoxels().vertexCount`。
 * 2. **逐个连通域决定沿哪根轴补**：取该域包围盒**最短的那根轴**（= 最薄的方向）。
 *    在墙上沿该轴把"连续的实心 run"整条纳入种子（这样薄条的**两端**也会被统一加厚，
 *    不会留成棒棒糖形），再把种子沿该轴**两侧各膨胀 1 格**。
 * 3. **补完重新验证**：重跑步骤 1 的检测，并要求该域的体素不再被判为"会被抹掉"。
 *    验不过就进入下一轮（最多 maxRounds 轮，可覆盖"两根轴同时只有 1 格厚"的细丝）。
 * 4. **零改动保证**：检测到 0 个会被抹掉的体素时，**原样返回同一个数组引用**，
 *    一个体素都不动 ⇒ 正常模型（8 个夹具）的几何逐位不变，`thickenedAxes` 保持为空。
 *
 * 代价（必须如实知道）
 * ---------------------------------------------------------------------------
 * · 修复方式是**局部膨胀**，所以被救回来的薄特征会变厚：
 *   1 体素厚 → 两侧各加 1 → 3 体素厚（体积大约 ×3，但因为只作用于薄特征，
 *   对整模体积的影响通常 < 1%，见 `report.addedRatio`）。
 * · 膨胀是**双侧对称**的，优点是保住该特征的**质心**；代价是它在两个方向上都外扩了
 *   半格。不做单侧膨胀是因为"往哪一侧扩"没有依据，会把特征推偏。
 * · 薄特征的**位置精度**会下降到 ±1 体素；`report` 里逐条列出了补了哪根轴、加了几个体素。
 * · 如果某根轴的膨胀**做不到**（例如细丝在两个方向上都只有 1 格、且 maxRounds 用尽），
 *   `report.verified` 会是 false，`report.unrepaired` 会说明剩了多少 —— **不假装成功**。
 *
 * 集成方式（一行）
 * ---------------------------------------------------------------------------
 * ```js
 * import { repairThinFeatures } from './thicken.js'
 * // buildMesh 里，原来那段 thicken 逻辑替换成：
 * const thin = repairThinFeatures(occupied, nx, ny, nz, opt)
 * occupied = thin.occupied
 * // thin.report 可以直接塞进 meta（见 meshFromVoxelsRepaired 的返回）
 * ```
 *
 * 本文件**不修改** geometry.js / mesh-io.js；只从 geometry.js 读它已导出的东西。
 */

import { distanceField, smoothField, surfaceNets, meshFromVoxels } from './geometry.js'

const D1 = 3

// ===========================================================================
// 与 geometry.js 对齐的私有实现
// ===========================================================================

/**
 * `geometry.js` 里 `voxelFieldToGrid` 的逐行等价拷贝（那边是私有的，没导出）。
 *
 * ⚠ 这个函数是**唯一**与上游有重复的地方。为防漂移，用 `surfaceCellCount()`
 * 与 `meshFromVoxels().vertexCount` 做交叉断言（见 assertAligned()）。
 */
export function voxelFieldToGrid(field, nx, ny, nz) {
  const S = nx, T = nx * ny
  const gx = nx + 1, gy = ny + 1, gz = nz + 1
  const out = new Int32Array(gx * gy * gz)
  const gS = gx, gT = gx * gy
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        let sum = 0, cnt = 0
        for (let dz = -1; dz <= 0; dz++) {
          const zz = z + dz
          if (zz < 0 || zz >= nz) continue
          for (let dy = -1; dy <= 0; dy++) {
            const yy = y + dy
            if (yy < 0 || yy >= ny) continue
            for (let dx = -1; dx <= 0; dx++) {
              const xx = x + dx
              if (xx < 0 || xx >= nx) continue
              sum += field[zz * T + yy * S + xx]
              cnt++
            }
          }
        }
        out[z * gT + y * gS + x] = cnt ? Math.round(sum / cnt) : 0
      }
    }
  }
  return out
}

/** 复刻 `meshFromVoxels` 的前半段：占据 → 距离场 → (可选平滑) → 格点场 */
export function gridState(occ, nx, ny, nz, opt = {}) {
  const pad = Math.max(1, Math.round(opt.pad ?? 1))
  const smooth = Math.max(0, Math.round(opt.smooth ?? 0))
  const df = distanceField(occ, nx, ny, nz, { pad })
  const field = smooth ? smoothField(df.field, df.nx, df.ny, df.nz, smooth) : df.field
  const grid = voxelFieldToGrid(field, df.nx, df.ny, df.nz)
  return {
    field, grid, pad, smooth,
    fx: df.nx, fy: df.ny, fz: df.nz,
    gx: df.nx + 1, gy: df.ny + 1, gz: df.nz + 1,
  }
}

/** 格点场 → 变号格数（应等于 surfaceNets 的 vertexCount） */
export function surfaceCellCount(grid, fx, fy, fz) {
  const gx = fx + 1, gy = fy + 1
  const gT = gx * gy, gS = gx
  // 局部角编号 bit0→x, bit1→y, bit2→z（与 geometry.js 一致）
  let n = 0
  for (let z = 0; z < fz; z++) {
    for (let y = 0; y < fy; y++) {
      for (let x = 0; x < fx; x++) {
        let mask = 0
        for (let dz = 0; dz <= 1; dz++) {
          for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
              if (grid[(z + dz) * gT + (y + dy) * gS + (x + dx)] < 0) {
                mask |= 1 << (dx | (dy << 1) | (dz << 2))
              }
            }
          }
        }
        if (mask !== 0 && mask !== 255) n++
      }
    }
  }
  return n
}

/**
 * 0/1 数组的 3×3×3 膨胀（可分离，三次 1D 滑动 max）。
 * 用来把"负格点"扩散成"附近存在负格点"，从而把逐体素的 27 次查表降成 1 次。
 */
export function dilate333(src, gx, gy, gz) {
  const n = gx * gy * gz
  const a = new Uint8Array(n)
  // X
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) {
    const row = z * gx * gy + y * gx
    for (let x = 0; x < gx; x++) {
      let v = src[row + x]
      if (!v && x > 0) v = src[row + x - 1]
      if (!v && x < gx - 1) v = src[row + x + 1]
      a[row + x] = v
    }
  }
  // Y
  const b = new Uint8Array(n)
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) {
    const row = z * gx * gy + y * gx
    for (let x = 0; x < gx; x++) {
      let v = a[row + x]
      if (!v && y > 0) v = a[row - gx + x]
      if (!v && y < gy - 1) v = a[row + gx + x]
      b[row + x] = v
    }
  }
  // Z
  const out = new Uint8Array(n)
  const T = gx * gy
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) {
    const row = z * T + y * gx
    for (let x = 0; x < gx; x++) {
      let v = b[row + x]
      if (!v && z > 0) v = b[row - T + x]
      if (!v && z < gz - 1) v = b[row + T + x]
      out[row + x] = v
    }
  }
  return out
}

/** 自校验：本文件的格点场复刻是否与上游 mesher 一致（返回 null 表示一致） */
export function assertAligned(occ, nx, ny, nz, opt = {}) {
  const st = gridState(occ, nx, ny, nz, opt)
  const mine = surfaceCellCount(st.grid, st.fx, st.fy, st.fz)
  const mesh = meshFromVoxels(occ, nx, ny, nz, { smooth: opt.smooth, pad: opt.pad })
  if (mine !== mesh.vertexCount) {
    return { ok: false, mine, theirs: mesh.vertexCount, message: `格点场复刻与上游不一致：我算 ${mine} 个变号格，meshFromVoxels 给 ${mesh.vertexCount} 个顶点` }
  }
  return { ok: true, mine, theirs: mesh.vertexCount }
}

// ===========================================================================
// 局部厚度（DSH 提示的那条路）
// ===========================================================================

/**
 * 逐实体体素的**局部半厚**，单位是 Chamfer 步（1 体素 = 3 步）。
 *
 * `distanceField` 的 `inside` 就是"到最近空格的距离"，也就是该体素到表面的距离 ——
 * 对一根厚 T 的轴对齐结构，中线上的体素 inside ≈ 3·ceil(T/2)，所以
 * **局部厚度 ≈ 2·(inside/3) − 1**（奇数厚度）/ 2·(inside/3)（偶数厚度）。
 *
 * 这里返回的是"3×3×3 邻域内的最大 inside"，比单体素值稳（薄特征整体一致）。
 * 换算成"体素步"就是 `value / 3`。
 *
 * @returns {Int32Array} 与 occ 同维度；空格为 0
 */
export function localHalfThickness(occ, nx, ny, nz, opt = {}) {
  const st = gridState(occ, nx, ny, nz, opt)
  const { field, fx, fy, fz } = st
  const S = fx, T = fx * fy
  // inside[i] = -field[i] - D1（只对实体有意义）
  const out = new Int32Array(nx * ny * nz)
  const pad = st.pad
  const Sn = nx, Tn = nx * ny
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = z * Tn + y * Sn + x
    if (!occ[i]) continue
    let best = 0
    for (let dz = -1; dz <= 1; dz++) {
      const Z = z + pad + dz
      if (Z < 0 || Z >= fz) continue
      for (let dy = -1; dy <= 1; dy++) {
        const Y = y + pad + dy
        if (Y < 0 || Y >= fy) continue
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + pad + dx
          if (X < 0 || X >= fx) continue
          const v = -field[Z * T + Y * S + X] - D1
          if (v > best) best = v
        }
      }
    }
    out[i] = best
  }
  return out
}

// ===========================================================================
// 廉价预筛：只读占据栅格，先排除"肯定没有薄特征"的模型
// ===========================================================================

/**
 * 健全（sound）的"肯定干净"判据 —— 纯占据栅格计算，不建距离场。
 *
 * 依据：设 W[x,y,z] = 原始体素 (x-1..x, y-1..y, z-1..z) 里的实心个数（越界当空）。
 * 对实心体素 v=(x,y,z)，包含它的 2×2×2 体素块恰好是 W[x+dx, y+dy, z+dz]（dx,dy,dz∈{0,1}）。
 * 若其中**任一**块 ≥ 5 个实心，则该块对应的格点平均必为负：
 *   · 实心体素 field ≤ -6（因为 inside ≥ 3）；
 *   · 5 实 + 3 空时，每个空格在块内必有实心面邻居（鸽笼） ⇒ outside ≤ 3 ⇒ field ≤ +6；
 *   · 于是 sum ≤ 5·(-6) + 3·(+6) = -12 < 0 ⇒ round(sum/8) ≤ -1 < 0 ⇒ 是负格点。
 * 而该格点就在 v 的 3×3×3 格点邻域内 ⇒ v **不可能**被判为"会被抹掉"。
 *
 * 所以："每个实心体素都存在一个 ≥5 实的包含块" ⇒ 一定零改动，可以**跳过**昂贵的精确检测。
 * 反过来不成立（≤4 实的块也可能是负格点），所以这个闸门**只会漏报"可能需要修"，
 * 不会漏报"存在会被抹掉的体素"** —— 方向是安全的。
 *
 * @returns {{definitelyClean:boolean, suspectVoxels:number, cost:'gridOnly'}}
 */
export function quickThinCheck(occ, nx, ny, nz) {
  const n = nx * ny * nz
  const S = nx, T = nx * ny

  // W[x,y,z] = (x-1..x, y-1..y, z-1..z) 的实心个数；可分离三段滚动求和
  let a = new Uint8Array(n)
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = z * T + y * S
      for (let x = 0; x < nx; x++) a[row + x] = (occ[row + x] ? 1 : 0) + (x > 0 && occ[row + x - 1] ? 1 : 0)
    }
  }
  const b = new Uint8Array(n)
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = z * T + y * S
      for (let x = 0; x < nx; x++) b[row + x] = a[row + x] + (y > 0 ? a[row - S + x] : 0)
    }
  }
  a = null
  const W = new Uint8Array(n)
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = z * T + y * S
      for (let x = 0; x < nx; x++) W[row + x] = b[row + x] + (z > 0 ? b[row - T + x] : 0)
    }
  }

  // anyBig[x,y,z] = OR over (dx,dy,dz ∈ {0,1}) of (W[x+dx,y+dy,z+dz] ≥ 5)
  // 三次"与下一格取或"实现 2×2×2 的 max
  let big = new Uint8Array(n)
  for (let i = 0; i < n; i++) big[i] = W[i] >= 5 ? 1 : 0
  let cur = big
  for (let axis = 0; axis < 3; axis++) {
    const step = axis === 0 ? 1 : axis === 1 ? S : T
    const lim = axis === 0 ? nx : axis === 1 ? ny : nz
    const nxt = new Uint8Array(n)
    for (let z = 0; z < nz; z++) {
      const zc = z
      for (let y = 0; y < ny; y++) {
        const row = zc * T + y * S
        for (let x = 0; x < nx; x++) {
          const coord = axis === 0 ? x : axis === 1 ? y : z
          let v = cur[row + x]
          if (!v && coord < lim - 1) v = cur[row + x + step]
          nxt[row + x] = v
        }
      }
    }
    cur = nxt
  }

  let suspect = 0, solid = 0
  for (let i = 0; i < n; i++) {
    if (!occ[i]) continue
    solid++
    if (!cur[i]) suspect++
  }
  return { definitelyClean: suspect === 0, suspectVoxels: suspect, solidVoxels: solid }
}

// ===========================================================================
// 「会被抹掉」的精确检测
// ===========================================================================

/**
 * 找出**在输出网格里不会存在**的实心体素。
 *
 * 判据（精确，非启发式）：体素 v 的 3×3×3 **格点**邻域内一个负格点都没有。
 *   · 负格点 = 内部格点，等值面必然经过它的附近；
 *   · 周围 3 格范围内都没有负格点 ⇒ 表面到不了 v ⇒ v 在网格里不存在。
 * 用 3×3×3 而不是 2×2×2，是为了容忍"表面在 v 旁边一格"的情形（不误报）。
 *
 * @returns {{eroded:Uint8Array, erodedCount:number, nearNeg:Uint8Array, surfaceCells:number, state:object}}
 */
export function analyzeThin(occ, nx, ny, nz, opt = {}) {
  const st = gridState(occ, nx, ny, nz, opt)
  const { grid, gx, gy, gz, pad } = st

  const neg = new Uint8Array(grid.length)
  for (let i = 0; i < grid.length; i++) neg[i] = grid[i] < 0 ? 1 : 0
  const nearNeg = dilate333(neg, gx, gy, gz)

  const eroded = new Uint8Array(nx * ny * nz)
  let erodedCount = 0
  const Sn = nx, Tn = nx * ny
  const gT = gx * gy
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = z * Tn + y * Sn + x
        if (!occ[i]) continue
        const gi = (z + pad) * gT + (y + pad) * gx + (x + pad)
        if (!nearNeg[gi]) {
          eroded[i] = 1
          erodedCount++
        }
      }
    }
  }

  return {
    eroded, erodedCount, nearNeg,
    surfaceCells: surfaceCellCount(grid, st.fx, st.fy, st.fz),
    state: st,
  }
}

// ===========================================================================
// 连通域 + 沿轴膨胀
// ===========================================================================

/** 6-邻域连通域标记，返回 [{mask, size, extent:[dx,dy,dz], bbox:[x0,y0,z0,x1,y1,z1]}] */
export function label6(mask, nx, ny, nz, minSize = 1) {
  const seen = new Uint8Array(mask.length)
  const S = nx, T = nx * ny
  const comps = []
  const stack = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const cells = []
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let x0 = nx, y0 = ny, z0 = nz, x1 = -1, y1 = -1, z1 = -1
    while (stack.length) {
      const p = stack.pop()
      cells.push(p)
      const x = p % S
      const y = ((p / S) | 0) % ny
      const z = (p / T) | 0
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
      if (z < z0) z0 = z; if (z > z1) z1 = z
      const push = (q) => { if (q >= 0 && q < mask.length && mask[q] && !seen[q]) { seen[q] = 1; stack.push(q) } }
      if (x > 0) push(p - 1)
      if (x < nx - 1) push(p + 1)
      if (y > 0) push(p - S)
      if (y < ny - 1) push(p + S)
      if (z > 0) push(p - T)
      if (z < nz - 1) push(p + T)
    }
    if (cells.length < minSize) continue
    const sub = new Uint8Array(mask.length)
    for (const c of cells) sub[c] = 1
    comps.push({
      mask: sub,
      size: cells.length,
      cells,
      bbox: [x0, y0, z0, x1, y1, z1],
      extent: [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1],
    })
  }
  return comps
}

/** 沿 axis 在 occ 上把 seed 扩到整条连续实心 run（保证薄特征两端也被统一加厚） */
export function growRunsAlong(occ, seed, nx, ny, nz, axis) {
  const out = Uint8Array.from(seed)
  const S = nx, T = nx * ny
  const step = axis === 0 ? 1 : axis === 1 ? S : T
  const lim = axis === 0 ? nx : axis === 1 ? ny : nz
  for (let i = 0; i < seed.length; i++) {
    if (!seed[i]) continue
    for (const dir of [1, -1]) {
      let p = i
      for (;;) {
        const coord = axis === 0 ? p % S : axis === 1 ? ((p / S) | 0) % ny : (p / T) | 0
        const next = coord + dir
        if (next < 0 || next >= lim) break
        const q = p + dir * step
        if (!occ[q]) break
        out[q] = 1
        p = q
      }
    }
  }
  return out
}

/** 沿 axis 把 mask 两侧各膨胀 amount 格（不越出数组） */
export function dilateMaskAlong(mask, nx, ny, nz, axis, amount = 1) {
  let out = Uint8Array.from(mask)
  const S = nx, T = nx * ny
  const step = axis === 0 ? 1 : axis === 1 ? S : T
  const lim = axis === 0 ? nx : axis === 1 ? ny : nz
  for (let s = 0; s < amount; s++) {
    const src = Uint8Array.from(out)
    for (let i = 0; i < src.length; i++) {
      if (!src[i]) continue
      const coord = axis === 0 ? i % S : axis === 1 ? ((i / S) | 0) % ny : (i / T) | 0
      if (coord > 0) out[i - step] = 1
      if (coord < lim - 1) out[i + step] = 1
    }
  }
  return out
}

/** 选最薄的那根轴（连通域包围盒最短边）；并列时优先 Y→X→Z（薄片最常见的姿态） */
export function thinnestAxis(comp) {
  const order = [1, 0, 2]
  let best = order[0]
  for (const a of order) if (comp.extent[a] < comp.extent[best]) best = a
  return best
}

// ===========================================================================
// 主入口
// ===========================================================================

/**
 * 局部薄特征修复：**先检测、再按连通域局部补厚、补后重新验证**。
 *
 * @param {Uint8Array} occ
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {object} [opt]
 * @param {number} [opt.pad=1]      必须与下游 meshFromVoxels 的 pad 一致
 * @param {number} [opt.smooth=0]   必须与下游一致（平滑会改场，进而改检测结果）
 * @param {number} [opt.maxRounds=3]最多修几轮（细丝需要多轴，逐轮处理）
 * @param {boolean} [opt.dryRun=false] 只报告不改动
 * @param {boolean} [opt.quick=true]  先跑廉价预筛（只读占据栅格）；判定"肯定干净"就跳过精确检测
 * @param {object}  [opt.state]       可选：外部已算好的 gridState，避免重复建距离场
 * @returns {{occupied:Uint8Array, repaired:boolean, changed:boolean, report:object}}
 *          **无薄特征时返回入参本身的引用**（调用方可据此判断"零改动"）
 */
export function repairThinFeatures(occ, nx, ny, nz, opt = {}) {
  const maxRounds = Math.max(1, Math.round(opt.maxRounds ?? 3))
  const dryRun = !!opt.dryRun

  const report = {
    detected: 0,          // 首轮检测到"会被抹掉"的实心体素数
    surfaceCellsBefore: 0,
    addedVoxels: 0,
    addedRatio: 0,
    rounds: 0,
    steps: [],            // 逐连通域的修补记录
    verified: false,      // 修补后重新检测，是否已无"会被抹掉"的体素
    residual: 0,          // 修补后仍被判为会抹掉的体素数
    surfaceCellsAfter: 0,
    originalResidual: 0,      // 首轮那批里还有几个没被表示
    originalsRepresented: 0,  // 首轮那批里救回了几个
    zeroChange: false,    // true = 完全没动几何
    quickCheck: null,     // 廉价预筛的结果
    path: '',             // 'quick-clean' | 'exact-clean' | 'repaired' | 'unrepaired'
    reason: '',
  }

  // ---- 廉价预筛：肯定干净就直接返回，省掉一次 distanceField + 格点场重采样 ----
  //
  // ⚠ 只在 smooth === 0 时可信。`quickThinCheck` 的证明依赖两个上界：
  //     "实心体素 field ≤ -6" 与 "块内空格 field ≤ +6"；
  //   `smoothField` 会把相邻体素的值平均，可能把"5 实 + 3 空"的块也抬成非负
  //   ⇒ 那条"≥5 实必有负格点"的推理失效。
  //   实测反例：厚 2 的孤立薄板 + smooth=2 → meshFromVoxels 给 0 个三角形（空网格），
  //   而预筛仍报"肯定干净" ⇒ 漏修。所以有平滑时**必须**走精确检测。
  //   （这条是集成阶段发现的：先说清楚"我的预筛什么时候不能用"，比事后补丁安全。）
  const smoothOpt = Math.max(0, Math.round(opt.smooth ?? 0))
  if (opt.quick !== false && !opt.state && smoothOpt === 0) {
    const q = quickThinCheck(occ, nx, ny, nz)
    report.quickCheck = q
    if (q.definitelyClean) {
      report.verified = true
      report.zeroChange = true
      report.path = 'quick-clean'
      report.reason = `廉价预筛判定"肯定没有薄特征"（${q.solidVoxels} 个实心体素全都存在 ≥5 实的 2×2×2 包含块）⇒ 跳过精确检测，零改动`
      return { occupied: occ, repaired: false, changed: false, report }
    }
  } else if (opt.quick !== false && !opt.state) {
    report.path = 'exact-only'
    report.reason = 'smooth > 0：跳过廉价预筛（其证明在有平滑时不成立），直接精确检测。'
  }

  const a0 = analyzeThin(occ, nx, ny, nz, opt)
  report.detected = a0.erodedCount
  report.surfaceCellsBefore = a0.surfaceCells

  if (a0.erodedCount === 0) {
    report.verified = true
    report.zeroChange = true
    report.path = 'exact-clean'
    report.reason = '未检测到会被抹掉的薄特征 —— 零改动（正常模型走这条路径）'

    return { occupied: occ, repaired: false, changed: false, report }
  }
  let current = Uint8Array.from(occ)
  const totalVoxels = nx * ny * nz
  const originalEroded = Uint8Array.from(a0.eroded) // 首轮检测到的"会被抹掉"集合

  for (let round = 0; round < maxRounds; round++) {
    const a = analyzeThin(current, nx, ny, nz, opt)
    if (a.erodedCount === 0) break

    const comps = label6(a.eroded, nx, ny, nz)
    if (!comps.length) break

    const grown = new Uint8Array(current.length)
    for (const comp of comps) {
      const axis = thinnestAxis(comp)
      const seed = growRunsAlong(current, comp.mask, nx, ny, nz, axis)
      const dil = dilateMaskAlong(seed, nx, ny, nz, axis, 1)
      let add = 0
      for (let i = 0; i < dil.length; i++) {
        if (dil[i]) { grown[i] = 1; if (!current[i]) add++ }
      }
      report.steps.push({
        round,
        erodedVoxels: comp.size,
        axis: 'xyz'[axis],
        bboxExtent: comp.extent.slice(),
        extentAlongAxis: comp.extent[axis],
        addedVoxels: add,
        bbox: comp.bbox.slice(),
      })
    }

    let added = 0
    if (!dryRun) {
      for (let i = 0; i < grown.length; i++) {
        if (grown[i] && !current[i]) { current[i] = 1; added++ }
      }
    } else {
      for (let i = 0; i < grown.length; i++) if (grown[i] && !current[i]) added++
    }
    report.addedVoxels += added
    report.rounds = round + 1
    if (added === 0) break
    if (dryRun) break
  }

  const aEnd = analyzeThin(current, nx, ny, nz, opt)
  report.residual = aEnd.erodedCount
  // 把两件事分开报，别混成一个 verified：
  //   · originalResidual —— 首轮那批"会被抹掉"的体素里，还有几个没被表示（=目标特征救回来没有）
  //   · residual         —— 补完后全栅格还剩几个会被抹掉的体素（可能包含新出现的，如重平滑区）
  {
    let left = 0
    for (let i = 0; i < originalEroded.length; i++) {
      if (originalEroded[i] && aEnd.eroded[i]) left++
    }
    report.originalResidual = left
    report.originalsRepresented = report.detected - left
  }
  report.surfaceCellsAfter = aEnd.surfaceCells
  report.verified = aEnd.erodedCount === 0
  report.addedRatio = report.addedVoxels / totalVoxels
  report.zeroChange = !report.addedVoxels
  report.path = report.verified ? 'repaired' : 'partially-repaired'
  report.reason = report.verified
    ? `已把 ${report.detected} 个会被抹掉的体素全部救回（加了 ${report.addedVoxels} 个，占栅格 ${(report.addedRatio * 100).toFixed(4)}%）`
    : `首轮 ${report.detected} 个会被抹掉的体素里救回 ${report.originalsRepresented} 个，` +
      `还剩 ${report.originalResidual} 个没被表示（全栅格 residual=${report.residual}）；` +
      `${report.rounds} 轮内没能完全修好。常见原因是 smooth 太大 —— 平滑核比薄特征还宽时，` +
      `再补厚也压不出负格点。已停在当前结果，不假装成功。`

  const changed = report.addedVoxels > 0
  return { occupied: changed ? current : occ, repaired: changed, changed, report }
}

/** 修复 + 建网格（未归一化，坐标即体素坐标）。供验证与集成参考。 */
export function meshFromVoxelsRepaired(occ, nx, ny, nz, opt = {}) {
  const r = repairThinFeatures(occ, nx, ny, nz, opt)
  const mesh = meshFromVoxels(r.occupied, nx, ny, nz, { smooth: opt.smooth, pad: opt.pad })
  return { ...mesh, occupied: r.occupied, repair: r.report }
}

export const THICKEN_VERSION = '1.0.0'
