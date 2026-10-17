/**
 * 独立审查脚本（追加发现）：**1 体素厚的特征会被整条抹掉**。
 *
 * 起因：测 removeSmallIslands 的连通性时，发现两个孤立体素（对角相接）经
 *       meshFromVoxels 后得到 0 顶点 0 三角形，而 meshStats 报 watertight=true。
 * 顺着查下来根因在 voxelFieldToGrid 的 8 邻域平均上：
 *   实心体素的 field = -(inside + 3)，紧贴表面的实心格 inside=3 ⇒ field = -6；
 *   相邻空格 field = +6。**两边幅值相等、符号相反**，
 *   于是"跨过一个表面"的格点平均出来正好是 0；而 surfaceNets 用 `v < 0` 判内部，
 *   0 算外部 ⇒ 整块 1 体素厚的薄片没有任何负格点 ⇒ 等值面为空。
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-thin.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)

const hdr = (s) => { console.log(''); console.log('='.repeat(72)); console.log(s); console.log('='.repeat(72)) }

/** 独立复刻 voxelFieldToGrid，用来把 field 变成格点值看中间过程 */
function gridFromField(field, nx, ny, nz) {
  const S = nx, T = nx * ny
  const gx = nx + 1, gy = ny + 1, gz = nz + 1
  const out = new Int32Array(gx * gy * gz)
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
    let sum = 0, cnt = 0
    for (let dz = -1; dz <= 0; dz++) { const zz = z + dz; if (zz < 0 || zz >= nz) continue
      for (let dy = -1; dy <= 0; dy++) { const yy = y + dy; if (yy < 0 || yy >= ny) continue
        for (let dx = -1; dx <= 0; dx++) { const xx = x + dx; if (xx < 0 || xx >= nx) continue
          sum += field[zz * T + yy * S + xx]; cnt++ } } }
    out[z * gx * gy + y * gx + x] = cnt ? Math.round(sum / cnt) : 0
  }
  return { grid: out, gx, gy, gz }
}

// ---------------------------------------------------------------------------
hdr('薄板厚度扫描：厚度 1..5 体素，看网格还在不在')
{
  const N = 20
  console.log('厚度 体素数  顶点数   三角形数  watertight  meshStats.volume   结论')
  for (let thick = 1; thick <= 5; thick++) {
    const occ = new Uint8Array(N * N * N)
    let filled = 0
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 5; x < 5 + thick; x++) {
      occ[(z * N + y) * N + x] = 1; filled++
    }
    const m = G.meshFromVoxels(occ, N, N, N, { smooth: 0, pad: 1 })
    const st = G.meshStats(m.positions, m.indices)
    const alive = st.triangleCount > 0
    console.log(`  ${thick}   ${String(filled).padStart(6)}  ${String(st.vertexCount).padStart(6)}  ${String(st.triangleCount).padStart(8)}  ${String(st.watertight).padStart(10)}  ${st.volume.toFixed(6).padStart(16)}   ${alive ? '✅ 有网格' : '❌ 模型整体消失'}`)
  }
  console.log('')
  console.log('⇒ 厚度 1 的板**完全消失**（0 顶点 0 三角形），厚度 ≥2 才出生。')
}

// ---------------------------------------------------------------------------
hdr('根因：把中间的格点值打出来（厚度 1 vs 2 vs 3）')
{
  const N = 12
  for (const thick of [1, 2, 3]) {
    const occ = new Uint8Array(N * N * N)
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 5; x < 5 + thick; x++) occ[(z * N + y) * N + x] = 1
    const { field, nx, ny, nz } = G.distanceField(occ, N, N, N, { pad: 1 })
    const { grid, gx, gy, gz } = gridFromField(field, nx, ny, nz)
    // 取 y、z 都远离边界的那条 x 扫描线（避免边界效应干扰）
    const yc = Math.floor(gy / 2), zc = Math.floor(gz / 2)
    const line = []
    for (let x = 0; x < gx; x++) line.push(grid[(zc * gy + yc) * gx + x])
    const negCount = line.filter((v) => v < 0).length
    console.log(`厚度 ${thick}：格点扫描线 x=0..${gx - 1} 的 grid 值 = [${line.join(', ')}]`)
    console.log(`         负格点数 = ${negCount}  ⇒ ${negCount > 0 ? '存在内部格点，等值面可生成' : '**一个负格点都没有 ⇒ surfaceNets 无面可建**'}`)
    // 也把体素域 field 打出来对照
    const vline = []
    for (let x = 0; x < nx; x++) vline.push(field[(zc * ny + yc) * nx + x])
    console.log(`         体素域 field 同一条线 = [${vline.join(', ')}]`)
    console.log('')
  }
  console.log('机制：跨表面的格点平均"4 个 -6 + 4 个 +6 = 0"，而 surfaceNets 用 `v < 0` 判内部，')
  console.log('      0 被算作外部。厚度 1 时**每个格点都恰好是 0**，于是没有任何等值面。')
  console.log('      厚度 ≥2 时中间会出现 8 个实心的格点（值 -6），负格点才出现。')
}

// ---------------------------------------------------------------------------
hdr('端到端复现：从三视图剪影走完整管线（不经过 PNG，直接手工造 silhouette 结果）')
{
  const mkView = (w, h, on) => {
    const mask = new Uint8Array(w * h)
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (on(x, y)) {
        mask[y * w + x] = 1
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
    const count = mask.reduce((a, b) => a + b, 0)
    return { mask, width: w, height: h, threshold: 0.5, alphaUsed: false,
      bbox: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 }, coverage: count / (w * h) }
  }

  for (const barThick of [1, 2]) {
    // 前视图：一条水平横杆（高 barThick px，宽 120）
    const front = mkView(120, 60, (x, y) => y >= 30 && y < 30 + barThick)
    // 侧视图：同样一条横杆（高 barThick px，宽 40）⇒ 模型在 Y 上就只有 barThick 体素厚
    const side = mkView(40, 60, (x, y) => y >= 30 && y < 30 + barThick)
    // 俯视图：满矩形
    const top = mkView(120, 40, () => true)
    const views = { front, side, top }

    const vol = G.carve(views, { resolution: 120, padding: 0 })
    const m = G.buildMesh(views, { resolution: 120, padding: 0 })
    const st = G.meshStats(m.positions, m.indices)
    console.log(`横杆高 ${barThick}px  ⇒ carve [${vol.nx}, ${vol.ny}, ${vol.nz}] filled=${vol.filled}`)
    console.log(`                  模型：顶点 ${st.vertexCount}，三角形 ${st.triangleCount}，watertight=${st.watertight}，volume=${st.volume.toFixed(8)}`)
    console.log(`                  ${st.triangleCount > 0 ? '✅ 出网格了' : '❌ **模型完全为空，但没有任何报错**'}`)
    console.log('')
  }
  console.log('注意：carve 对"雕刻结果为空"有显式抛错，但 meshFromVoxels / buildMesh 对')
  console.log('      "网格为空"完全沉默 —— 面板上会看到一个空的视口，而 host 的 modeler_save')
  console.log('      统计里 watertight=true、volume=0，看不出是失败。')
  console.log('')
  console.log('补充：上面 1px 与 2px 的结果**一样**，是因为 carve 的 dimFor() 有 Math.max(2, …)')
  console.log('      下限，把"整体只占 1 个体素"的维度兜到了 2。这层保护只覆盖**整体包围盒**，')
  console.log('      覆盖不了**大模型内部的薄特征** —— 见下一节。')
}

// ---------------------------------------------------------------------------
hdr('端到端复现（关键）：大模型上方一条**悬空**的 1 体素厚薄条，会静默消失')
{
  const mkView = (w, h, on) => {
    const mask = new Uint8Array(w * h)
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (on(x, y)) {
        mask[y * w + x] = 1
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
    return { mask, width: w, height: h, threshold: 0.5, alphaUsed: false,
      bbox: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 },
      coverage: mask.reduce((a, b) => a + b, 0) / (w * h) }
  }

  // 主体：图像 y ∈ [60,139]（贴底）；薄条：图像 y ∈ [20, 20+t)，与主体之间有 y ∈ [20+t, 59] 的空隙。
  // 三视图内容框自洽：front.width=120=top.width；side.width=40=top.height；front.height=side.height。
  for (const barThick of [1, 2, 3]) {
    const inBar = (y) => y >= 20 && y < 20 + barThick
    const front = mkView(120, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y))
    const side = mkView(40, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y))
    const top = mkView(120, 40, () => true)
    const views = { front, side, top }

    const vol = G.carve(views, { resolution: 120, padding: 0 })
    // 用未归一化的 meshFromVoxels，直接读体素坐标下的包围盒
    const mm = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const st = G.meshStats(mm.positions, mm.indices)
    let minY = Infinity, maxY = -Infinity
    for (let i = 1; i < mm.positions.length; i += 3) { if (mm.positions[i] < minY) minY = mm.positions[i]; if (mm.positions[i] > maxY) maxY = mm.positions[i] }
    // 栅格里的实体 Y 范围
    let occMinY = Infinity, occMaxY = -Infinity
    for (let k = 0; k < vol.nz; k++) for (let j = 0; j < vol.ny; j++) for (let i = 0; i < vol.nx; i++) {
      if (vol.occupied[(k * vol.ny + j) * vol.nx + i]) { if (j < occMinY) occMinY = j; if (j > occMaxY) occMaxY = j }
    }
    const barPresent = maxY > occMaxY - barThick - 1.5
    console.log(`薄条厚 ${barThick}px ⇒ carve [${vol.nx}, ${vol.ny}, ${vol.nz}]，实体 j 范围 ${occMinY}..${occMaxY}`)
    console.log(`  网格 Y 范围（体素坐标）= ${minY.toFixed(3)} .. ${maxY.toFixed(3)}，顶点 ${st.vertexCount}，三角形 ${st.triangleCount}`)
    console.log(`  ${barPresent ? '✅ 薄条建出来了' : '❌ **薄条消失了**（模型只剩主体），且没有任何报错'}`)
    console.log('')
  }
  console.log('对照判据：栅格里实体最高层是薄条（j = occMaxY），网格最高点应当接近 occMaxY+1。')
  console.log('          barThick=1 时网格最高点只有 ~80（主体顶面），说明薄条整条没被建出来；')
  console.log('          barThick≥2 时网格会一直延伸到 ~120（含薄条）。')
  console.log('')
  console.log('这就是最有害的表现形态：**部分特征静默丢失**。注意这里 watertight 仍是 true（网格本身是闭合的），')
  console.log('只是少了那条薄条/肋/天线 —— 没有任何异常：体积/水密/三角形数全都"正常"。')
}

// ---------------------------------------------------------------------------
hdr('空网格的对外表现：meshStats / buildMesh 对空输入说什么')
{
  const empty = { positions: new Float32Array(0), indices: new Uint32Array(0) }
  const st = G.meshStats(empty.positions, empty.indices)
  console.log(`空网格 → vertexCount=${st.vertexCount} triangleCount=${st.triangleCount} volume=${st.volume}`)
  console.log(`         watertight=${st.watertight}  boundaryEdges=${st.boundaryEdges}  nonManifoldEdges=${st.nonManifoldEdges}`)
  console.log(`         bbox.min=[${st.bbox.min}]  bbox.max=[${st.bbox.max}]  extent=[${st.extent}]`)
  console.log('')
  console.log('⇒ 旧版把"水密"当成空集合上的空真（没有边 ⇒ 既无边界边也无非流形边 ⇒ watertight=true）。')
  console.log('  host 的 modeler_save 曾因此对空网格吐出"网格水密，可以直接 3D 打印"。')
  // 用 buildMesh 走一遍正常通路里的空网格
  const mkView = (w, h, on) => ({ mask: Uint8Array.from({ length: w * h }, (_, i) => (on(i % w, (i / w) | 0) ? 1 : 0)), width: w, height: h, bbox: null })
  const occ = new Uint8Array(20 * 20 * 20)
  for (let y = 0; y < 20; y++) for (let z = 0; z < 20; z++) occ[(z * 20 + y) * 20 + 10] = 1 // 1 体素厚的竖墙
  const m = G.meshFromVoxels(occ, 20, 20, 20, { smooth: 0, pad: 1 })
  const st2 = G.meshStats(m.positions, m.indices)
  console.log(`1 体素厚竖墙（400 个实心体素）→ 顶点 ${st2.vertexCount}，三角形 ${st2.triangleCount}，watertight=${st2.watertight}，empty=${st2.empty}，volume=${st2.volume}`)
  console.log('  也就是说：**输入明明有 400 个体素，输出却是空模型。**')
  console.log('  （当前冻结版本已修：meshStats 对空网格返回 empty=true / watertight=false，不再谎报水密。）')
}
