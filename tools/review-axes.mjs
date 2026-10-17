/**
 * 独立审查脚本 A：三视图 → 世界的坐标轴映射（最容易错、错了还"看起来像"）。
 *
 * 方法：不走仓库里的任何断言，直接
 *   1) 把 PNG 解成剪影，打印尺寸/内容框；
 *   2) carve() 后核对体素维度；
 *   3) 拿**左右不对称**的夹具，把「前视图每列的最高点」和「体素栅格每列的 Y 最大值」
 *      逐列比对，并且同时比一遍镜像版 —— 谁的相关性高就是谁。
 *   4) 用 buildMesh 再确认一遍世界坐标（归一化只是中心+缩放，不翻转）。
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-axes.mjs
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
  const dims = {}
  for (const k of ['front', 'side', 'top']) {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${base}-${k}.png`)))
    const s = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
    o[k] = s
    dims[k] = { w: png.width, h: png.height, c: png.channels, bb: s.bbox, thr: s.threshold, alpha: s.alphaUsed }
  }
  return { views: o, dims }
}

const pearson = (a, b) => {
  const n = a.length
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let sa = 0, sb = 0, sab = 0
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y }
  return sab / Math.sqrt(sa * sb || 1)
}

// ---------------------------------------------------------------------------
hdr('A-1 夹具尺寸与 carve 后的体素维度（resolution=内容最长边, padding=0 ⇒ scale=1）')
const boxes = {}
for (const base of ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']) {
  const { views, dims } = load(base)
  // resolution 取"内容最长边" ⇒ scale 恰好为 1，于是 nx/ny/nz 应等于内容框的像素尺寸。
  // 这是最干净的判据：不依赖任何魔法数字。
  const longest = Math.max(
    dims.front.bb.width, dims.top.bb.width, dims.front.bb.height,
    dims.side.bb.height, dims.side.bb.width, dims.top.bb.height,
  )
  const v = G.carve(views, { resolution: longest, padding: 0 })
  // resolution 会被 carve 夹到 [8, 320]；tiny 的内容最长边只有 6px，所以 scale 不等于 1。
  const effRes = Math.max(8, Math.min(320, longest))
  const effScale = effRes / longest
  const want = [
    Math.max(2, Math.round(dims.front.bb.width * effScale)),   // nx ← front.width（或 top.width）
    Math.max(2, Math.round(dims.front.bb.height * effScale)),  // ny ← front.height（或 side.height）
    Math.max(2, Math.round(dims.top.bb.height * effScale)),    // nz ← top.height（或 side.width）
  ]
  const ok = v.nx === want[0] && v.ny === want[1] && v.nz === want[2]
  const d = dims
  console.log(
    `${base.padEnd(10)} front ${d.front.w}×${d.front.h}(bb ${d.front.bb.width}×${d.front.bb.height})` +
    `  side ${d.side.w}×${d.side.h}(bb ${d.side.bb.width}×${d.side.bb.height})` +
    `  top ${d.top.w}×${d.top.h}(bb ${d.top.bb.width}×${d.top.bb.height})`,
  )
  console.log(`${''.padEnd(10)} resolution=${longest} → [${v.nx}, ${v.ny}, ${v.nz}]  期望 [${want.join(', ')}]  ${ok ? '✅' : '❌'}  filled=${v.filled} scale=${v.scale.toFixed(5)}${effRes !== longest ? `（resolution 被夹到 ${effRes}，故 scale=${effScale.toFixed(3)}≠1）` : ''}`)
  boxes[base] = { views, v }
}
console.log('')
console.log('映射规则（geometry.js 顶部注释）：front u→X, v→Y 反向；side u→Z, v→Y 反向；top u→X, v→Z')
console.log('box 夹具（120×60 / 40×60 / 120×40）在 scale=1 时 nx=120 ny=60 nz=40 —— 与注释一致。')

// ---------------------------------------------------------------------------
hdr('A-2 左右镜像检查：asym（前视图左半更高）')
{
  const { views, v } = boxes['asym']
  const f = views.front

  // 前视图：每像素列的最高实体行 → 高度（像素）
  const profPix = []
  for (let x = 0; x < f.width; x++) {
    let top = f.height
    for (let y = 0; y < f.height; y++) if (f.mask[y * f.width + x]) { top = y; break }
    profPix.push(f.height - top)
  }
  // 体素：每 i 列的最大 j（Y）
  const profVox = []
  for (let i = 0; i < v.nx; i++) {
    let best = -1
    for (let k = 0; k < v.nz; k++) for (let j = 0; j < v.ny; j++) {
      if (v.occupied[(k * v.ny + j) * v.nx + i]) { if (j > best) best = j }
    }
    profVox.push(best + 1)
  }
  // 把两列归一到 [0,1] 后按归一化位置采样对比
  const sample = (arr, u) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(u * arr.length)))]
  const N = 200
  const pv = [], pfFwd = [], pfRev = []
  for (let n = 0; n < N; n++) {
    const u = (n + 0.5) / N
    pv.push(sample(profVox, u))
    pfFwd.push(sample(profPix, u))       // 不镜像
    pfRev.push(sample(profPix, 1 - u))   // 镜像
  }
  const cF = pearson(pv, pfFwd)
  const cR = pearson(pv, pfRev)
  console.log(`前视图最高点轮廓（前 10 列像素高度）：${profPix.slice(0, 10).join(', ')} …（左半高=100，右半=50）`)
  console.log(`体素栅格 Ymax 轮廓（前 10 列）：        ${profVox.slice(0, 10).join(', ')} …`)
  console.log('')
  console.log(`相关性  不镜像 vs 体素 = ${cF.toFixed(5)}`)
  console.log(`相关性  镜像   vs 体素 = ${cR.toFixed(5)}`)
  console.log(cF > cR
    ? '✅ 不镜像的相关性更高 ⇒ 前视图左边的高台阶落在体素栅格的**小 i（-X 侧）**，没有左右翻转'
    : '❌ 镜像的相关性更高 ⇒ 存在左右翻转')
  console.log('')
  // 更硬的判据：直接看左右两半的"高台阶"占比
  const leftTallPix = profPix.slice(0, Math.floor(f.width / 2)).filter((h) => h > f.height * 0.6).length
  const rightTallPix = profPix.slice(Math.ceil(f.width / 2)).filter((h) => h > f.height * 0.6).length
  const leftTallVox = profVox.slice(0, Math.floor(v.nx / 2)).filter((h) => h > v.ny * 0.6).length
  const rightTallVox = profVox.slice(Math.ceil(v.nx / 2)).filter((h) => h > v.ny * 0.6).length
  console.log(`前视图：左半高台阶列数=${leftTallPix}，右半=${rightTallPix}   ⇒ 高的一侧在**左**`)
  console.log(`体素栅格：i< nx/2 高台阶列数=${leftTallVox}，i>=nx/2=${rightTallVox} ⇒ 高的一侧在**${leftTallVox > rightTallVox ? '小 i' : '大 i'}**`)
  console.log(leftTallVox > rightTallVox && leftTallPix > rightTallPix
    ? '✅ 一致：前视图左侧更高 ⇒ 模型 -X 侧更高（i 小 = X 小 = -X 侧）'
    : '❌ 不一致')
}

// ---------------------------------------------------------------------------
hdr('A-3 世界坐标再确认（buildMesh 归一化是否引入翻转）')
{
  const { views } = boxes['asym']
  const m = G.buildMesh(views, { resolution: 120, padding: 0 })
  // 归一化只做 (p-c)*k，k>0 ⇒ 符号不变。用质心相对量验证：
  let sxL = 0, sxR = 0, nL = 0, nR = 0
  let minx = Infinity, maxx = -Infinity
  for (let i = 0; i < m.positions.length; i += 3) {
    if (m.positions[i] < minx) minx = m.positions[i]
    if (m.positions[i] > maxx) maxx = m.positions[i]
  }
  const mid = (minx + maxx) / 2
  // 用"高处顶点"的平均 X 判断高台阶在哪一侧
  let hiY = -Infinity
  for (let i = 1; i < m.positions.length; i += 3) if (m.positions[i] > hiY) hiY = m.positions[i]
  let sumHi = 0, cntHi = 0, sumLo = 0, cntLo = 0
  for (let i = 0; i < m.positions.length; i += 3) {
    if (m.positions[i + 1] > hiY * 0.75) { sumHi += m.positions[i]; cntHi++ } else { sumLo += m.positions[i]; cntLo++ }
  }
  console.log(`归一化后顶点数=${m.positions.length / 3}，X 范围 [${minx.toFixed(4)}, ${maxx.toFixed(4)}]（mid=${mid.toFixed(4)}）`)
  console.log(`高处顶点(y > 0.75*ymax) 的平均 X = ${(sumHi / cntHi).toFixed(4)}（n=${cntHi}）`)
  console.log(`其余顶点的平均 X            = ${(sumLo / cntLo).toFixed(4)}（n=${cntLo}）`)
  console.log(sumHi / cntHi < sumLo / cntLo
    ? '✅ 高处顶点平均 X 更负 ⇒ 高台阶在 -X 侧，归一化没有翻转方向'
    : '❌ 高处顶点偏 +X ⇒ 方向反了')
  console.log(`meta.grid = [${m.meta.grid.join(', ')}]，volume = ${m.meta.volume.toFixed(6)}`)
}

// ---------------------------------------------------------------------------
hdr('A-4 重投影一致性：原样 / 左右镜像 / 上下翻转 三选一（双方都先裁到内容框）')
{
  // 关键：输入剪影和重投影都先裁到各自的内容框再比。
  // 否则像 tiny（200×200 图里只有 6×6 内容）会因为留白比例不同而得出无意义的低 IoU。
  const cropMask = (mask, w, h) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1
    const out = new Uint8Array(cw * ch)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = mask[(y0 + y) * w + x0 + x] ? 1 : 0
    return { mask: out, width: cw, height: ch }
  }
  const toGrid = (m, N, mirror, flipV) => {
    const g = new Uint8Array(N * N)
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const sx = mirror ? N - 1 - c : c
      const sy = flipV ? N - 1 - r : r
      const px = Math.min(m.width - 1, Math.floor(sx * m.width / N))
      const py = Math.min(m.height - 1, Math.floor(sy * m.height / N))
      g[r * N + c] = m.mask[py * m.width + px] ? 1 : 0
    }
    return g
  }
  const iou = (a, b) => {
    let i = 0, u = 0
    for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++ }
    return u ? i / u : 1
  }
  const N = 128
  const report = []
  for (const base of ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']) {
    const { views, v } = boxes[base]
    const proj = G.projectViews(v.occupied, v.nx, v.ny, v.nz, 240)
    const row = { base }
    for (const k of ['front', 'side', 'top']) {
      const inRaw = views[k]
      const inp = cropMask(inRaw.mask, inRaw.width, inRaw.height)
      const outRaw = proj[k]
      const om = new Uint8Array(outRaw.width * outRaw.height)
      for (let i = 0; i < om.length; i++) om[i] = outRaw.data[i * 4] ? 1 : 0
      const outp = cropMask(om, outRaw.width, outRaw.height)
      const ref = toGrid(outp, N, false, false)
      row[k] = {
        iou: iou(toGrid(inp, N, false, false), ref),
        iouMir: iou(toGrid(inp, N, true, false), ref),
        iouFlipV: iou(toGrid(inp, N, false, true), ref),
        inpBox: `${inp.width}×${inp.height}`,
        outBox: `${outp.width}×${outp.height}`,
      }
    }
    report.push(row)
  }
  const f3 = (x) => x.toFixed(3)
  console.log('夹具        视图   输入内容框  重投影内容框  IoU(原样)  IoU(左右镜像)  IoU(上下翻转)  判定')
  let warn = 0
  for (const r of report) {
    for (const k of ['front', 'side', 'top']) {
      const x = r[k]
      const best = Math.max(x.iou, x.iouMir, x.iouFlipV)
      const tag = best === x.iou ? '原样最佳 ✅' : best === x.iouMir ? '左右镜像更佳 ⚠' : '上下翻转更佳 ⚠'
      if (best !== x.iou) warn++
      console.log(`${r.base.padEnd(11)} ${k.padEnd(6)} ${x.inpBox.padStart(10)}  ${x.outBox.padStart(12)}  ${f3(x.iou).padStart(9)}  ${f3(x.iouMir).padStart(12)}  ${f3(x.iouFlipV).padStart(12)}   ${tag}`)
    }
  }
  console.log('')
  console.log(warn === 0
    ? '✅ 24 组（8 夹具 × 3 视图）全部"原样最佳"，没有任何一个视图能被左右镜像或上下翻转解释得更好'
    : `⚠ 有 ${warn} 组不是"原样最佳"，需要进一步查看`)
  console.log('说明：重投影要先体素量化再投影，所以即使是完美重建 IoU 也会略低于 1；只看相对高低。')
}

// ---------------------------------------------------------------------------
hdr('A-5 各视图的"每内容像素多少体素"是否真的被统一？（注释声称避免拉伸）')
{
  // geometry.js 的 carve 注释写：「每张视图各自的内容框被映射到世界盒的对应面，
  // 并统一到同一个「每内容像素多少体素」的尺度，避免不同视图被拉伸」。
  // 这句话成立的前提是三视图内容框自洽：front.width == top.width、
  // top.height == side.width、front.height == side.height。
  // 一旦不自洽，每个视图会各自铺满世界盒 —— 也就是被拉伸。这里把它算出来。
  console.log('夹具        视图(u轴)  内容像素   映射到体素数  拉伸比   ')
  let bad = []
  for (const base of ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']) {
    const { views, v } = boxes[base]
    const f = [
      ['front u→X', views.front.bbox.width, v.nx],
      ['front v→Y', views.front.bbox.height, v.ny],
      ['side  u→Z', views.side.bbox.width, v.nz],
      ['side  v→Y', views.side.bbox.height, v.ny],
      ['top   u→X', views.top.bbox.width, v.nx],
      ['top   v→Z', views.top.bbox.height, v.nz],
    ]
    const ratios = f.map((x) => x[2] / x[1])
    const consistent = (() => {
      const [fu, fv, su, sv, tu, tv] = ratios
      // 同一个世界轴的放大倍数应当一致（容差 5%，覆盖 round 带来的误差）
      const same = (a, b) => Math.abs(a - b) / Math.max(a, b) < 0.05
      return same(fu, tu) && same(su, tv) && same(fv, sv)
    })()
    if (!consistent) bad.push(base)
    for (const [label, px, vox] of f) {
      console.log(`${base.padEnd(11)} ${label}  ${String(px).padStart(6)}    ${String(vox).padStart(8)}   ${(vox / px).toFixed(4)}`)
    }
    console.log(`${''.padEnd(11)} ⇒ 三视图自洽？${consistent ? '是（所有视图同一世界轴放大倍数一致）' : '否 —— 至少一个视图相对别的视图被非等比拉伸'}`)
  }
  console.log('')
  if (bad.length) {
    console.log(`⚠ 自相矛盾的夹具：${bad.join(', ')}`)
    console.log('   它们的 front.width 与 top.width（或 front.height 与 side.height）不相等，')
    console.log('   于是"同一个每像素尺度"这个前提不成立，carve 会静默地把某个视图拉长/压扁，')
    console.log('   而**不会报错、也不会告警**。注意 lshape / torus-ish 是本仓库自带的夹具。')
    console.log('   ⇒ 这是真问题（中）：对自相矛盾的输入应拒绝或warn，而不是给出被拉伸的模型。')
  } else {
    console.log('✅ 所有夹具三视图自洽，"统一尺度、避免拉伸"的说法成立')
  }
}
