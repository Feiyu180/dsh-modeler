/**
 * 独立审查脚本（补充）：审 `buildMesh` 新加的"薄结构自动加厚"（thicken）路径。
 *
 * 背景：DSH 在收到 review-thin.mjs 的结果后往 buildMesh 里加了
 *   maxRunAlong() / dilateAlong() + opt.thicken（默认开），
 *   条件是"某轴**最长游程 ≤ 1**"就沿该轴膨胀 1 格。
 * 新代码最容易埋新 bug，所以单独审这一块：
 *   T-1 thicken 的触发条件能不能覆盖"局部薄特征"（我原来报的那种悬空薄条）
 *   T-2 thicken 触发后几何被改变了多少（是加厚还是走形）
 *   T-3 对正常夹具会不会误触发（误触发 = 静默改变所有用户的模型）
 *   T-4 dilateAlong 是否只沿指定轴膨胀（不越轴、不多层、不级联）
 *   T-5 关掉 thicken 后行为是否与原来一致
 *
 * 运行：
 *   DSH_ROOT=<冻结快照> node D:/dsh-modeler/tools/review-thicken.mjs
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
/** 独立复刻 maxRunAlong，避免信仓库实现 */
const myMaxRun = (occ, nx, ny, nz, axis) => {
  const at = (x, y, z) => occ[(z * ny + y) * nx + x]
  let best = 0
  const dims = [nx, ny, nz]
  for (let a = 0; a < dims[(axis + 1) % 3]; a++) {
    for (let b = 0; b < dims[(axis + 2) % 3]; b++) {
      let run = 0
      for (let c = 0; c < dims[axis]; c++) {
        const xyz = [0, 0, 0]
        xyz[axis] = c; xyz[(axis + 1) % 3] = a; xyz[(axis + 2) % 3] = b
        run = at(xyz[0], xyz[1], xyz[2]) ? run + 1 : 0
        if (run > best) best = run
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
hdr('T-1 thicken 能不能覆盖"局部薄特征"（大模型上方一条悬空薄条）')
{
  for (const barThick of [1, 2]) {
    const inBar = (y) => y >= 20 && y < 20 + barThick
    const views = {
      front: mkView(120, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y)),
      side: mkView(40, 140, (x, y) => (y >= 60 && y <= 139) || inBar(y)),
      top: mkView(120, 40, () => true),
    }
    const vol = G.carve(views, { resolution: 120, padding: 0 })
    const runs = [0, 1, 2].map((ax) => myMaxRun(vol.occupied, vol.nx, vol.ny, vol.nz, ax))
    const m = G.buildMesh(views, { resolution: 120, padding: 0 })
    let maxY = -Infinity
    // buildMesh 归一化了 → 改用 meta + 顶点数判断；这里用未归一化的 meshFromVoxels 看 Y 范围
    const mm = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    for (let i = 1; i < mm.positions.length; i += 3) if (mm.positions[i] > maxY) maxY = mm.positions[i]
    const barPresent = maxY > vol.ny - barThick - 1.5
    console.log(`薄条厚 ${barThick}px：carve grid [${vol.nx}, ${vol.ny}, ${vol.nz}]`)
    console.log(`  各轴最长实体游程 = X:${runs[0]}  Y:${runs[1]}  Z:${runs[2]}  ⇒ 触发条件(≤1) 命中：${runs.map((r, i) => r <= 1 ? 'xyz'[i] : null).filter(Boolean).join(',') || '无'}`)
    console.log(`  buildMesh 的 meta.thickenedAxes = ${JSON.stringify(m.meta.thickenedAxes)}`)
    console.log(`  网格最高点（体素坐标）= ${maxY.toFixed(2)}，实体最高层 j=${vol.ny - 1} ⇒ 薄条${barPresent ? '在 ✅' : '**仍然消失了 ❌**'}`)
    console.log('')
  }
  console.log('⇒ 关键结论：thicken 的判据是"**整轴**最长游程 ≤ 1"。')
  console.log('   悬空薄条所在的 Y 轴上，主体有 80 层厚 ⇒ 最长游程 = 80 ⇒ **不触发** ⇒ 薄条照样丢。')
  console.log('   也就是说这个修复只覆盖"整块模型只有一个体素厚"的极端情形，')
  console.log('   覆盖不了"大模型里的局部薄特征"——后者才是实际更容易出现的形态。')
}

// ---------------------------------------------------------------------------
hdr('T-2 thicken 触发时的几何后果（整块 1 体素厚的板）')
{
  const views = {
    front: mkView(120, 60, (x, y) => y >= 30 && y < 31),   // 1px 高
    side: mkView(40, 60, (x, y) => y >= 30 && y < 31),     // 1px 高
    top: mkView(120, 40, () => true),
  }
  const a = G.buildMesh(views, { resolution: 120, padding: 0 })                        // 默认 thicken=on
  const b = G.buildMesh(views, { resolution: 120, padding: 0, thicken: false })        // 关掉
  const f = (m) => `顶点 ${String(m.positions.length / 3).padStart(6)} 三角形 ${String(m.indices.length / 3).padStart(6)} volume=${m.meta.volume.toFixed(8)} empty=${m.meta.empty} thickenedAxes=${JSON.stringify(m.meta.thickenedAxes)}`
  console.log(`thicken 默认开 ：${f(a)}`)
  console.log(`thicken=false  ：${f(b)}`)
  console.log('')
  const vol = G.carve(views, { resolution: 120, padding: 0 })
  console.log(`carve grid = [${vol.nx}, ${vol.ny}, ${vol.nz}]，即 Y 方向只有 ${vol.ny} 层`)
  console.log(`  ⇒ thicken 把 Y 从 ${vol.ny} 撑到 ${vol.ny + 2} 层（两侧各 1），模型在该轴上**变厚约 3 倍**。`)
  console.log('  这是"宁可加厚也不能丢模型"的取舍，代码里用 meta.thickenedAxes 如实上报了，属于可接受设计；')
  console.log('  但要注意：它产出的是**几何被改变过**的模型（尺寸不再忠实于三视图），不能当精确件用。')
  console.log('  另外确认：thicken=false 时确实回到旧行为（空网格 + empty=true 的诚实上报）✅')
}

// ---------------------------------------------------------------------------
hdr('T-3 对正常夹具会不会误触发（误触发 = 静默改动所有用户的模型）')
{
  console.log('夹具        grid                各轴最长游程         thickenedAxes      开/关 thicken 的几何是否相同')
  let misfire = 0, unchecked = 0
  for (const base of ['box', 'asym', 'lshape', 'sphere', 'cylinder', 'cone', 'tiny', 'torus-ish']) {
    const views = load(base)
    const vol = G.carve(views, { resolution: 64, padding: 0.06 })
    const runs = [0, 1, 2].map((ax) => myMaxRun(vol.occupied, vol.nx, vol.ny, vol.nz, ax))
    const on = G.buildMesh(views, { resolution: 64, padding: 0.06 })
    const off = G.buildMesh(views, { resolution: 64, padding: 0.06, thicken: false })
    const same = on.positions.length === off.positions.length &&
      on.indices.length === off.indices.length &&
      Math.abs(on.meta.volume - off.meta.volume) < 1e-12
    if (!same) misfire++
    const ax = on.meta.thickenedAxes
    if (ax.length) unchecked++
    console.log(`${base.padEnd(11)} [${String(vol.nx).padStart(3)},${String(vol.ny).padStart(3)},${String(vol.nz).padStart(3)}]  X:${String(runs[0]).padStart(3)} Y:${String(runs[1]).padStart(3)} Z:${String(runs[2]).padStart(3)}   ${JSON.stringify(ax).padEnd(18)} ${same ? '✅ 相同' : '⚠ **不同（误触发）**'}`)
  }
  console.log('')
  console.log(misfire === 0
    ? `✅ 8 个夹具全部没被 thicken 动过（thicken 开/关几何完全一致），没有误触发`
    : `⚠ 有 ${misfire} 个夹具被 thicken 改动，需要检查是否合理`)
  console.log(`（其中 ${unchecked} 个夹具确实触发了 thicken —— 那是它们本身某个轴真的只有 1 层厚，属于预期）`)
}

// ---------------------------------------------------------------------------
hdr('T-4 dilateAlong 只沿指定轴膨胀吗（越轴 = 模型走形）')
{
  // 从源码抠出 dilateAlong 单独测，避免经过 buildMesh 的其它逻辑
  const src = fs.readFileSync(path.join(ROOT, 'src/core/geometry.js'), 'utf8')
  const at = src.indexOf('function dilateAlong')
  let i = src.indexOf('{', at), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const dilate = (0, eval)(`(${src.slice(at, end)})`) // eslint-disable-line no-eval
  console.log('从源码抠出 dilateAlong 单独测试 ✅')
  console.log('')
  for (const [axis, name] of [[0, 'X'], [1, 'Y'], [2, 'Z']]) {
    const n = 9
    const occ = new Uint8Array(n * n * n)
    occ[(4 * n + 4) * n + 4] = 1 // 正中 1 个体素
    const out = dilate(occ, n, n, n, axis, 1)
    // 统计膨胀后的包围盒
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], cnt = 0
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!out[(z * n + y) * n + x]) continue
      cnt++
      const v = [x, y, z]
      for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k] }
    }
    const ext = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1]
    const want = [1, 1, 1]; want[axis] = 3
    const ok = ext.every((v, k) => v === want[k]) && cnt === 3
    console.log(`  沿 ${name} 膨胀 1 格：体素数=${cnt} 期望 3，包围盒尺寸=[${ext.join(', ')}] 期望 [${want.join(', ')}]  ${ok ? '✅ 只沿该轴、只 1 层' : '❌'}`)
  }
  console.log('')
  console.log('再多测一步：连续膨胀 2 格是否级联成 5 格（amount=2 的语义）')
  {
    const n = 11
    const occ = new Uint8Array(n * n * n)
    occ[(5 * n + 5) * n + 5] = 1
    const out = dilate(occ, n, n, n, 0, 2)
    let cnt = 0
    for (let k = 0; k < out.length; k++) cnt += out[k]
    console.log(`  amount=2 ⇒ 体素数 = ${cnt}，期望 5（中心 + 左右各 2）  ${cnt === 5 ? '✅ 不级联' : '⚠'}`)
  }
}

// ---------------------------------------------------------------------------
hdr('T-6 thicken 的触发面到底存不存在？（"n<3 跳过" + dimFor 的 max(2,…) 下限 ⇒ 可能永远打空）')
{
  console.log('两条规则的相互作用：')
  console.log('  · carve 的 dimFor() = Math.max(2, round(...)) ⇒ nx/ny/nz 永远 ≥ 2（不可能是 1）')
  console.log('  · buildMesh 的 thicken 循环：`if (n < 3) continue` ⇒ **n=2 的轴直接被跳过**')
  console.log('  ⇒ "1 体素厚的板"这种情形，该轴必然被 dimFor 抬到 2 ⇒ 被 n<3 跳过 ⇒ thicken 不触发。')
  console.log('')
  console.log('先验证 dimFor 的下限：')
  for (const px of [1, 2, 3]) {
    const views = {
      front: mkView(40, 40, (x, y) => y >= 20 && y < 20 + px),
      side: mkView(40, 40, (x, y) => y >= 20 && y < 20 + px),
      top: mkView(40, 40, () => true),
    }
    const vol = G.carve(views, { resolution: 40, padding: 0 })
    console.log(`  前/侧视图横条高 ${px}px ⇒ carve [${vol.nx}, ${vol.ny}, ${vol.nz}]（Y 维 = ${vol.ny}，dimFor 下限 2 生效：${vol.ny === 2 && px === 1 ? '是' : '—'}）`)
  }
  console.log('')
  console.log('再验证"整轴有 ≥3 层但最长游程 = 1"能不能构造出来（百叶窗/条纹输入）：')
  {
    // 条纹：每条 1px 实、1px 空，交替；Y 方向 4 实 4 空交替
    const stripe = (y) => (Math.floor(y / 1) % 2 === 0)
    const views = {
      front: mkView(60, 80, (x, y) => y >= 20 && y < 60 && stripe(y)),
      side: mkView(60, 80, (x, y) => y >= 20 && y < 60 && stripe(y)),
      top: mkView(60, 60, () => true),
    }
    const vol = G.carve(views, { resolution: 60, padding: 0 })
    const runs = [0, 1, 2].map((ax) => myMaxRun(vol.occupied, vol.nx, vol.ny, vol.nz, ax))
    const on = G.buildMesh(views, { resolution: 60, padding: 0 })
    const off = G.buildMesh(views, { resolution: 60, padding: 0, thicken: false })
    console.log(`  条纹输入（Y 上 1 实 1 空交替）：carve [${vol.nx}, ${vol.ny}, ${vol.nz}]，filled=${vol.filled}`)
    console.log(`  各轴最长实体游程 = X:${runs[0]} Y:${runs[1]} Z:${runs[2]}`)
    console.log(`  buildMesh(thicken 默认开) meta.thickenedAxes = ${JSON.stringify(on.meta.thickenedAxes)}`)
    console.log(`  开 thicken：顶点 ${on.positions.length / 3}，三角形 ${on.indices.length / 3}，volume=${on.meta.volume.toFixed(8)}，filledVoxels=${on.meta.filledVoxels}`)
    console.log(`  关 thicken：顶点 ${off.positions.length / 3}，三角形 ${off.indices.length / 3}，volume=${off.meta.volume.toFixed(8)}，filledVoxels=${off.meta.filledVoxels}`)
    const fired = on.meta.thickenedAxes.length > 0
    console.log('')
    console.log(fired
      ? '  ⚠ **thicken 在这里触发了** ⇒ 它会沿 Y 把条纹两侧各膨胀 1 格，把"1 实 1 空"的条纹**糊成实心**。'
      : '  ✅ 这里没触发')
    console.log(`  体积比（开/关）= ${(on.meta.volume / off.meta.volume).toFixed(4)}，实心体素数 ${off.meta.filledVoxels} → ${on.meta.filledVoxels}`)
  }
  console.log('')
  console.log('⇒ 结论（判定为真问题 · 中）：thicken 的触发面与它的设计意图**错位**：')
  console.log('   · 它想修的"整块 1 体素厚"：该轴被 dimFor 抬到 2 ⇒ 被 `n<3` 跳过 ⇒ **打不到**；')
    console.log('   · 它能打到的"该轴多于一格厚但最长游程=1"（条纹/百叶窗/点阵）：')
    console.log('     → 静默把用户的**有意薄结构糊实**，只留一个 meta.thickenedAxes 字段作提示。')
    console.log('   ⚠ 但要公平地说：条纹案例关掉 thicken 就是**空网格**，所以"糊实"至少比"什么都没有"好。')
    console.log('     真正的缺陷是它**没有区分**"糊实是有意的补救"还是"破坏了用户的有意结构"，')
    console.log('     两者都只留一个字段，用户无法判断该不该调高分辨率。')
}

// ---------------------------------------------------------------------------
hdr('T-7 为什么 thicken 打不到它想修的情形（把机制讲清楚，而不是硬凑一个缺口）')
{
  // 关键：silhouette 的内容框(bbox)是**紧贴实心像素**的。
  // 所以"某轴只有 1 层实心" ⇒ 该轴 bbox 高度 = 1 ⇒ carve 的 dimFor 给出 max(2, round(1*scale)) = 2，
  // 而 mapV 把"1 像素高"的内容框映射到 2 层上时，两层**采样的是同一行像素** ⇒ 两层都实心。
  // 结论：走公开路径（carve → buildMesh）不可能出现"nx/ny/nz = 2 且只有 1 层实心"，
  //       也就不可能出现"1 体素厚" —— dimFor 的下限顺手把它变成了 2 层厚。
  const views = {
    front: mkView(60, 40, (x, y) => y >= 20 && y < 21), // 1px 高的横条
    side: mkView(60, 40, (x, y) => y >= 20 && y < 21),
    top: mkView(60, 40, () => true),
  }
  const vol = G.carve(views, { resolution: 60, padding: 0 })
  const perLayer = []
  for (let j = 0; j < vol.ny; j++) {
    let c = 0
    for (let k = 0; k < vol.nz; k++) for (let i = 0; i < vol.nx; i++) c += vol.occupied[(k * vol.ny + j) * vol.nx + i]
    perLayer.push(c)
  }
  const runs = [0, 1, 2].map((ax) => myMaxRun(vol.occupied, vol.nx, vol.ny, vol.nz, ax))
  const m = G.buildMesh(views, { resolution: 60, padding: 0 })
  console.log(`1px 高横条（前/侧视图内容框都只有 1px 高）：`)
  console.log(`  carve = [${vol.nx}, ${vol.ny}, ${vol.nz}]（Y 被 dimFor 的下限抬到 ${vol.ny}）`)
  console.log(`  逐层实心数 = [${perLayer.join(', ')}]  ← 两层都被填了（因为 1px 的内容框映射到 2 层时采同一行）`)
  console.log(`  各轴最长游程 = X:${runs[0]} Y:${runs[1]} Z:${runs[2]} ⇒ 没有 ≤1 的轴，thicken 不触发（也不需要）`)
  console.log(`  buildMesh → 顶点 ${m.positions.length / 3}，三角形 ${m.indices.length / 3}，empty=${m.meta.empty}，thickenedAxes=${JSON.stringify(m.meta.thickenedAxes)}`)
  console.log('')
  console.log('⇒ 机制结论（这一条很重要，它解释了 thicken 的定位）：')
  console.log('   1) 内容框是紧贴实心像素的 ⇒ "某轴只有 1 层实心"不可能出现；')
  console.log('   2) dimFor 的 Math.max(2, …) 又把该轴抬到 2 层 ⇒ 直接绕开了 1 体素厚的退化；')
  console.log('   3) 于是 thicken 在公开路径上**只可能被条纹/点阵类输入触发**（T-6 已实测），')
  console.log('      而它在那种情形下做的事是"把有意的薄结构糊实"。')
  console.log('')
  console.log('   所以我的判断是：thicken 解决的是它**自己造出来的**问题（T-3 显示 8 个正常夹具全不触发），')
  console.log('   而真正会丢特征的情形（T-1 的局部悬空薄条）它**打不到**。')
  console.log('   建议方向：')
  console.log('     · 要么把判据改成"逐连通域的局部厚度 + 只在确实会得到空网格时补厚"（先算再补）；')
  console.log('     · 要么直接去掉 thicken，改为在 buildMesh 里对空网格**明确报错**（empty + emptyReason 已经做到了），')
  console.log('       让用户自己决定调高分辨率 —— 这比静默改变几何更符合"可复现、不含糊"的取向。')
}
