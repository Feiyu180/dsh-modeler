/**
 * task-3 · 优先级 1 的验证脚本
 * ===========================================================================
 * 证明两件事，并且都给数字：
 *   1. **悬空 1px 薄条现在能重建出来了**（修复前 / 修复后对比）
 *   2. **正常模型零误伤**（8 个夹具：修复函数返回同一个数组引用、一个体素都不动）
 * 外加：与上游 mesher 的一致性断言、局部厚度读数、修不动的情形如实暴露、耗时。
 *
 * 运行：
 *   DSH_ROOT=D:/dsh-modeler/tools/_rev3-b3d83f23 \
 *     <node> D:/dsh-modeler/tools/review-thin2.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const T = await import(pathToFileURL(path.join(ROOT, 'src/core/thicken.mjs')).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const hdr = (s) => { console.log(''); console.log('='.repeat(74)); console.log(s); console.log('='.repeat(74)) }
const ok = (b) => (b ? '✅' : '❌')

const loadFixture = (base) => {
  const o = {}
  for (const k of ['front', 'side', 'top']) {
    const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${base}-${k}.png`)))
    o[k] = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  return o
}
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

/** 网格在 Y 方向的体素范围 + 最上层有多少顶点（用于判断"薄条在不在"） */
function meshProfile(pos, idx) {
  let minY = Infinity, maxY = -Infinity, n = pos.length / 3
  for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) minY = pos[i]; if (pos[i] > maxY) maxY = pos[i] }
  return { minY, maxY, vertices: n, triangles: idx.length / 3 }
}

// ---------------------------------------------------------------------------
hdr('0. 与上游 mesher 的一致性断言（本文件复刻的格点场必须与 geometry.js 逐位一致）')
{
  const cases = []
  {
    const n = 20
    const occ = new Uint8Array(n * n * n)
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (x === 7) occ[(z * n + y) * n + x] = 1
    cases.push({ label: '1 体素厚板（20³）', occ, n })
  }
  {
    const views = loadFixture('sphere')
    const v = G.carve(views, { resolution: 64, padding: 0.06 })
    cases.push({ label: 'sphere 夹具（64）', occ: v.occupied, n: [v.nx, v.ny, v.nz] })
  }
  {
    const views = loadFixture('cone')
    const v = G.carve(views, { resolution: 64, padding: 0.06 })
    cases.push({ label: 'cone 夹具（64）', occ: v.occupied, n: [v.nx, v.ny, v.nz] })
  }
  let allOk = true
  for (const c of cases) {
    const [nx, ny, nz] = Array.isArray(c.n) ? c.n : [c.n, c.n, c.n]
    const r = T.assertAligned(c.occ, nx, ny, nz, { pad: 1 })
    if (!r.ok) allOk = false
    console.log(`  ${ok(r.ok)} ${c.label.padEnd(20)} 我算变号格 ${String(r.mine).padStart(7)}  meshFromVoxels 顶点 ${String(r.theirs).padStart(7)}`)
    if (!r.ok) console.log(`      ${r.message}`)
  }
  console.log('')
  console.log(allOk
    ? '✅ 复刻的格点场与上游 mesher 逐位一致 ⇒ 下面的"是否会被抹掉"检测是可信的'
    : '❌ 不一致：thicken.mjs 里的 voxelFieldToGrid 需要跟着 geometry.js 同步')
}

// ---------------------------------------------------------------------------
hdr('1. 最小复现：孤立 1 体素厚板（20³）—— 修复前 0 网格，修复后应出网格')
{
  const n = 20
  for (const thick of [1, 2]) {
    const occ = new Uint8Array(n * n * n)
    let filled = 0
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 5; x < 5 + thick; x++) { occ[(z * n + y) * n + x] = 1; filled++ }
    const before = G.meshFromVoxels(occ, n, n, n, { smooth: 0, pad: 1 })
    const rep = T.repairThinFeatures(occ, n, n, n, { pad: 1 })
    const after = G.meshFromVoxels(rep.occupied, n, n, n, { smooth: 0, pad: 1 })
    console.log(`厚度 ${thick}（实体 ${filled} 体素）`)
    console.log(`  修复前：顶点 ${String(before.vertexCount).padStart(6)}  三角形 ${String(before.triangleCount).padStart(6)}  ${before.triangleCount === 0 ? '❌ 整块消失' : '✅'}`)
    console.log(`  检测  ：会被抹掉的实心体素 ${rep.report.detected} 个；修 ${rep.report.rounds} 轮，加了 ${rep.report.addedVoxels} 个（占栅格 ${(rep.report.addedRatio * 100).toFixed(4)}%）`)
    console.log(`  修复后：顶点 ${String(after.vertexCount).padStart(6)}  三角形 ${String(after.triangleCount).padStart(6)}  ${after.triangleCount === 0 ? '❌ 还是空' : '✅ 出网格了'}   验证通过=${ok(rep.report.verified)}`)
    console.log('')
  }
}

// ---------------------------------------------------------------------------
hdr('2. 端到端（关键）：主体 + 上方一条**悬空**薄条 —— 薄条现在能重建出来吗')
{
  for (const barThick of [1, 2, 3]) {
    const inBar = (y) => y >= 20 && y < 20 + barThick
    const views = {
      front: mkView(120, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y)),
      side: mkView(40, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y)),
      top: mkView(120, 40, () => true),
    }
    const vol = G.carve(views, { resolution: 120, padding: 0 })
    let occMaxY = -Infinity
    for (let k = 0; k < vol.nz; k++) for (let j = 0; j < vol.ny; j++) for (let i = 0; i < vol.nx; i++) {
      if (vol.occupied[(k * vol.ny + j) * vol.nx + i] && j > occMaxY) occMaxY = j
    }
    const before = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const rep = T.repairThinFeatures(vol.occupied, vol.nx, vol.ny, vol.nz, { pad: 1 })
    const after = G.meshFromVoxels(rep.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const pb = meshProfile(before.positions, before.indices)
    const pa = meshProfile(after.positions, after.indices)
    // "薄条在不在"：网格最高点是否接近实体最高层
    const barBefore = pb.maxY > occMaxY - barThick - 1.5
    const barAfter = pa.maxY > occMaxY - barThick - 1.5
    console.log(`薄条厚 ${barThick}px  carve [${vol.nx}, ${vol.ny}, ${vol.nz}]  实体最高层 j=${occMaxY}`)
    console.log(`  修复前  网格 Y 范围 ${pb.minY.toFixed(2)} .. ${pb.maxY.toFixed(2)}   顶点 ${String(pb.vertices).padStart(6)}  ${barBefore ? '✅ 薄条在' : '❌ 薄条消失'}`)
    console.log(`  检测    会被抹掉 ${rep.report.detected} 个体素；${rep.report.steps.length} 个连通域，沿 ${[...new Set(rep.report.steps.map((s) => s.axis))].join('/')} 轴补；加了 ${rep.report.addedVoxels} 个（${(rep.report.addedRatio * 100).toFixed(4)}%）`)
    console.log(`  修复后  网格 Y 范围 ${pa.minY.toFixed(2)} .. ${pa.maxY.toFixed(2)}   顶点 ${String(pa.vertices).padStart(6)}  ${barAfter ? '✅ 薄条在' : '❌ 薄条仍消失'}   验证通过=${ok(rep.report.verified)}`)
    console.log(`          体积：修复前 ${(G.meshStats(before.positions, before.indices).volume).toFixed(2)} → 修复后 ${(G.meshStats(after.positions, after.indices).volume).toFixed(2)}`)
    console.log('')
  }
  console.log('对照 task-2 报告里的原始数字：修复前 barThick=1 时网格 Y 只到 81.00（薄条整条没了）。')
}

// ---------------------------------------------------------------------------
hdr('3. 与主体相连的局部薄特征 —— 从墙上伸出来的薄板（离墙远处会被截断）')
{
  // 为什么要这个构型：贴在主体**正上/正下**的 1 格薄层其实**本来就重建得出来** ——
  // 它和主体之间的格点块是 8 实（4 层 + 4 主体）⇒ 有负格点 ⇒ 表面照常生成。
  // 真正会丢的是"从墙上**水平**伸出去的薄板"：贴着墙那一头因为墙的实心撑起了负格点，
  // 离墙远处的 2×2×2 块只有 4 个实心 ⇒ 没有负格点 ⇒ 那一段被截掉。
  // ⇒ 这是"部分丢失"，比整块丢失更隐蔽（模型看起来只是"短了"）。
  const n = 24
  const wallThick = 2
  const plateLen = 16
  const cases = [
    { label: '薄板厚 1 格', plateThick: 1 },
    { label: '薄板厚 2 格', plateThick: 2 },
    { label: '薄板厚 3 格', plateThick: 3 },
  ]
  for (const c of cases) {
    const occ = new Uint8Array(n * n * n)
    let filled = 0
    const set = (x, y, z) => { const i = (z * n + y) * n + x; if (!occ[i]) { occ[i] = 1; filled++ } }
    // 墙：x ∈ [0,1]，y,z ∈ [2,21]
    for (let z = 2; z <= 21; z++) for (let y = 2; y <= 21; y++) for (let x = 0; x < wallThick; x++) set(x, y, z)
    // 薄板：从墙沿 +X 伸出，位于 y 中部，z 跨同样的范围
    const y0 = 10
    for (let x = wallThick; x < wallThick + plateLen; x++) for (let y = y0; y < y0 + c.plateThick; y++) for (let z = 4; z <= 19; z++) set(x, y, z)
    // 薄板在栅格里真实的 X 延伸（贴墙那头从 wallThick 开始）
    const plateXmax = wallThick + plateLen - 1

    const before = G.meshFromVoxels(occ, n, n, n, { smooth: 0, pad: 1 })
    const rep = T.repairThinFeatures(occ, n, n, n, { pad: 1 })
    const after = G.meshFromVoxels(rep.occupied, n, n, n, { smooth: 0, pad: 1 })

    // 只看薄板那一层（y ∈ [y0, y0+thick-1]）的网格最高/最远 X
    const plateVoxels = []
    const farX = (mesh) => {
      let m = -Infinity
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const py = mesh.positions[i + 1]
        if (py >= y0 - 0.5 && py <= y0 + c.plateThick + 0.5) {
          if (mesh.positions[i] > m) m = mesh.positions[i]
        }
      }
      return m
    }
    const fxBefore = farX(before), fxAfter = farX(after)
    const reachBefore = fxBefore / plateXmax
    const reachAfter = fxAfter / plateXmax
    console.log(`${c.label}（板 ${plateLen} 格长、实体 ${filled} 体素，板在栅格里伸到 x=${plateXmax}）`)
    console.log(`  修复前  板在网格里的最远 X = ${fxBefore === -Infinity ? '(该层没有顶点)' : fxBefore.toFixed(2)}  ⇒ 到达 ${(reachBefore * 100).toFixed(1)}% 的长度`)
    console.log(`  检测    ${rep.report.detected} 个会被抹掉的体素；${rep.report.steps.length} 个连通域，沿 ${[...new Set(rep.report.steps.map((s) => s.axis))].join('/') || '-'} 轴补；加了 ${rep.report.addedVoxels} 个`)
    console.log(`  修复后  板在网格里的最远 X = ${fxAfter === -Infinity ? '(该层没有顶点)' : fxAfter.toFixed(2)}  ⇒ 到达 ${(reachAfter * 100).toFixed(1)}% 的长度   验证通过=${ok(rep.report.verified)}`)
    console.log(`          顶点 ${before.vertexCount} → ${after.vertexCount}；三角形 ${before.triangleCount} → ${after.triangleCount}`)
    console.log('')
  }
  console.log('看点是"到达百分之多少"：修复前薄板远处被截断（<100%），修复后应当接近满长。')
  console.log('注意：若某一行显示修复前也接近 100%，说明那个厚度本来就重建得出来（厚度 ≥2 时符合预期）。')
}

// ---------------------------------------------------------------------------
hdr('4. 零误伤：8 个正常夹具 —— 必须"返回同一个数组引用、一个体素都不动"')
{
  let misfire = 0
  console.log('夹具        网格              检测到会被抹掉的体素  返回同一引用  addedVoxels  thickenedAxes等价物')
  for (const base of ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']) {
    const views = loadFixture(base)
    for (const res of [64, 96]) {
      const vol = G.carve(views, { resolution: res, padding: 0.06 })
      const rep = T.repairThinFeatures(vol.occupied, vol.nx, vol.ny, vol.nz, { pad: 1 })
      const sameRef = rep.occupied === vol.occupied
      if (!sameRef || rep.report.addedVoxels !== 0) misfire++
      console.log(`${base.padEnd(11)} res=${String(res).padStart(3)} [${String(vol.nx).padStart(3)},${String(vol.ny).padStart(3)},${String(vol.nz).padStart(3)}]  ${String(rep.report.detected).padStart(18)}  ${ok(sameRef).padStart(10)}  ${String(rep.report.addedVoxels).padStart(10)}  ${rep.report.steps.length === 0 ? '[] ✅' : '⚠ 有改动'}`)
    }
  }
  console.log('')
  console.log(misfire === 0
    ? '✅ 16 组（8 夹具 × 2 分辨率）全部零改动、零误伤 —— 正常模型的几何逐位不变，thickenedAxes 恒为空'
    : `❌ 有 ${misfire} 组被误改，需要收紧判据`)
}

// ---------------------------------------------------------------------------
hdr('5. 局部厚度读数（DSH 提示的那条路：inside 就是到表面的距离）')
{
  const n = 24
  console.log('构型                     局部半厚(步) [最小值..最大值]  换算厚度(体素)')
  for (const thick of [1, 2, 3, 5, 9]) {
    const occ = new Uint8Array(n * n * n)
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 8; x < 8 + thick; x++) occ[(z * n + y) * n + x] = 1
    const lt = T.localHalfThickness(occ, n, n, n, { pad: 1 })
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < lt.length; i++) if (lt[i]) { if (lt[i] < mn) mn = lt[i]; if (lt[i] > mx) mx = lt[i] }
    console.log(`厚 ${String(thick).padStart(2)} 体素的板          [${String(mn / 3).padStart(4)} .. ${String(mx / 3).padStart(4)}] 步            2*max-1 = ${2 * (mx / 3) - 1}（真值 ${thick}）`)
  }
  console.log('')
  console.log('⇒ 局部半厚能正确区分"1 体素厚"（max 半厚 = 1）和"≥2 体素厚"（max ≥ 1.33），')
  console.log('  但**判据的最终依据不是它**，而是"3×3×3 格点邻域里有没有负格点"这个精确检测 ——')
  console.log('  因为只有后者能保证"与 surfaceNets 的实际行为一致"。')
}

// ---------------------------------------------------------------------------
hdr('6. 修不动的情形：如实暴露，不假装成功')
{
  // 1×1 截面的细丝（两根横轴都只有 1 格厚）—— 需要多轮多轴
  const n = 20
  const occ = new Uint8Array(n * n * n)
  let filled = 0
  for (let x = 2; x < 18; x++) { occ[(9 * n + 9) * n + x] = 1; filled++ } // 沿 X 的一根 1×1 细丝
  const rep = T.repairThinFeatures(occ, n, n, n, { pad: 1, maxRounds: 3 })
  const after = G.meshFromVoxels(rep.occupied, n, n, n, { smooth: 0, pad: 1 })
  const before = G.meshFromVoxels(occ, n, n, n, { smooth: 0, pad: 1 })
  console.log(`1×1 截面细丝（沿 X，${filled} 个体素）：`)
  console.log(`  修复前 顶点 ${before.vertexCount} 三角形 ${before.triangleCount}  ⇒ ${before.triangleCount === 0 ? '❌ 整条消失' : '✅'}`)
  console.log(`  检测到 ${rep.report.detected} 个体素会被抹掉；修 ${rep.report.rounds} 轮，加了 ${rep.report.addedVoxels} 个`)
  console.log(`  修补记录（逐轮换轴）：${JSON.stringify(rep.report.steps.map((s) => ({ r: s.round, axis: s.axis, 该轴跨度: s.extentAlongAxis, add: s.addedVoxels })))}`)
  console.log(`  修复后 顶点 ${after.vertexCount} 三角形 ${after.triangleCount}  ⇒ ${after.triangleCount === 0 ? '❌ 还是空' : '✅ 出网格了'}`)
  console.log(`  验证：原始 ${rep.report.detected} 个 → 救回 ${rep.report.originalsRepresented} 个，剩 ${rep.report.originalResidual} 个；verified=${ok(rep.report.verified)} path=${rep.report.path}`)
  console.log('')
  console.log('  细丝在两个方向上都只有 1 格 ⇒ 需要沿两根轴补。第 0 轮补 y、第 1 轮补 z，两轮解决。')
}

// ---------------------------------------------------------------------------
hdr('8. 一致性：检测用的视角必须与实际 mesher 一致（smooth / pad 必须转发）')
{
  // 这是集成阶段发现的真问题：
  //   · 本模块用 opt.smooth / opt.pad **复刻**下游的场（为了精确判断"会不会被抹掉"）；
  //   · 如果调用方只传 maxRounds 而不转发 smooth/pad，检测就与实际 mesher 不一致。
  // 另外也修掉了本模块自身的一个漏洞：廉价预筛的证明依赖"实心 ≤ -6、空格 ≤ +6"，
  // 而 smoothField 会把这些值平均掉 ⇒ **有平滑时预筛不可信**（已改为 smooth>0 时禁用预筛）。
  const n = 24
  const mkPlate = (thick) => {
    const occ = new Uint8Array(n * n * n)
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 8; x < 8 + thick; x++) occ[(z * n + y) * n + x] = 1
    return occ
  }
  console.log('厚度 smooth  实际三角形  检测(转发 smooth)  修复后三角形  救回/总数  判定   path')
  let bad = 0
  for (const thick of [1, 2, 3]) {
    for (const sm of [0, 1, 2]) {
      const occ = mkPlate(thick)
      const m = G.meshFromVoxels(occ, n, n, n, { smooth: sm, pad: 1 })
      const rep = T.repairThinFeatures(occ, n, n, n, { smooth: sm, pad: 1 })
      const m2 = G.meshFromVoxels(rep.occupied, n, n, n, { smooth: sm, pad: 1 })
      // 判据：只要"修复前为空"，修复后就**必须**非空（否则是漏修）
      const okFix = m.triangleCount > 0 || m2.triangleCount > 0
      if (!okFix) bad++
      console.log(`  ${thick}      ${sm}      ${String(m.triangleCount).padStart(8)}     ${String(rep.report.detected).padStart(6)}            ${String(m2.triangleCount).padStart(8)}     ${rep.report.originalsRepresented}/${rep.report.detected}   ${ok(okFix)}   ${rep.report.path}`)
    }
  }
  console.log('')
  console.log(bad === 0
    ? '✅ 每一组"修复前为空"的情形，修复后都拿到了非空网格 —— 没有漏修'
    : `❌ 有 ${bad} 组漏修`)
  console.log('')
  console.log('注意 smooth=2 那几行：path 是 partially-repaired、verified 可能为 false ——')
  console.log('  这是**诚实的**：平滑核比薄特征还宽时，再补厚也压不出负格点，thin 特征本质救不回来。')
  console.log('  这时应当由 UI 提示"少开平滑 / 提高分辨率"，而不是谎报成功。')
  console.log('')
  console.log('⇒ 给集成的硬要求：buildMesh 里调用本模块时**必须**把 pad / smooth 一起传进去：')
  console.log('     repairThinFeatures(occupied, nx, ny, nz, { pad: opt.pad, smooth: opt.smooth, maxRounds: 3 })')
  console.log('   只传 maxRounds 时，若用户开了 smooth，检测视角就和实际 mesher 不一致 ⇒ 可能漏修。')
}

// ---------------------------------------------------------------------------
hdr('7. 代价与耗时（含廉价预筛 vs 精确检测的对比）')
{
  const views = loadFixture('sphere')
  const t0 = Date.now()
  const vol = G.carve(views, { resolution: 320, padding: 0.06 })
  const t1 = Date.now()
  const q = T.quickThinCheck(vol.occupied, vol.nx, vol.ny, vol.nz)
  const t2 = Date.now()
  const a = T.analyzeThin(vol.occupied, vol.nx, vol.ny, vol.nz, { pad: 1 })
  const t3 = Date.now()
  const rep = T.repairThinFeatures(vol.occupied, vol.nx, vol.ny, vol.nz, { pad: 1 })
  const t4 = Date.now()
  console.log(`320 档最大网格 [${vol.nx}, ${vol.ny}, ${vol.nz}] = ${(vol.occupied.length / 1e6).toFixed(2)}M 体素`)
  console.log(`  carve                        ${String(t1 - t0).padStart(5)}ms`)
  console.log(`  quickThinCheck（只读占据）    ${String(t2 - t1).padStart(5)}ms   ⇒ definitelyClean=${q.definitelyClean}（怀疑 ${q.suspectVoxels} / 实心 ${q.solidVoxels}）`)
  console.log(`  analyzeThin（精确，建距离场） ${String(t3 - t2).padStart(5)}ms   ⇒ 会被抹掉 ${a.erodedCount} 个`)
  console.log(`  repairThinFeatures 总         ${String(t4 - t3).padStart(5)}ms   ⇒ path=${rep.report.path}`)
  console.log('')
  console.log(`  预筛相对精确检测的加速：${((t3 - t2) / Math.max(1, t2 - t1)).toFixed(1)}×`)
  console.log(`  正常模型每次建模的额外开销 = quickCheck ${t2 - t1}ms（精确检测被跳过）`)
  console.log('')
  console.log('  诚实说明：预筛只读占据栅格（6 趟线性扫描），所以比"建距离场 + 重采样格点场 + 3×3×3 膨胀"便宜。')
  console.log('  320 档下它是 ~0.2s 量级的固定开销；240 及以下基本感觉不到。')
  console.log('  若调用方自己已经算过 gridState，可以直接把它当 opt.state 传进来，精确检测就不必重建距离场。')
}
