/**
 * dsh-modeler 核心算法（纯 JS，Node 与浏览器共用）。
 *
 * 管线：
 *   三张视图位图 → 剪影掩码 → 填洞 → 体素雕刻 → 薄特征修补 → Chamfer 距离场 → 平滑
 *   → Naive Surface Nets 对偶等值面 → { positions, indices }
 *
 * 坐标约定（右手系，Y 朝上，与 three.js 一致）：
 *   世界盒 [0,nx]×[0,ny]×[0,nz]，体素 (i,j,k) 占 [i,i+1]×[j,j+1]×[k,k+1]。
 *
 * 三视图 → 世界（(px+0.5)/W 取像素中心）：
 *   前视图 front：u→X，v(自顶向下)→Y 反向
 *   侧视图 side ：u→Z，v(自顶向下)→Y 反向
 *   俯视图 top  ：u→X，v(自顶向下)→Z
 *
 * 唯一的模块依赖是 ./thicken.mjs（薄特征修补），它不是零依赖意义上的"外部包"，
 * 而是同一插件的另一个源文件（由另一套独立实现，方案比我的版本精确）。
 */

import { repairThinFeatures } from './thicken.mjs'

// ===========================================================================
// 剪影
// ===========================================================================

/**
 * RGBA 像素 → 二值剪影。
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} img
 * @param {object} [opt]
 * @param {number}  [opt.threshold=0.5]  亮度阈值（auto=false 时生效）
 * @param {number}  [opt.alphaMin=16]    低于此 alpha 视为背景
 * @param {boolean} [opt.invert=false]   反相
 * @param {boolean} [opt.auto=true]      true=Otsu 自动阈值；有透明通道时纯按 alpha
 * @param {boolean} [opt.fillHoles=true] 填内部空洞
 * @param {boolean} [opt.mirror=false]   左右镜像（在求内容框之前做，因此语义正确）
 */
export function silhouette(img, opt = {}) {
  const data = img.data
  const w = img.width | 0
  const h = img.height | 0
  if (!w || !h || !data) throw new Error('silhouette: 图像数据无效')
  const n = w * h
  const alphaMin = opt.alphaMin ?? 16
  const invert = !!opt.invert

  const lum = new Float32Array(n)
  const alpha = new Uint8Array(n)
  let hasTransparency = false
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255
    const a = data[p + 3]
    alpha[i] = a
    if (a < 250) hasTransparency = true
  }

  let thr
  if (hasTransparency) {
    thr = 0.5 // 走 alpha 判定，亮度阈值不参与
  } else if (opt.auto === false) {
    thr = clamp01(opt.threshold ?? 0.5)
  } else {
    thr = Math.min(0.95, Math.max(0.05, otsu(lum)))
  }

  const mask = new Uint8Array(n)
  let bgInfo = null
  if (opt.bgFlood) {
    // 白底插画/线稿走这条：靠"与外界是否连通"分背景，而不是靠亮度
    bgInfo = bgFloodMask(mask, data, w, h, opt)
    let fg = 0
    for (let i = 0; i < n; i++) fg += mask[i]
    if (!fg) {
      // 回退：**整幅图都是背景色**时（例如纯色实心剪影、或背景铺满的图），
      // 洪水填充会把一切判成外部 ⇒ 零前景。这不是"用户给错了"，而是这个判据
      // 在这种输入上没有区分力，所以退回亮度阈值，并如实标注 fallback。
      for (let i = 0; i < n; i++) {
        const solid = hasTransparency ? alpha[i] >= alphaMin : lum[i] <= thr
        mask[i] = (invert ? !solid : solid) ? 1 : 0
      }
      bgInfo.fallbackToLuminance = true
    } else if (invert) {
      for (let i = 0; i < n; i++) mask[i] = mask[i] ? 0 : 1
    }
  } else {
    for (let i = 0; i < n; i++) {
      const solid = hasTransparency ? alpha[i] >= alphaMin : lum[i] <= thr
      mask[i] = (invert ? !solid : solid) ? 1 : 0
    }
  }
  if (opt.fillHoles !== false) fillHoles(mask, w, h)
  // 左右镜像放在最后、且在求内容框之前：内容框跟着变，映射自然正确。
  // （若放到采样阶段做，因为映射用的是已裁剪的内容框，镜像会变成空操作。）
  if (opt.mirror) {
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w >> 1; x++) {
        const a = row + x
        const b = row + (w - 1 - x)
        const t = mask[a]
        mask[a] = mask[b]
        mask[b] = t
      }
    }
  }

  let count = 0
  for (let i = 0; i < n; i++) count += mask[i]
  if (!count) {
    throw new Error(
      '剪影为空：整张图没有前景像素。可能是反相设置不对、主体比背景亮（试 invert）、或阈值不合适。',
    )
  }

  return {
    mask, width: w, height: h,
    threshold: thr,
    alphaUsed: hasTransparency,
    bbox: maskBBox(mask, w, h),
    coverage: count / n,
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Otsu 最大类间方差阈值 */
function otsu(gray) {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) {
    hist[Math.min(255, Math.max(0, Math.round(gray[i] * 255)))]++
  }
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = -1, thr = 0.5
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = i / 255 }
  }
  return thr
}

/**
 * "背景色 + 边界洪水填充"的前景判定 —— 用于**白底彩色插画 / 线稿**这类素材。
 *
 * 为什么需要它（真实案例）：用户给的角色设定图是白底插画，角色有**白围裙**和浅肤色，
 * 与白背景**亮度几乎相同**。亮度阈值（Otsu）只能把深色描线和深色衣服判成前景，
 * 于是剪影变成一张"描线网"，雕刻出来是一堆碎片。
 *
 * 关键观察：**白围裙虽然颜色像背景，但它不与图像边界连通**（被描线围住）。
 * 所以：
 *   1. 先估背景色（取四条边的中位 RGB，抗噪）；
 *   2. 标出"颜色像背景"的像素；
 *   3. 从图像边界做 4-邻域洪水填充，只填**与外界连通**的那部分 → 真正的背景；
 *   4. 剩下的一律算前景 —— 白围裙、浅肤、描线内部全部保住。
 *
 * 默认关闭（`opt.bgFlood`），所以不影响原有剪影夹具的任何行为。
 */
function bgFloodMask(mask, data, w, h, opt) {
  const tol = opt.bgTol ?? 26
  const rs = [], gs = [], bs = []
  for (let x = 0; x < w; x += 3) {
    const p0 = x * 4
    const p1 = ((h - 1) * w + x) * 4
    rs.push(data[p0], data[p1]); gs.push(data[p0 + 1], data[p1 + 1]); bs.push(data[p0 + 2], data[p1 + 2])
  }
  for (let y = 0; y < h; y += 3) {
    const p0 = (y * w) * 4
    const p1 = (y * w + w - 1) * 4
    rs.push(data[p0], data[p1]); gs.push(data[p0 + 1], data[p1 + 1]); bs.push(data[p0 + 2], data[p1 + 2])
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
  const bgR = med(rs), bgG = med(gs), bgB = med(bs)

  const n = w * h
  const bgLike = new Uint8Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const d = Math.max(
      Math.abs(data[p] - bgR),
      Math.abs(data[p + 1] - bgG),
      Math.abs(data[p + 2] - bgB),
    )
    bgLike[i] = d <= tol ? 1 : 0
  }

  const outside = new Uint8Array(n)
  const stack = []
  const seed = (i) => { if (bgLike[i] && !outside[i]) { outside[i] = 1; stack.push(i) } }
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w
    const y = (i / w) | 0
    if (x > 0) seed(i - 1)
    if (x < w - 1) seed(i + 1)
    if (y > 0) seed(i - w)
    if (y < h - 1) seed(i + w)
  }

  for (let i = 0; i < n; i++) mask[i] = outside[i] ? 0 : 1
  return { bg: [bgR, bgG, bgB], tolerance: tol }
}

/**
 * 填内部空洞 —— 但要区分「细小缝隙」和「真实通孔」。
 *
 * 这一步对三视图建模很关键：剪影里的孔往往**就是设计意图**（方板中心的方孔、
 * 圆环、法兰的螺栓孔），一股脑填掉会让重建结果变成一块实心板；反过来，描线或
 * 截图抗锯齿会在主体内部留下几个像素的缝，那种又必须填，否则雕刻出一堆针孔。
 *
 * 判据（对每个空洞连通域，看它外接矩形的最短边）：
 *   - 最短边 < 5px  → 描线/抗锯齿留下的缝隙，填
 *   - 其余          → 当作设计上的孔，保留
 * 之所以用外接矩形而不是面积或填充率：圆孔的外接是正方形、方孔就是正方形，
 * 而缝隙的外接一定有一条很短的边 —— 这个特征最稳，且阈值可以取得很小，
 * 不会误伤"小但真实"的孔。之前用填充率判过一次（错），细长和方形的界限反而更糊。
 */
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h)
  const stack = []

  /** 从 start 泛洪（只走未标记且非实体的像素），返回该连通域的所有下标 */
  const flood = (start) => {
    const cells = []
    stack.length = 0
    stack.push(start)
    outside[start] = 1
    while (stack.length) {
      const i = stack.pop()
      cells.push(i)
      const x = i % w
      const y = (i / w) | 0
      if (x > 0) tryPush(i - 1)
      if (x < w - 1) tryPush(i + 1)
      if (y > 0) tryPush(i - w)
      if (y < h - 1) tryPush(i + w)
      function tryPush(j) {
        if (outside[j] || mask[j]) return
        outside[j] = 1
        stack.push(j)
      }
    }
    return cells
  }

  // 1) 从图像四边泛洪，标出"真正的外部"
  for (let x = 0; x < w; x++) {
    if (!mask[x] && !outside[x]) flood(x)
    const b = (h - 1) * w + x
    if (!mask[b] && !outside[b]) flood(b)
  }
  for (let y = 0; y < h; y++) {
    if (!mask[y * w] && !outside[y * w]) flood(y * w)
    const r = y * w + w - 1
    if (!mask[r] && !outside[r]) flood(r)
  }

  // 2) 剩下没被标记的背景像素全是"洞"，逐个判断该不该填
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || outside[i]) continue
    const cells = flood(i)
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (const c of cells) {
      const x = c % w
      const y = (c / w) | 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const minSide = Math.min(bw, bh)
    if (minSide < 5) for (const c of cells) mask[c] = 1
  }
}

function maskBBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** 归一化坐标采样掩码，越界当背景 */
function sampleMask(m, u, v) {
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return 0
  const x = (u * m.width) | 0
  const y = (v * m.height) | 0
  return m.mask[y * m.width + x]
}

/** 归一化坐标采样体素掩码，越界当背景 */
function sampleVox(m, u, v) {
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return 0
  const x = (u * m.nx) | 0
  const y = (v * m.ny) | 0
  return m.data[y * m.nx + x]
}

// ===========================================================================
// 体素雕刻
// ===========================================================================

export const VIEW_KEYS = ['front', 'side', 'top']

/**
 * 用 1~3 张剪影雕刻占据栅格（视觉壳）。
 *
 * 每张视图各自的**内容框**（去白边后）被映射到世界盒的对应面，并统一到同一个
 * 「每内容像素多少体素」的尺度，避免不同视图被拉伸。
 *
 * @param {{front?:object,side?:object,top?:object}} views silhouette() 的结果
 * @param {object} [opt]
 * @param {number}  [opt.resolution=96]     最长边体素数
 * @param {number}  [opt.padding=0.06]      最长边留白比例
 * @param {boolean} [opt.mirrorSide=false]  侧视图 u 轴镜像
 * @param {number}  [opt.tolerance=0]       允许几张视图"反对"（0=严格取交）
 * @param {boolean} [opt.enforceSymmetry=false] 沿 X 对称化
 * @param {number}  [opt.removeIslands=0]   删除小于该体积的连通块
 */
export function carve(views, opt = {}) {
  const used = VIEW_KEYS.filter((k) => views && views[k])
  if (!used.length) throw new Error('carve: 至少要提供一张视图')

  const boxes = {}
  for (const k of used) {
    const b = views[k].bbox
    if (!b) throw new Error(`carve: ${k} 视图没有前景`)
    boxes[k] = b
  }

  const has = (k) => used.includes(k)
  const longest = Math.max(
    has('front') ? boxes.front.width : 0,
    has('top') ? boxes.top.width : 0,
    has('front') ? boxes.front.height : 0,
    has('side') ? boxes.side.height : 0,
    has('side') ? boxes.side.width : 0,
    has('top') ? boxes.top.height : 0,
  )

  const res = Math.max(8, Math.min(320, Math.round(opt.resolution ?? 96)))
  const pad = Math.max(0, Math.min(0.45, opt.padding ?? 0.06))
  const scale = (res * (1 - 2 * pad)) / longest // 内容像素 → 体素

  const dimFor = (a, b) => {
    const cands = []
    if (a !== undefined && a !== null) cands.push(a)
    if (b !== undefined && b !== null) cands.push(b)
    if (!cands.length) return 4
    return Math.max(2, Math.round(Math.max(...cands) * scale))
  }
  const nx = dimFor(has('front') ? boxes.front.width : null, has('top') ? boxes.top.width : null)
  const ny = dimFor(has('front') ? boxes.front.height : null, has('side') ? boxes.side.height : null)
  const nz = dimFor(has('side') ? boxes.side.width : null, has('top') ? boxes.top.height : null)

  const u = (n, lo, hi, mirror) => {
    const t = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let s = (i + 0.5) / n
      if (mirror) s = 1 - s
      t[i] = lo + s * (hi - lo)
    }
    return t
  }
  const mapU = (k) => {
    const v = views[k]
    const b = boxes[k]
    return { lo: (b.x0 + 0.5) / v.width, hi: (b.x1 + 0.5) / v.width }
  }
  const mapV = (k) => {
    const v = views[k]
    const b = boxes[k]
    // v 自顶向下 → 世界轴自下而上，所以 lo/hi 反过来
    return { lo: (b.y1 + 0.5) / v.height, hi: (b.y0 + 0.5) / v.height }
  }
  const mapVTop = (k) => {
    const v = views[k]
    const b = boxes[k]
    return { lo: (b.y0 + 0.5) / v.height, hi: (b.y1 + 0.5) / v.height }
  }

  const mirrorSide = !!opt.mirrorSide
  const sampleU = {}
  const sampleV = {}
  if (has('front')) {
    const m = mapU('front')
    sampleU.front = u(nx, m.lo, m.hi, false)
    const v = mapV('front')
    sampleV.front = u(ny, v.lo, v.hi, false)
  }
  if (has('side')) {
    const m = mapU('side')
    sampleU.side = u(nz, m.lo, m.hi, mirrorSide)
    const v = mapV('side')
    sampleV.side = u(ny, v.lo, v.hi, false)
  }
  if (has('top')) {
    const m = mapU('top')
    sampleU.top = u(nx, m.lo, m.hi, false)
    const v = mapVTop('top')
    sampleV.top = u(nz, v.lo, v.hi, false)
  }

  const occupied = new Uint8Array(nx * ny * nz)
  const tol = Math.max(0, opt.tolerance ?? 0)
  const need = used.length
  const thresholdVotes = Math.max(1, need - tol)

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let votes = 0
        if (sampleU.front && sampleMask(views.front, sampleU.front[i], sampleV.front[j])) votes++
        if (sampleU.side && sampleMask(views.side, sampleU.side[k], sampleV.side[j])) votes++
        if (sampleU.top && sampleMask(views.top, sampleU.top[i], sampleV.top[k])) votes++
        if (votes >= thresholdVotes) occupied[(k * ny + j) * nx + i] = 1
      }
    }
  }

  if (opt.enforceSymmetry) symmetrizeX(occupied, nx, ny, nz)
  if (opt.removeIslands > 0) removeSmallIslands(occupied, nx, ny, nz, opt.removeIslands)

  let filled = 0
  for (let i = 0; i < occupied.length; i++) filled += occupied[i]
  if (!filled) {
    throw new Error(
      '雕刻结果为空：三张视图的前景没有交集。检查视图类型是否选对（前/侧/俯）、是否需要镜像侧视图、或阈值是否把背景也算成了实体。',
    )
  }

  // ---- 三视图自洽性检查 ----------------------------------------------------
  //
  // 同一个世界轴会由两张视图分别给出长度，两者**必须相等**：
  //     X 轴：front.width  vs  top.width
  //     Y 轴：front.height vs  side.height
  //     Z 轴：side.width   vs  top.height
  //
  // 不自洽时，本函数会把**每张视图各自铺满整个世界盒** —— 也就是把某个视图拉长/压扁，
  // 而且以前是**静默**的。这条是独立审查（`review-axes.mjs` A-5）指出来的：
  // 连本仓库自带的夹具都不自洽（lshape 的 top 被拉宽 3 倍、torus-ish 的 side 被拉高 4 倍）。
  //
  // 现在如实算出来放进返回值，让面板/工具能直接告诉用户"你的三张图尺寸不匹配，模型被拉伸了"。
  const pairChecks = []
  const addPair = (label, axis, a, b, ka, kb) => {
    if (!(ka in boxes) || !(kb in boxes)) return
    const big = Math.max(a, b)
    const diff = big - Math.min(a, b)
    // 容差：至少 2 像素，或相对 5%（避免 1~2 像素的描线差异被当成不一致）
    const tol = Math.max(2, big * 0.05)
    pairChecks.push({
      axis,
      label,
      a: { view: ka, px: a },
      b: { view: kb, px: b },
      ratio: Number((a / b).toFixed(4)),
      consistent: diff <= tol,
    })
  }
  if (has('front') && has('top')) addPair('前视图宽 vs 俯视图宽', 'X', boxes.front.width, boxes.top.width, 'front', 'top')
  if (has('front') && has('side')) addPair('前视图高 vs 侧视图高', 'Y', boxes.front.height, boxes.side.height, 'front', 'side')
  if (has('side') && has('top')) addPair('侧视图宽 vs 俯视图高', 'Z', boxes.side.width, boxes.top.height, 'side', 'top')

  const inconsistent = pairChecks.filter((p) => !p.consistent)

  return {
    occupied, nx, ny, nz, filled,
    fillRatio: filled / occupied.length,
    scale,
    viewsUsed: used,
    mirroredSide: mirrorSide,
    contentPixels: longest,
    viewConsistency: {
      pairs: pairChecks,
      inconsistent,
      /** true 表示至少有一对不自洽 ⇒ 该轴上的模型被非等比拉伸了 */
      stretched: inconsistent.length > 0,
      /** 给面板/工具直接用的一句话 */
      warning: inconsistent.length
        ? '三视图尺寸不自洽，模型已被非等比拉伸：' +
          inconsistent.map((p) => `${p.label}（${p.a.px}px vs ${p.b.px}px，${p.ratio}×）`).join('；') +
          '。请让同一根轴在两张视图里的长度一致，否则形状会失真。'
        : '',
    },
  }
}

function symmetrizeX(occ, nx, ny, nz) {
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx >> 1; i++) {
        const a = (k * ny + j) * nx + i
        const b = (k * ny + j) * nx + (nx - 1 - i)
        const v = occ[a] | occ[b]
        occ[a] = v
        occ[b] = v
      }
    }
  }
}

/** 6-邻域连通块，丢掉小于 minSize 的块 */
function removeSmallIslands(occ, nx, ny, nz, minSize) {
  const seen = new Uint8Array(occ.length)
  const S = nx, T = nx * ny
  for (let start = 0; start < occ.length; start++) {
    if (!occ[start] || seen[start]) continue
    const comp = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop()
      comp.push(p)
      const x = p % S
      const y = ((p / S) | 0) % ny
      const z = (p / T) | 0
      if (x > 0) visit(p - 1)
      if (x < S - 1) visit(p + 1)
      if (y > 0) visit(p - S)
      if (y < ny - 1) visit(p + S)
      if (z > 0) visit(p - T)
      if (z < nz - 1) visit(p + T)
      function visit(q) {
        if (occ[q] && !seen[q]) { seen[q] = 1; stack.push(q) }
      }
    }
    if (comp.length < minSize) for (const p of comp) occ[p] = 0
  }
}

// ===========================================================================
// 距离场
// ===========================================================================

const D1 = 3, D2 = 4, D3 = 5   // Chamfer 3-4-5 ≈ 欧氏
/**
 * 未到达的哨兵值。
 *
 * 取值要小到"哨兵 + 几步加权"也不会越过 Int32 上限：
 * 之前用 0x3fffffff，chafer 里做 BIG + D1 会溢出成负数（1073741826 + 3 → 溢出），
 * 表现为全实心块的 field 冒出 -1073741826 这种离谱值。
 * 0x3fffff ≈ 4.19e6，即使叠加几十步也远不到 2^31。
 */
const BIG = 0x3fffff

/**
 * 占据体素 → 带符号距离场。**内部为负，外部为正。**
 *
 * 返回数组与输入**同维度同索引**（这点很关键：距离场与占据栅格必须共用同一套
 * 索引，否则后面等值面采样到的距离和占据位置会错位，表现为网格破洞/绕序混乱）。
 *
 * 外部距离以"占据体素"为种子，内部距离以"空格"为种子 —— 后者是重点：
 * 实心块最深处的格子离表面最远，只在边界播种会把实心内部误判成外部。
 *
 * @param {Uint8Array} occ 占据标记（非 0 = 实体）
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {{pad?:number}} [opt] pad>0 时在四周补 pad 层背景，返回维度为 (nx+2pad)…
 * @returns {{field:Int32Array, nx:number, ny:number, nz:number}}
 */
export function distanceField(occ, nx, ny, nz, opt = {}) {
  const pad = Math.max(0, Math.round(opt.pad ?? 0))
  const bx = nx + pad * 2
  const by = ny + pad * 2
  const bz = nz + pad * 2
  const n = bx * by * bz
  const S = bx
  const T = bx * by

  // 盒化后的占据
  const boxed = new Uint8Array(n)
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const srcRow = (z * ny + y) * nx
      const dstRow = (z + pad) * T + (y + pad) * S + pad
      for (let x = 0; x < nx; x++) boxed[dstRow + x] = occ[srcRow + x] ? 1 : 0
    }
  }

  // 外部距离：以"实体"为种子 0，扩散到空格 → 空格得到"到最近实体的距离"
  const outside = new Int32Array(n)
  for (let i = 0; i < n; i++) outside[i] = boxed[i] ? 0 : BIG
  chamfer(outside, bx, by, bz)

  // 内部距离：以"空格"为种子 0，扩散到实体 → 实体得到"到最近空格的距离"
  //
  // ⚠ 这里两个种子极易写反，而且写反之后**测试几乎全绿**：
  //   若以实体为种子（inside[i] = boxed[i] ? 0 : BIG），chamfer 的 min 会立刻被
  //   自身的 0 吃掉，所有实体的 inside 恒为 0，距离场退化成二值的 ±3 ——
  //   等值面位置仍然落在格边中点附近，水密性、体积、包围盒都对得上，
  //   只有曲面细节（斜边、圆角）会变糙。所以这一行必须靠"逐点看数值"来守。
  const inside = new Int32Array(n)
  for (let i = 0; i < n; i++) inside[i] = boxed[i] ? BIG : 0
  chamfer(inside, bx, by, bz)

  const field = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    field[i] = boxed[i] ? -(inside[i] + D1) : outside[i] + D1
  }
  return { field, nx: bx, ny: by, nz: bz }
}

/** 两遍扫描 Chamfer 距离变换：0 是种子，其余向外扩散 */
function chamfer(d, nx, ny, nz) {
  const S = nx, T = nx * ny

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = z * T + y * S
      for (let x = 0; x < nx; x++) {
        const i = row + x
        let v = d[i]
        if (v === 0) continue
        if (x > 0) v = Math.min(v, d[i - 1] + D1)
        if (y > 0) v = Math.min(v, d[i - S] + D1)
        if (z > 0) v = Math.min(v, d[i - T] + D1)
        if (x > 0 && y > 0) v = Math.min(v, d[i - S - 1] + D2)
        if (x < nx - 1 && y > 0) v = Math.min(v, d[i - S + 1] + D2)
        if (x > 0 && z > 0) v = Math.min(v, d[i - T - 1] + D2)
        if (x < nx - 1 && z > 0) v = Math.min(v, d[i - T + 1] + D2)
        if (y > 0 && z > 0) v = Math.min(v, d[i - T - S] + D2)
        if (y < ny - 1 && z > 0) v = Math.min(v, d[i - T + S] + D2)
        if (x > 0 && y > 0 && z > 0) v = Math.min(v, d[i - T - S - 1] + D3)
        if (x < nx - 1 && y > 0 && z > 0) v = Math.min(v, d[i - T - S + 1] + D3)
        if (x > 0 && y < ny - 1 && z > 0) v = Math.min(v, d[i - T + S - 1] + D3)
        if (x < nx - 1 && y < ny - 1 && z > 0) v = Math.min(v, d[i - T + S + 1] + D3)
        d[i] = v
      }
    }
  }

  for (let z = nz - 1; z >= 0; z--) {
    for (let y = ny - 1; y >= 0; y--) {
      const row = z * T + y * S
      for (let x = nx - 1; x >= 0; x--) {
        const i = row + x
        let v = d[i]
        if (v === 0) continue
        if (x < nx - 1) v = Math.min(v, d[i + 1] + D1)
        if (y < ny - 1) v = Math.min(v, d[i + S] + D1)
        if (z < nz - 1) v = Math.min(v, d[i + T] + D1)
        if (x < nx - 1 && y < ny - 1) v = Math.min(v, d[i + S + 1] + D2)
        if (x > 0 && y < ny - 1) v = Math.min(v, d[i + S - 1] + D2)
        if (x < nx - 1 && z < nz - 1) v = Math.min(v, d[i + T + 1] + D2)
        if (x > 0 && z < nz - 1) v = Math.min(v, d[i + T - 1] + D2)
        if (y < ny - 1 && z < nz - 1) v = Math.min(v, d[i + T + S] + D2)
        if (y > 0 && z < nz - 1) v = Math.min(v, d[i + T - S] + D2)
        if (x < nx - 1 && y < ny - 1 && z < nz - 1) v = Math.min(v, d[i + T + S + 1] + D3)
        if (x > 0 && y < ny - 1 && z < nz - 1) v = Math.min(v, d[i + T + S - 1] + D3)
        if (x < nx - 1 && y > 0 && z < nz - 1) v = Math.min(v, d[i + T - S + 1] + D3)
        if (x > 0 && y > 0 && z < nz - 1) v = Math.min(v, d[i + T - S - 1] + D3)
        d[i] = v
      }
    }
  }
}

/** 可分离 3 抽头模糊，重复 iterations 次近似高斯。返回新数组。 */
export function smoothField(field, nx, ny, nz, iterations = 1) {
  if (iterations <= 0) return field
  const S = nx, T = nx * ny
  let src = Int32Array.from(field)
  let dst = new Int32Array(field.length)

  for (let it = 0; it < iterations; it++) {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const row = z * T + y * S
      for (let x = 0; x < nx; x++) {
        const a = src[row + (x > 0 ? x - 1 : 0)]
        const b = src[row + x]
        const c = src[row + (x < nx - 1 ? x + 1 : nx - 1)]
        dst[row + x] = ((a + b + c) / 3) | 0
      }
    }
    let t = src; src = dst; dst = t

    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        const i = z * T + y * S + x
        const a = src[z * T + (y > 0 ? y - 1 : 0) * S + x]
        const b = src[i]
        const c = src[z * T + (y < ny - 1 ? y + 1 : ny - 1) * S + x]
        dst[i] = ((a + b + c) / 3) | 0
      }
    }
    t = src; src = dst; dst = t

    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      for (let z = 0; z < nz; z++) {
        const i = z * T + y * S + x
        const a = src[(z > 0 ? z - 1 : 0) * T + y * S + x]
        const b = src[i]
        const c = src[(z < nz - 1 ? z + 1 : nz - 1) * T + y * S + x]
        dst[i] = ((a + b + c) / 3) | 0
      }
    }
    t = src; src = dst; dst = t
  }
  return src
}

// ===========================================================================
// Naive Surface Nets
// ===========================================================================

// 局部角编号：bit0→x, bit1→y, bit2→z（与 at(x+CX,y+CY,z+CZ) 一致）
const CX = [0, 1, 0, 1, 0, 1, 0, 1]
const CY = [0, 0, 1, 1, 0, 0, 1, 1]
const CZ = [0, 0, 0, 0, 1, 1, 1, 1]
// 立方体 12 条边（局部角编号对）
const EDGE_A = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3]
const EDGE_B = [1, 3, 0, 2, 5, 7, 4, 6, 4, 5, 6, 7]

/**
 * 对偶等值面重建：每个"角有正有负"的格 → 1 顶点；每条变号格边 → 1 四边形。
 * 不需要任何查找表，拓扑由"每条变号格边恰好邻接 4 个变号格"保证，
 * 结果必然闭合、必然流形；绕序按 field 梯度（内→外）自动判定。
 *
 * ⚠ **隐含前置条件：最外一圈采样点必须全为正（外部）。**
 * 若外圈出现负值，第一遍不会给边界格分配顶点，第二遍遇到相邻格 `cellIndex < 0`
 * 时整条格边被跳过 —— 结果是**边界边**（不闭合），而且**不会抛任何错**。
 * 正常管线里 `meshFromVoxels` 用 pad≥1 补了一层背景，所以这条永远满足；
 * 但直接调用本函数时请自行保证。（`review-misc.mjs` 用构造数据
 * 证明了"越界/外圈为负"会产生边界边而不报错，因此在这里显式写明。）
 *
 * 另一条已知退化：**厚度只有 1 个体素的结构会重建出空网格**。原因是
 * 体素域→格点域取 8 邻居平均时，跨表面格点恰好 `(4×-6 + 4×+6)/8 = 0`，
 * 而本函数用 `v < 0` 判内部 ⇒ 0 个内部格点 ⇒ 无面可建。
 * 这不是 bug，是角点采样表示 1 体素厚度的固有限制（厚度 ≥2 才有内部格点）。
 *
 * @param {Int32Array} field 尺寸必须 >= (nx+1)(ny+1)(nz+1)
 */
export function surfaceNets(field, nx, ny, nz) {
  const S = nx + 1, T = (nx + 1) * (ny + 1)
  const at = (x, y, z) => field[z * T + y * S + x]

  const cellIndex = new Int32Array(nx * ny * nz).fill(-1)
  const verts = []

  // ---- 第一遍：表面格 → 顶点
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let mask = 0
        const v0 = at(x, y, z)
        const v1 = at(x + 1, y, z)
        const v2 = at(x, y + 1, z)
        const v3 = at(x + 1, y + 1, z)
        const v4 = at(x, y, z + 1)
        const v5 = at(x + 1, y, z + 1)
        const v6 = at(x, y + 1, z + 1)
        const v7 = at(x + 1, y + 1, z + 1)
        const v = [v0, v1, v2, v3, v4, v5, v6, v7]
        for (let c = 0; c < 8; c++) if (v[c] < 0) mask |= 1 << c
        if (mask === 0 || mask === 255) continue

        let sx = 0, sy = 0, sz = 0, cnt = 0
        for (let e = 0; e < 12; e++) {
          const a = EDGE_A[e], b = EDGE_B[e]
          const va = v[a], vb = v[b]
          if ((va < 0) === (vb < 0)) continue
          const t = va === vb ? 0.5 : va / (va - vb)
          sx += CX[a] + t * (CX[b] - CX[a])
          sy += CY[a] + t * (CY[b] - CY[a])
          sz += CZ[a] + t * (CZ[b] - CZ[a])
          cnt++
        }
        if (!cnt) continue
        const id = verts.length / 3
        verts.push(x + sx / cnt, y + sy / cnt, z + sz / cnt)
        cellIndex[(z * ny + y) * nx + x] = id
      }
    }
  }

  // ---- 第二遍：变号格边 → 四边形
  const tris = []
  const pushQuad = (a, b, c, d, dir) => {
    // dir: 该格边的"内→外"方向（符号即可）。选取使法线与 dir 同向的绕序。
    const n1 = newell(verts, a, b, c, d)
    const dot = n1[0] * dir[0] + n1[1] * dir[1] + n1[2] * dir[2]
    if (dot >= 0) {
      tris.push(a, b, c, a, c, d)
    } else {
      tris.push(a, d, c, a, c, b)
    }
  }

  // 沿 X 的格边
  for (let z = 1; z < nz + 1; z++) {
    for (let y = 1; y < ny + 1; y++) {
      for (let x = 0; x < nx; x++) {
        const a = at(x, y, z), b = at(x + 1, y, z)
        if ((a < 0) === (b < 0)) continue
        const q0 = cellIndex[((z - 1) * ny + (y - 1)) * nx + x]
        const q1 = cellIndex[((z - 1) * ny + y) * nx + x]
        const q2 = cellIndex[(z * ny + y) * nx + x]
        const q3 = cellIndex[(z * ny + (y - 1)) * nx + x]
        if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) continue
        pushQuad(q0, q1, q2, q3, a < b ? [1, 0, 0] : [-1, 0, 0])
      }
    }
  }
  // 沿 Y 的格边
  for (let z = 1; z < nz + 1; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 1; x < nx + 1; x++) {
        const a = at(x, y, z), b = at(x, y + 1, z)
        if ((a < 0) === (b < 0)) continue
        const q0 = cellIndex[((z - 1) * ny + y) * nx + (x - 1)]
        const q1 = cellIndex[(z * ny + y) * nx + (x - 1)]
        const q2 = cellIndex[(z * ny + y) * nx + x]
        const q3 = cellIndex[((z - 1) * ny + y) * nx + x]
        if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) continue
        pushQuad(q0, q1, q2, q3, a < b ? [0, 1, 0] : [0, -1, 0])
      }
    }
  }
  // 沿 Z 的格边
  for (let z = 0; z < nz; z++) {
    for (let y = 1; y < ny + 1; y++) {
      for (let x = 1; x < nx + 1; x++) {
        const a = at(x, y, z), b = at(x, y, z + 1)
        if ((a < 0) === (b < 0)) continue
        const q0 = cellIndex[(z * ny + (y - 1)) * nx + (x - 1)]
        const q1 = cellIndex[(z * ny + (y - 1)) * nx + x]
        const q2 = cellIndex[(z * ny + y) * nx + x]
        const q3 = cellIndex[(z * ny + y) * nx + (x - 1)]
        if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) continue
        pushQuad(q0, q1, q2, q3, a < b ? [0, 0, 1] : [0, 0, -1])
      }
    }
  }

  return {
    positions: new Float32Array(verts),
    indices: new Uint32Array(tris),
    vertexCount: verts.length / 3,
    triangleCount: tris.length / 3,
  }
}

/** Newell 法：任意平面多边形的法线（含面积权重） */
function newell(pos, a, b, c, d) {
  const idx = [a, b, c, d]
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < 4; i++) {
    const p = idx[i] * 3
    const q = idx[(i + 1) % 4] * 3
    nx += (pos[p + 1] - pos[q + 1]) * (pos[p + 2] + pos[q + 2])
    ny += (pos[p + 2] - pos[q + 2]) * (pos[p] + pos[q])
    nz += (pos[p] - pos[q]) * (pos[p + 1] + pos[q + 1])
  }
  return [nx, ny, nz]
}

// ===========================================================================
// 薄结构处理
// ===========================================================================

/**
 * 沿某轴的最长连续实体游程。
 *
 * 用途：判断"这个方向是不是只有 1 层厚"。1 体素厚的结构在**角点采样**下
 * 没有任何"内部格点" —— 体素域→格点域的平均会把唯一的负值跟正邻居平掉
 * （(-6 + 6)/2 = 0），而 surfaceNets 判定 `< 0` 才算内部，于是重建出**空网格**。
 * 这不是实现 bug，是离散几何的固有性质：厚度必须 ≥ 2 个体素，中间才有一个
 * 真正在内部的采样点。（由 `review-thin.mjs` 发现）
 *
 * @param {0|1|2} axis 0=X 1=Y 2=Z
 */
function maxRunAlong(occ, nx, ny, nz, axis) {
  const at = (x, y, z) => occ[(z * ny + y) * nx + x]
  let best = 0
  if (axis === 0) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        let run = 0
        for (let x = 0; x < nx; x++) { run = at(x, y, z) ? run + 1 : 0; if (run > best) best = run }
      }
    }
  } else if (axis === 1) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        let run = 0
        for (let y = 0; y < ny; y++) { run = at(x, y, z) ? run + 1 : 0; if (run > best) best = run }
      }
    }
  } else {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let run = 0
        for (let z = 0; z < nz; z++) { run = at(x, y, z) ? run + 1 : 0; if (run > best) best = run }
      }
    }
  }
  return best
}

/** 沿某轴把实体向两侧各膨胀 amount 格（用于把过薄的板撑到能重建） */
function dilateAlong(occ, nx, ny, nz, axis, amount = 1) {
  let out = Uint8Array.from(occ)
  const S = nx, T = nx * ny
  for (let step = 0; step < amount; step++) {
    const src = Uint8Array.from(out)
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (!src[z * T + y * S + x]) continue
          if (axis === 0) {
            if (x > 0) out[z * T + y * S + x - 1] = 1
            if (x < nx - 1) out[z * T + y * S + x + 1] = 1
          } else if (axis === 1) {
            if (y > 0) out[z * T + (y - 1) * S + x] = 1
            if (y < ny - 1) out[z * T + (y + 1) * S + x] = 1
          } else {
            if (z > 0) out[(z - 1) * T + y * S + x] = 1
            if (z < nz - 1) out[(z + 1) * T + y * S + x] = 1
          }
        }
      }
    }
  }
  return out
}


// ===========================================================================
// 一条龙
// ===========================================================================

/**
 * 占据体素 → 网格（未归一化，坐标就是体素坐标）。
 *
 * 数据流（每一步的索引域都写清楚，这里最容易错）：
 *   1. 占据体素域        (nx, ny, nz)              值为 0/1
 *   2. 补 pad 层背景      (nx+2p, ny+2p, nz+2p)     保证等值面不在数组边界被截断
 *   3. 距离场           同上维度、同一索引          内部负、外部正
 *   4. 场平滑           同上（可选）
 *   5. 体素域 → 格点域    (nx+2p+1, …)              每个格点取其周围 8 个体素距离的平均
 *   6. Surface Nets      在 (2p+nx) 个格上跑
 *
 * @param {Uint8Array} occ @param {number} nx @param {number} ny @param {number} nz
 * @param {{smooth?:number, pad?:number}} [opt]
 */
export function meshFromVoxels(occ, nx, ny, nz, opt = {}) {
  const pad = Math.max(1, Math.round(opt.pad ?? 1))
  const { field, nx: fx, ny: fy, nz: fz } = distanceField(occ, nx, ny, nz, { pad })
  const smooth = Math.max(0, Math.round(opt.smooth ?? 0))
  const smoothed = smooth ? smoothField(field, fx, fy, fz, smooth) : field
  const grid = voxelFieldToGrid(smoothed, fx, fy, fz)
  // grid 的采样点维度是 (fx+1)(fy+1)(fz+1)，正好是 fx*fy*fz 个格所需
  const mesh = surfaceNets(grid, fx, fy, fz)
  return { ...mesh, gridSize: [fx, fy, fz], voxelDims: [nx, ny, nz] }
}

/**
 * 体素域采样 → 格点域采样，输出维度 (nx+1)(ny+1)(nz+1)。
 *
 * 这里的 (nx,ny,nz) 是**距离场的体素维度**。体素 (i,j,k) 的中心在格点
 * (i+0.5, j+0.5, k+0.5)，所以格点 (x,y,z) 的场值取周围 8 个体素的平均
 * （等价三线性插值）。边界格点少取几个邻居，属于正常的一阶近似。
 *
 * ⚠ 这个尺寸必须严格等于 surfaceNets 需要的采样点总数，否则最后一行/列会读出
 * undefined，符号判定错乱、网格出现破洞 —— 这个坑踩过一次了。
 */
function voxelFieldToGrid(field, nx, ny, nz) {
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

/**
 * 剪影 → 网格（已居中到原点、按最长边归一化）。
 * @param {{front?:object,side?:object,top?:object}} views
 * @param {object} [opt] carve 的参数 + { smooth?:number, scale?:number, thicken?:boolean }
 */
export function buildMesh(views, opt = {}) {
  const vol = carve(views, opt)
  const { nx, ny, nz } = vol
  let occupied = vol.occupied

  // ---- 薄结构补厚：**先算，只有真的空了才补** -------------------------------
  //
  // 这个顺序是独立审查（`review-thicken.mjs`）纠正的。第一版是
  // "无条件先判厚度再补"，有两个问题：
  //   1. **定位错位**：它想修的"整块只有 1 体素厚"其实已被 `carve` 里的
  //      `Math.max(2, …)` 保底抬到 2，于是被 `n < 3` 跳过 —— 根本打不到；
  //   2. **误伤**：它真能打到的是"该轴总体不止一格、但最长游程 = 1"的形态
  //      （条纹、百叶窗、点阵），于是把这些**有意为之的薄结构静默糊成实心**。
  //      实测 8 个正常夹具全都不触发，所以它对正常模型毫无贡献，只增加误伤面。
  //
  // 改成"先算一遍，只有结果是空网格（0 三角形）时才考虑补厚"，误伤面就消失了：
  // 条纹类结构只要能出网格，就完全不会被碰。
  //
  // 仍然**不够**的地方（如实记下）：判据是"整轴最长游程 ≤ 1"，所以
  // "大模型上方悬空的一条 1 体素薄条"这种**局部**薄特征，因为该轴整体很厚，
  // 不会被判到 —— 那条薄条照样会丢。要做对得逐连通域算局部厚度（尚未实现）。
  const thicken = opt.thicken !== false
  const thickenedAxes = []

  // ---- 第一道：修补"会被抹掉"的薄特征 --------------------------------------
  //
  // 这里用的是 src/core/thicken.mjs 的 repairThinFeatures（另一套独立实现）。
  // 它的判据比我自己写的那版**精确**：直接问"这个实心体素的 3×3×3 格点邻域里
  // 有没有负格点" —— 没有就说明等值面到不了它附近、它在输出网格里必然不存在。
  // （我原来的判据是"域的最小包围盒跨度 ≤ 1"，对**斜置薄片**无效；它这个对任意形状有效。）
  //
  // 它还有三点好处：
  //   · **廉价预筛**：肯定干净时跳过精确检测（省一次 distanceField + 重采样）
  //   · **零改动保证**：没检测到薄特征时原样返回同一个数组引用，一个体素都不动
  //   · **验证闭环**：补完重跑检测，做不到就如实报 verified=false + residual，不假装成功
  let thinFix = null
  if (thicken) {
    const rep = repairThinFeatures(occupied, nx, ny, nz, { maxRounds: 3 })
    if (rep.changed) {
      occupied = rep.occupied
      thinFix = rep.report
    }
  }

  let mesh = meshFromVoxels(occupied, nx, ny, nz, { smooth: opt.smooth, pad: opt.pad })

  // ---- 第二道：整个网格还是空 ⇒ 退回"按整轴补厚"（兜底）--------------------
  // 第一道按连通域判，覆盖不到"该轴本来就只有 1 层、连连通域都谈不上"的极端情形。
  if (thicken && mesh.triangleCount === 0) {
    for (const [axis, n] of [[0, nx], [1, ny], [2, nz]]) {
      if (n < 3) continue
      if (maxRunAlong(occupied, nx, ny, nz, axis) <= 1) {
        occupied = dilateAlong(occupied, nx, ny, nz, axis, 1)
        thickenedAxes.push('xyz'[axis])
      }
    }
    if (thickenedAxes.length) {
      mesh = meshFromVoxels(occupied, nx, ny, nz, { smooth: opt.smooth, pad: opt.pad })
    }
  }
  const anyThicken = thickenedAxes.length > 0 || !!thinFix
  const thickenedVoxels = anyThicken
    ? (() => { let n = 0; for (let i = 0; i < occupied.length; i++) n += occupied[i]; return n })()
    : vol.filled

  // 归一化：包围盒居中到原点，最长边 = scale
  const positions = mesh.positions
  const target = opt.scale ?? 1
  const box = positions.length ? boundsOf(positions) : { extent: 1, center: [0, 0, 0] }
  const k = target / (box.extent || 1)
  const c = box.center
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - c[0]) * k
    positions[i + 1] = (positions[i + 1] - c[1]) * k
    positions[i + 2] = (positions[i + 2] - c[2]) * k
  }

  const stats = meshStats(positions, mesh.indices)
  return {
    positions,
    indices: mesh.indices,
    meta: {
      ...stats,
      grid: [nx, ny, nz],
      filledVoxels: thickenedVoxels,
      fillRatio: thickenedVoxels / (nx * ny * nz),
      viewsUsed: vol.viewsUsed,
      smooth: Math.max(0, Math.round(opt.smooth ?? 0)),
      targetSize: target,
      thickenedAxes,
      /**
       * 薄特征修补报告（null = 没触发，正常模型都是 null）。
       * 字段来自 src/core/thicken.mjs 的 repairThinFeatures，其中：
       *   path      — 'quick-clean' | 'exact-clean' | 'repaired' | 'unrepaired'
       *   detected  — 首轮检测到"会被抹掉"的实心体素数
       *   addedVoxels / addedRatio — 补了多少体素、占整模比例
       *   verified  — 补完重新检测是否已无"会被抹掉"的体素（做不到就是 false）
       *   residual  — 仍被判为会被抹掉的体素数（verified=false 时 >0）
       */
      thinRepair: thinFix
        ? {
            path: thinFix.path,
            detected: thinFix.detected,
            addedVoxels: thinFix.addedVoxels,
            addedRatio: Number((thinFix.addedRatio ?? 0).toFixed(5)),
            rounds: thinFix.rounds,
            verified: thinFix.verified,
            residual: thinFix.residual,
          }
        : null,
      /** 三视图是否自洽（不自洽 ⇒ 模型被非等比拉伸，见 carve 里的说明） */
      viewConsistency: vol.viewConsistency,
      ...(stats.empty
        ? {
            emptyReason:
              (thickenedAxes.length
                ? `某些方向只有 1 个体素厚（已尝试在 ${thickenedAxes.join('/')} 轴补厚），`
                : '') +
              '仍然重建不出网格。多半是模型相对分辨率太薄 —— 把「分辨率」调高，' +
              '或确认三视图不是细线条画。',
          }
        : {}),
    },
  }
}

function boundsOf(positions) {
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minx) minx = x
    if (x > maxx) maxx = x
    if (y < miny) miny = y
    if (y > maxy) maxy = y
    if (z < minz) minz = z
    if (z > maxz) maxz = z
  }
  return {
    min: [minx, miny, minz],
    max: [maxx, maxy, maxz],
    extent: Math.max(maxx - minx, maxy - miny, maxz - minz),
    center: [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2],
  }
}

/**
 * 网格自检：有符号体积、包围盒、是否闭合流形。
 * 体积为正 ⇒ 绕序朝外（右手系）。
 *
 * `empty` 必须单独看：0 个三角形时 boundary 也是 0，若只看 watertight 会得到
 * "空网格是水密的"这种荒谬结论 —— host 的 modeler_save 曾因此对一个空网格
 * 吐出"网格水密，可以直接 3D 打印"。（由独立审查发现）
 */
export function meshStats(positions, indices) {
  const vertexCount = positions.length / 3
  const triangleCount = indices.length / 3

  if (vertexCount === 0 || triangleCount === 0) {
    return {
      vertexCount,
      triangleCount,
      volume: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      extent: [0, 0, 0],
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      watertight: false,   // 空的不是水密的
      empty: true,
    }
  }

  let vol = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }

  const box = boundsOf(positions)

  const edgeUse = new Map()
  for (let t = 0; t < indices.length; t += 3) {
    const p0 = indices[t], p1 = indices[t + 1], p2 = indices[t + 2]
    bump(edgeUse, p0, p1)
    bump(edgeUse, p1, p2)
    bump(edgeUse, p2, p0)
  }
  let boundary = 0, nonManifold = 0
  for (const n of edgeUse.values()) {
    if (n === 1) boundary++
    else if (n > 2) nonManifold++
  }

  return {
    vertexCount,
    triangleCount,
    volume: vol,
    bbox: { min: box.min, max: box.max },
    extent: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]],
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight: boundary === 0 && nonManifold === 0,
    empty: false,
  }
}

function bump(map, p, q) {
  // ⚠ 必须用字符串 key。
  //
  // 曾经用整数 key `p * 2097152 + q`（p,q < 2^21 时精确）图快，独立审查
  // 构造出了一个**碰撞实例**：两条完全不同的边共用了同一个计数器，于是
  //   真值 6 条边界边 → meshStats 只报 2 条 → 非流形网格被误判成水密。
  // 触发条件是顶点数 ≥ 2^21 = 2097152（当前管线达不到），但这是导出的公共函数，
  // 判"能不能 3D 打印"就靠它，正确性优先于那点速度。
  const key = p < q ? p + ',' + q : q + ',' + p
  map.set(key, (map.get(key) || 0) + 1)
}

// ===========================================================================
// 导出格式
// ===========================================================================

/** Wavefront OBJ（Y 朝上） */
export function toOBJ(positions, indices, name = 'model') {
  const out = ['# dsh-modeler export', `o ${name}`]
  for (let i = 0; i < positions.length; i += 3) {
    out.push(`v ${f(positions[i])} ${f(positions[i + 1])} ${f(positions[i + 2])}`)
  }
  for (let i = 0; i < indices.length; i += 3) {
    out.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`)
  }
  return out.join('\n') + '\n'
}

/** 二进制 STL（三角形面法线 + 3 顶点）。3D 打印通用格式。 */
export function toSTLBinary(positions, indices, name = 'dsh-modeler') {
  const triCount = indices.length / 3
  const buf = new ArrayBuffer(84 + triCount * 50)
  const dv = new DataView(buf)
  // STL 头是 80 字节 ASCII。名字里若有中文，charCodeAt 会给出 >255 的码位，
  // setUint8 只取低 8 位 → 头部变成乱码（几何不受影响，但有些工具靠头部找模型名）。
  // 所以先把非 ASCII 折成 '?'，并显式按字节数截断。
  const header = `dsh-modeler ${name}`
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 79)
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i))
  dv.setUint32(80, triCount, true)
  let off = 84
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const n = triNormal(positions, a, b, c)
    dv.setFloat32(off, n[0], true); dv.setFloat32(off + 4, n[1], true); dv.setFloat32(off + 8, n[2], true)
    off += 12
    for (const p of [a, b, c]) {
      dv.setFloat32(off, positions[p], true)
      dv.setFloat32(off + 4, positions[p + 1], true)
      dv.setFloat32(off + 8, positions[p + 2], true)
      off += 12
    }
    dv.setUint16(off, 0, true)
    off += 2
  }
  return new Uint8Array(buf)
}

/** ASCII STL（方便肉眼检查/文本 diff） */
export function toSTLAscii(positions, indices, name = 'dsh-modeler') {
  const out = [`solid ${name}`]
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const n = triNormal(positions, a, b, c)
    out.push(`  facet normal ${f(n[0])} ${f(n[1])} ${f(n[2])}`)
    out.push('    outer loop')
    for (const p of [a, b, c]) out.push(`      vertex ${f(positions[p])} ${f(positions[p + 1])} ${f(positions[p + 2])}`)
    out.push('    endloop')
    out.push('  endfacet')
  }
  out.push(`endsolid ${name}`)
  return out.join('\n') + '\n'
}

/**
 * glTF 2.0 文档 + 二进制缓冲 —— GLB 与 .gltf **共用这一份布局**。
 *
 * 为什么必须抽出来：索引对齐到 4 字节、bufferView 的 offset、accessor 的 componentType
 * 这几处只要两边各写一遍，迟早有一边错开一位 —— 而那种错的表现是"文件能打开、
 * 模型是烂的"，最难查。所以布局只能有一份代码。
 */
function gltfParts(positions, indices, name) {
  const useU16 = positions.length / 3 <= 65535
  const idxArr = useU16
    ? (() => { const a = new Uint16Array(indices.length); a.set(indices); return a })()
    : Uint32Array.from(indices)

  const posBytes = positions.byteLength
  const idxBytes = idxArr.byteLength
  const idxPad = (4 - (idxBytes % 4)) % 4
  const binLength = posBytes + idxBytes + idxPad

  const bin = new Uint8Array(binLength)
  bin.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), 0)
  bin.set(new Uint8Array(idxArr.buffer, idxArr.byteOffset, idxBytes), posBytes)
  // 末尾留的补零不能省：buffers[0].byteLength 必须等于实际字节数，严格校验的加载器会核对

  const json = {
    asset: { version: '2.0', generator: 'dsh-modeler' },
    scene: 0,
    scenes: [{ nodes: [0], name: 'Scene' }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        mode: 4,
      }],
    }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
        min: bboxMin(positions), max: bboxMax(positions),
      },
      {
        bufferView: 1,
        componentType: useU16 ? 5123 : 5125,
        count: idxArr.length,
        type: 'SCALAR',
      },
    ],
  }
  return { json, bin, binLength }
}

/** 字节 → base64。浏览器走 btoa、Node 走 Buffer，两边都不引入依赖。 */
function bytesToBase64(u8) {
  if (typeof btoa === 'function') {
    let s = ''
    const CHUNK = 0x8000   // 一次 apply 太多参数会爆栈，分块拼
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
    }
    return btoa(s)
  }
  return Buffer.from(u8).toString('base64')
}

/** 二进制 glTF/GLB（单 mesh，POSITION + 索引，无材质） */
export function toGLB(positions, indices, name = 'dsh-modeler') {
  const { json: gltf, bin, binLength } = gltfParts(positions, indices, name)

  const jsonStr = JSON.stringify(gltf)
  const jsonBytes = new TextEncoder().encode(jsonStr)
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const jsonChunkLen = jsonBytes.length + jsonPad
  const total = 12 + 8 + jsonChunkLen + 8 + binLength

  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonChunkLen, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  u8.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20
  let off = 20 + jsonChunkLen
  dv.setUint32(off, binLength, true)
  dv.setUint32(off + 4, 0x004e4942, true) // 'BIN'
  off += 8
  u8.set(bin, off)
  return new Uint8Array(buf)
}

/**
 * 文本 glTF（`.gltf`）—— 单文件，缓冲内嵌成 data URI。
 *
 * 为什么不写"gltf + 外部 .bin"的两件套：这个插件的导出约定是"一个文件拿走就能用"，
 * 两件套一旦被移动/改名/单独发给别人，模型就废了。内嵌 base64 涨约 33% 体积，
 * 换来自包含 —— 在导出场景里这个取舍是划算的。想省体积就导 GLB（同一份布局，
 * 二进制块不做 base64）。
 */
export function toGLTF(positions, indices, name = 'dsh-modeler') {
  const { json, bin } = gltfParts(positions, indices, name)
  json.buffers = [{
    uri: `data:application/octet-stream;base64,${bytesToBase64(bin)}`,
    byteLength: bin.length,
  }]
  // 缩进 1 空格：人能读，又不像 2 空格那样把 10 MB 撑成 14 MB
  return JSON.stringify(json, null, 1) + '\n'
}

/**
 * 网格 → JSON（全模式通用的数据转储）。
 *
 * 定位：OBJ/STL/GLB 是**给三维软件**的，JSON 是**给程序和人**的 ——
 * 它把"这个网格是怎么来的"（哪个模式产的、雕刻参数、统计）和几何数据放进同一个文件，
 * 所以任何模式出的网格都能用同一种方式留档、比对、再加工。这也是它必须全模式可用的原因：
 * 网格结构在所有模式下都是同一个 `{ positions, indices }`，只有来源不同。
 *
 * 格式约定（`format` 字段自证，不用靠文件名猜）：
 *   positions —— 平铺的 x,y,z，每 3 个数一个顶点
 *   indices   —— 每 3 个数一张三角形，**0 起头**的顶点下标（OBJ 是 1 起头，别搞混）
 * 坐标按 1e-6 取整：远高于模型自身精度（归一化后最长边约 1），但能显著压体积 ——
 * 19 万顶点的网格从 20+ MB 降到 10 MB 左右。
 */
export function toMeshJSON(positions, indices, meta = {}) {
  const m = meta && typeof meta === 'object' ? meta : {}
  const pos = new Array(positions.length)
  for (let i = 0; i < positions.length; i++) pos[i] = round6(positions[i])

  return JSON.stringify({
    format: 'dsh-modeler.mesh',
    version: 1,
    name: String(m.name || 'model'),
    createdAt: m.createdAt || new Date().toISOString(),
    generator: 'dsh-modeler',
    // 来源由调用方按"实际产出这个网格的那条路"给出，不按当前 UI 模式猜
    source: String(m.source || 'unknown'),
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    precision: 1e-6,
    // 统计/参数可能是 null：AI 直接出的网格没有体素网格那些字段
    stats: m.stats || null,
    params: m.params || null,
    inputs: m.inputs || null,
    layout: {
      positions: '平铺 x,y,z —— 每 3 个数一个顶点',
      indices: '每 3 个数一张三角形，0 起头的顶点下标',
    },
    positions: pos,
    indices: Array.from(indices),
  }) + '\n'
}

function bboxMin(p) {
  const b = boundsOf(p)
  return [b.min[0], b.min[1], b.min[2]].map((v) => round6(v))
}

function bboxMax(p) {
  const b = boundsOf(p)
  return [b.max[0], b.max[1], b.max[2]].map((v) => round6(v))
}
const round6 = (v) => Math.round(v * 1e6) / 1e6

function triNormal(pos, a, b, c) {
  const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
  const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

const f = (v) => (Math.abs(v) < 1e-7 ? '0' : v.toFixed(6))

// ===========================================================================
// 反向：把体素/网格切回三视图（用于验证 + 给视觉模型看）
// ===========================================================================

/**
 * 用占据栅格渲染三张正交剪影（返回灰度 RGBA），供"重建是否忠实"的对照检查。
 * @param {Uint8Array} occupied @param {number} nx @param {number} ny @param {number} nz
 */
export function projectViews(occupied, nx, ny, nz, size = 256) {
  const at = (x, y, z) => occupied[(z * ny + y) * nx + x]
  const views = {}

  const make = (w, h, sample) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const on = sample(u / w, v / h) ? 255 : 0
        const p = (v * w + u) * 4
        data[p] = on; data[p + 1] = on; data[p + 2] = on; data[p + 3] = 255
      }
    }
    return { data, width: w, height: h }
  }

  // 前视图：沿 Z 压平（最靠 -Z 的实体面）
  const hw = Math.round((size * nx) / Math.max(nx, ny, nz))
  const hh = Math.round((size * ny) / Math.max(nx, ny, nz))
  const wTop = Math.round((size * nx) / Math.max(nx, ny, nz))
  const hTop = Math.round((size * nz) / Math.max(nx, ny, nz))
  const wSide = Math.round((size * nz) / Math.max(nx, ny, nz))
  const hSide = hh

  views.front = make(hw, hh, (u, v) => {
    const x = Math.min(nx - 1, (u * nx) | 0)
    const y = Math.min(ny - 1, ((1 - v) * ny) | 0)
    for (let z = 0; z < nz; z++) if (at(x, y, z)) return true
    return false
  })
  views.side = make(wSide, hSide, (u, v) => {
    const z = Math.min(nz - 1, (u * nz) | 0)
    const y = Math.min(ny - 1, ((1 - v) * ny) | 0)
    for (let x = 0; x < nx; x++) if (at(x, y, z)) return true
    return false
  })
  views.top = make(wTop, hTop, (u, v) => {
    const x = Math.min(nx - 1, (u * nx) | 0)
    const z = Math.min(nz - 1, (v * nz) | 0)
    for (let y = ny - 1; y >= 0; y--) if (at(x, y, z)) return true
    return false
  })
  return views
}

// ---------------------------------------------------------------------------
// 网格 → 体素（用于把多个 AI 重建结果放到同一栅格上取交集）
// ---------------------------------------------------------------------------

/** 点到三角形（顶点存成 9 个分量的数组）的最短距离平方 —— 标准实现 */
function pointTriDist2(px, py, pz, t) {
  const ax = t[0], ay = t[1], az = t[2]
  const bx = t[3], by = t[4], bz = t[5]
  const cx = t[6], cy = t[7], cz = t[8]

  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az

  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz

  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz
    return qx * qx + qy * qy + qz * qz
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz
    return qx * qx + qy * qy + qz * qz
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    const qx = bpx + w * (cx - bx), qy = bpy + w * (cy - by), qz = bpz + w * (cz - bz)
    return qx * qx + qy * qy + qz * qz
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  const qx = apx - (v * abx + w * acx)
  const qy = apy - (v * aby + w * acy)
  const qz = apz - (v * abz + w * acz)
  return qx * qx + qy * qy + qz * qz
}

/**
 * 把网格归一化到居中的单位立方体（最长边 = 1）。
 *
 * 为什么必须先做：三张图各自跑一遍 AI，得到的是三个**独立**的 mesh，它们的
 * 尺度和原点都不一样（不像视觉外壳那套共享同一个体素栅格）。不归一化就想取交集，
 * 等于拿三个不同坐标系的东西硬比，结果毫无意义。
 */
export function normalizeMesh(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = (positions[i] - cx) / span
    out[i + 1] = (positions[i + 1] - cy) / span
    out[i + 2] = (positions[i + 2] - cz) / span
  }
  return out
}

/**
 * 三角形网格 → 体素占据网格。
 *
 * 三步（标准的保守体素化）：
 *   1. **表面**：把每个三角形覆盖到的体素标为壳（判据是"体素中心到三角形距离 ≤ 体素尺度"）
 *   2. **外部**：从栅格六个面做 flood fill，凡是能从外面走到的都是外部
 *   3. **内部**：既不是壳也不是外部的，就是内部
 *
 * ⚠ 这要求输入网格**水密**。不水密的话 flood fill 会从破洞灌进去，把内部误标成外部，
 * 结果就空了。调用方应先确认 watertight（TripoSR 的输出是水密的，正好满足）。
 *
 * @param {Float32Array|number[]} positions 已归一化更稳妥（用 normalizeMesh）
 * @param {Uint32Array|number[]} indices
 * @param {number} res 长边体素数
 */
export function meshToVoxels(positions, indices, res = 64) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ
  const span = Math.max(spanX, spanY, spanZ) || 1
  const pad = 2

  // ⚠ 用**立方体栅格**（n×n×n），不要各轴按比例取整。
  //
  // 多视图融合要把几个 mesh 放到**同一**栅格上比较，而它们的包围盒比例各不相同
  // （正面视图的 AI 输出可能高瘦、俯视图的可能扁）。各轴分别取整会让三个栅格尺寸
  // 互不相同，mergeVoxelVotes 直接抛错 —— 这是自检跑出来的真实失败，不是假想。
  // 宁可浪费一些空格子，也必须保证尺寸一致。
  const n = Math.max(4, Math.round(res)) + pad * 2
  const nx = n, ny = n, nz = n
  const step = span / res
  // 物体在立方体栅格里居中（各轴跨度不同，起点要分别算）
  const half = (n * step) / 2
  const ox = (minX + maxX) / 2 - half
  const oy = (minY + maxY) / 2 - half
  const oz = (minZ + maxZ) / 2 - half

  const shell = new Uint8Array(nx * ny * nz)
  const at = (x, y, z) => (z * ny + y) * nx + x

  const t = new Float64Array(9)
  const vs = new Float64Array(9)
  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3
    for (let k = 0; k < 3; k++) {
      t[k] = positions[ia + k]
      t[3 + k] = positions[ib + k]
      t[6 + k] = positions[ic + k]
    }
    const lo = [0, 0, 0], hi = [0, 0, 0]
    const n = [nx, ny, nz]
    for (let k = 0; k < 3; k++) {
      const v0 = (t[k] - [ox, oy, oz][k]) / step
      const v1 = (t[3 + k] - [ox, oy, oz][k]) / step
      const v2 = (t[6 + k] - [ox, oy, oz][k]) / step
      lo[k] = Math.max(0, Math.floor(Math.min(v0, v1, v2) - 1))
      hi[k] = Math.min(n[k] - 1, Math.ceil(Math.max(v0, v1, v2) + 1))
      vs[k] = v0; vs[3 + k] = v1; vs[6 + k] = v2
    }
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let x = lo[0]; x <= hi[0]; x++) {
          const idx = at(x, y, z)
          if (shell[idx]) continue
          // 距离判据用 1.0（体素边长）而不是 0.5：宁可把壳做厚一点，
          // 也不要在薄处漏出破洞让后面的 flood fill 灌进来。
          if (pointTriDist2(x + 0.5, y + 0.5, z + 0.5, vs) <= 1.0) shell[idx] = 1
        }
      }
    }
  }

  // flood fill：从六个面起步，标记所有能从外部到达的空体素
  const outside = new Uint8Array(nx * ny * nz)
  const stack = []
  const push = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return
    const i = at(x, y, z)
    if (outside[i] || shell[i]) return
    outside[i] = 1
    stack.push(i)
  }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(0, y, z); push(nx - 1, y, z) }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x, 0, z); push(x, ny - 1, z) }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x, y, 0); push(x, y, nz - 1) }
  while (stack.length) {
    const i = stack.pop()
    const z = Math.floor(i / (nx * ny))
    const r = i - z * nx * ny
    const y = Math.floor(r / nx)
    const x = r - y * nx
    push(x - 1, y, z); push(x + 1, y, z)
    push(x, y - 1, z); push(x, y + 1, z)
    push(x, y, z - 1); push(x, y, z + 1)
  }

  const occupied = new Uint8Array(nx * ny * nz)
  let filled = 0
  for (let i = 0; i < occupied.length; i++) {
    if (!outside[i]) { occupied[i] = 1; filled++ }
  }

  return { occupied, nx, ny, nz, origin: [ox, oy, oz], step, filled, shellCount: shell.reduce((a, b) => a + b, 0) }
}

/**
 * 把若干个体素占据网格按"多数共识"合并。
 *
 * 为什么不是简单取交集：三个视图里只要有一个 AI 猜歪了（单图重建很常见），
 * 严格 AND 会把正确部分也一起削掉。所以默认用**多数票**（2/3 同意即保留），
 * 同时把严格交集的规模一并返回，让调用方/用户知道分歧有多大。
 */
export function mergeVoxelVotes(grids, { threshold = null } = {}) {
  if (!grids.length) return null
  const { nx, ny, nz } = grids[0]
  const n = nx * ny * nz
  const votes = new Uint8Array(n)
  for (const g of grids) {
    if (g.nx !== nx || g.ny !== ny || g.nz !== nz) {
      throw new Error('mergeVoxelVotes：各栅格尺寸不一致，必须先归一化到同一分辨率')
    }
    for (let i = 0; i < n; i++) if (g.occupied[i]) votes[i]++
  }

  // 默认阈值：过半（三个视图时是 2/3）
  const need = threshold == null ? Math.floor(grids.length / 2) + 1 : threshold

  const occupied = new Uint8Array(n)
  let kept = 0, unanimous = 0, anyVote = 0
  for (let i = 0; i < n; i++) {
    if (votes[i] >= grids.length) unanimous++
    if (votes[i] > 0) anyVote++
    if (votes[i] >= need) { occupied[i] = 1; kept++ }
  }

  return {
    occupied, nx, ny, nz,
    origin: grids[0].origin, step: grids[0].step,
    stats: {
      views: grids.length,
      needVotes: need,
      kept,
      unanimous,
      anyVote,
      // 分歧度：只有部分视图认可的体积占比。高 = 三个视图互相矛盾
      disagreement: anyVote ? 1 - unanimous / anyVote : 0,
    },
  }
}
