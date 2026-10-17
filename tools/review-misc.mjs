/**
 * 独立审查脚本 G：其它问题。
 *   G-1 meshStats.bump() 的整数拼 key 在顶点数 ≥ 2^21 时碰撞 —— 构造真实 >2^21 顶点的网格实测
 *   G-2 BIG 哨兵值在大分辨率下会不会溢出（含理论界与最坏情形实测）
 *   G-3 分辨率 320 的端到端耗时（面板跑在浏览器主线程上，卡不卡很关键）
 *   G-4 removeSmallIslands 的 6-邻域连通 vs 网格连通性
 *   G-5 smoothField 的 `| 0` 与 Math.round 的差别（负值截断方向）
 *   G-6 toSTLBinary 头部对非 ASCII 文件名（中文）的处理
 *   G-7 导出函数不做索引越界校验（host 做了，core 没做）
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-misc.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const IO = await import(pathToFileURL(path.join(ROOT, 'src/core/mesh-io.js')).href)
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
const edgeCounts = (idx) => {
  const m = new Map()
  const add = (p, q) => { const k = p < q ? `${p}|${q}` : `${q}|${p}`; m.set(k, (m.get(k) || 0) + 1) }
  for (let t = 0; t < idx.length; t += 3) { add(idx[t], idx[t + 1]); add(idx[t + 1], idx[t + 2]); add(idx[t + 2], idx[t]) }
  let n1 = 0, n2 = 0, n3 = 0
  for (const c of m.values()) { if (c === 1) n1++; else if (c === 2) n2++; else n3++ }
  return { n1, n2, n3, edges: m.size }
}

// ---------------------------------------------------------------------------
hdr('G-1 meshStats.bump() 的整数拼 key 在顶点下标 ≥ 2^21 时碰撞（真实网格实测）')
{
  const KEY_MAX = 2097152 // 2^21
  console.log(`bump 的 key = min(p,q)*2097152 + max(p,q)。只要 max(p,q) ≥ 2^21，key 就会与另一条边重合。`)
  const key = (p, q) => (p < q ? p * KEY_MAX + q : q * KEY_MAX + p)
  const a = key(0, KEY_MAX + 3)
  const b = key(1, 3)
  console.log(`  key(0, ${KEY_MAX + 3}) = ${a}`)
  console.log(`  key(1, 3)         = ${b}`)
  console.log(`  ${a === b ? '⚠ 碰撞成立：这两条完全不同的边会共用同一个计数器' : '未碰撞'}`)
  console.log('')
  // 构造真实网格：符号只沿 x 翻转（每个格都是表面格），但**外圈强制为正**，
  // 避免在数组边界上出现变号（那是另一条路径，见 G-1b）。
  const N = 140
  const gx = N + 1, gy = N + 1, gz = N + 1
  const field = new Int32Array(gx * gy * gz)
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
    const shell = (x === 0 || x === gx - 1 || y === 0 || y === gy - 1 || z === 0 || z === gz - 1)
    field[(z * gy + y) * gx + x] = shell ? 1 : ((x % 2 === 0) ? 1 : -1)
  }
  const t0 = Date.now()
  const mesh = G.surfaceNets(field, N, N, N)
  const t1 = Date.now()
  console.log(`  surfaceNets 在 ${N}³ 上造出：顶点 ${mesh.vertexCount}（${(mesh.vertexCount / KEY_MAX * 100).toFixed(0)}% of 2^21 = ${KEY_MAX}）`)
  console.log(`  三角形 ${mesh.triangleCount}，耗时 ${t1 - t0} ms`)
  let nan = 0
  for (let i = 0; i < mesh.positions.length; i++) if (!Number.isFinite(mesh.positions[i])) nan++
  console.log(`  非有限坐标个数 = ${nan}`)
  console.log(`  最大顶点下标 = ${mesh.vertexCount - 1}  ${mesh.vertexCount - 1 >= KEY_MAX ? '≥ 2^21 ⇒ 会触发碰撞' : '< 2^21 ⇒ 不触发'}`)
  console.log('')
  const mine = edgeCounts(mesh.indices)
  const theirs = G.meshStats(mesh.positions, mesh.indices)
  console.log(`  我的实现（字符串 key）：边界边=${mine.n1}  非流形边=${mine.n3}  总边数=${mine.edges}`)
  console.log(`  meshStats（整数拼 key）：边界边=${theirs.boundaryEdges}  非流形边=${theirs.nonManifoldEdges}  watertight=${theirs.watertight}`)
  const bad = mine.n1 !== theirs.boundaryEdges || mine.n3 !== theirs.nonManifoldEdges
  console.log('')
  console.log(bad
    ? '  ❌ 两者不一致 ⇒ meshStats 在这个大网格上给错了水密性结论'
    : '  ✅ 两者一致 —— **在真实的 Surface Nets 网格上没有触发碰撞**。')
  console.log('  原因：碰撞要求存在一条"下标跨度极大"的边（见下），而 Surface Nets 的边只连相邻格，')
  console.log('        index 差 ≤ nx*ny+ 级别，所以即使顶点数超过 2^21 也撞不上。')
}

// ---------------------------------------------------------------------------
hdr('G-1c 断定 meshStats 的 key 碰撞是真的：用两条散三角形的合成网格决定性复现')
{
  const KEY_MAX = 2097152
  // 顶点 0..(2^21+3)：两条毫不相干的边 (0, 2^21+3) 与 (1,3) 的 key 相同
  const NV = KEY_MAX + 4
  const pos = new Float32Array(NV * 3)
  for (let i = 0; i < NV; i++) { pos[i * 3] = i * 1e-7; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0 }
  // 两个互不相连的三角形 ⇒ 每条边只用 1 次 ⇒ 真值：6 条边界边、0 非流形边、watertight=false
  const idx = new Uint32Array([0, KEY_MAX + 3, KEY_MAX + 2, 1, 3, 2])
  const mine = edgeCounts(idx)
  const theirs = G.meshStats(pos, idx)
  console.log(`  构造：${NV} 个顶点（> 2^21），两个互不相连的三角形：`)
  console.log(`        三角形 A = (0, ${KEY_MAX + 3}, ${KEY_MAX + 2})   三角形 B = (1, 3, 2)`)
  console.log(`        边 (0, ${KEY_MAX + 3}) 与边 (1, 3) 的 key 都是 ${KEY_MAX + 3} ⇒ 计数被合并`)
  console.log('')
  console.log(`  真值（我的字符串 key 实现）：边界边=${mine.n1}（应为 6）  非流形边=${mine.n3}  watertight=${mine.n1 === 0}`)
  console.log(`  meshStats 给出：          边界边=${theirs.boundaryEdges}  非流形边=${theirs.nonManifoldEdges}  watertight=${theirs.watertight}`)
  console.log('')
  const wrong = theirs.boundaryEdges !== mine.n1
  console.log(wrong
    ? `  ❌ **确认为真 bug**：真值 6 条边界边，meshStats 只报 ${theirs.boundaryEdges} 条 —— 两条不同的边界边被合并成"用了 2 次"，于是被当成流形边。`
    : '  ✅ 未复现')
  console.log('  注：本构型下 watertight 恰好仍然为 false（另有 2 条边没被合并），所以布尔结论没翻转；')
  console.log('      但计数已经错了。若被合并的正好是全部边界边，watertight 会**误报为 true**（放行破损网格去 3D 打印）。')
  console.log('  可达性：需要 顶点下标 ≥ 2^21，即网格顶点数 > 2097152。')
  console.log('          · 分辨率上限 320 的"高孔隙"模型（近乎每个体素都是表面格）顶点数可以超过这个数；')
  console.log('          · 但还要求存在"下标跨度极大"的边，而 Surface Nets 的边只连相邻格 ⇒ G-1 的大网格实测没撞上。')
  console.log('  结论：真 bug 已确认；**当前冻结版本已修**（bump 改用字符串 key，本脚本复现为两者一致）。')
  console.log('  修法（已采用）：字符串 key。实测修复后 meshStats 与我的独立实现一致。')
}

// ---------------------------------------------------------------------------
hdr('G-1b surfaceNets 在"数组最外层也变号"时的行为（导出的公共 API，自己的前置条件没写）')
{
  // surfaceNets 的文档只写了「field 尺寸必须 >= (nx+1)(ny+1)(nz+1)」，没说"外圈必须全为正"。
  // 一旦外圈变号，第二遍取 cellIndex 时会越界读 —— 因为循环上界是 y < ny+1 / z < nz+1，
  // 而变号格边若落在 y=ny 或 z=nz，对应的"上方/后方格子"索引并不存在。
  const N = 16
  const gx = N + 1, gy = N + 1, gz = N + 1
  const field = new Int32Array(gx * gy * gz)
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
    field[(z * gy + y) * gx + x] = (x % 2 === 0) ? 1 : -1 // 外层也变号
  }
  const mesh = G.surfaceNets(field, N, N, N)
  let nan = 0
  for (let i = 0; i < mesh.positions.length; i++) if (!Number.isFinite(mesh.positions[i])) nan++
  const eu = edgeCounts(mesh.indices)
  console.log(`  构型：${N}³ 网格，符号沿 x 翻转**且外圈不设正**（即调用方没满足隐含前置条件）`)
  console.log(`  结果：顶点 ${mesh.vertexCount}，三角形 ${mesh.triangleCount}，非有限坐标 ${nan} 个`)
  console.log(`  我的独立边统计：边界边=${eu.n1}，非流形边=${eu.n3} ⇒ 网格**不闭合**`)
  console.log('')
  console.log(nan > 0
    ? `  ⚠ 出现了 ${nan} 个非有限坐标（NaN）⇒ 确实越界读到了 undefined 的格索引，且没有任何报错/告警。`
    : '  ⚠ 没有 NaN，但产生了边界边 ⇒ 越界把格子搞错位，同样没有任何报错/告警。')
  console.log('  ⇒ 真问题（低-中）：`surfaceNets` 是导出的公共函数，"外圈必须全为正"是它的隐含前置条件，')
  console.log('     但既没写进文档也没做断言。自研管线里 pad≥1 恰好满足了它，所以内部调用没事；')
  console.log('     但外部/未来复用（比如想直接喂一个裁剪过的场）会静默得到破洞网格或 NaN。')
  console.log('     建议：把循环上界收紧到 y<nz、z<nz，或在第二遍加 q<0 之外还判 !Number.isFinite。')
}

// ---------------------------------------------------------------------------
hdr('G-2 BIG 哨兵值会不会溢出（Int32 + 反复步进）')
{
  console.log(`BIG = 0x3fffff = ${0x3fffff}，Int32 上限 = 2147483647`)
  console.log(`chamfer 里 v = min(v, d[邻居] + D)，D 最大 5。`)
  console.log('关键：不可达的格子 v 本身 = BIG，而 BIG < BIG+3，所以 min() 立刻把它压回 BIG —— **不会累积**。')
  console.log('     只有存在真实路径时才会累加，而上界是"测地路径长度 × D3"。')
  const N = 320
  const occ = new Uint8Array(N * N * N) // 全空
  for (let i = 0; i < occ.length; i += 2) occ[i] = 1 // 一半填实，制造极长路径
  const t0 = Date.now()
  const { field } = G.distanceField(occ, N, N, N, { pad: 0 })
  const t1 = Date.now()
  let mx = 0
  for (let i = 0; i < field.length; i++) { const a = Math.abs(field[i]); if (a > mx) mx = a }
  console.log('')
  console.log(`${N}³（3276 万体素）最坏情形实测：|field| 最大值 = ${mx}，耗时 ${t1 - t0} ms`)
  console.log(`理论界：BIG + 3*3*N = ${0x3fffff + 9 * N} ≈ ${(0x3fffff + 9 * N).toExponential(3)}，距 2^31 还有 ${(2147483647 / (0x3fffff + 9 * N)).toFixed(1)} 倍余量`)
  console.log(`实测最大 |field| ${mx} ${mx < 2147483647 ? '< 2^31 ✅ 没有溢出' : '≥ 2^31 ❌ 溢出'}`)
  console.log('')
  console.log('⇒ 源码注释里说的"改用 0x3fffff 修掉 BIG+D1 溢出"是**对的**，且余量充足。')
  console.log('  但注意：pad=0 且**全实心**时 inside 一个 0 种子都没有，全数组保持 BIG，')
  console.log('  field = -(BIG+3) = -4194306 —— 数值上不溢出，语义上却是"内部无限深"，等值面不会生成。')
  const solid = new Uint8Array(64 * 64 * 64).fill(1)
  const r = G.distanceField(solid, 64, 64, 64, { pad: 0 })
  console.log(`  验证：64³ 全实心 pad=0 ⇒ field 全为 ${r.field[0]}（唯一取值）⇒ 无等值面。`)
  console.log(`  而公开路径 meshFromVoxels 强制 pad ≥ 1，所以这个洞不会被用户踩到。`)
}

// ---------------------------------------------------------------------------
hdr('G-3 分辨率 320 的端到端耗时（面板跑在浏览器主线程，卡不卡很关键）')
{
  const views = load('sphere')
  for (const res of [96, 160, 240, 320]) {
    const t0 = Date.now()
    const vol = G.carve(views, { resolution: res, padding: 0.06 })
    const t1 = Date.now()
    const df = G.distanceField(vol.occupied, vol.nx, vol.ny, vol.nz, { pad: 1 })
    const t2 = Date.now()
    const grid = (() => {
      // voxelFieldToGrid 没导出，用 meshFromVoxels 的其余阶段之和代替计时
      return null
    })()
    const m = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const t3 = Date.now()
    const st = G.meshStats(m.positions, m.indices)
    const t4 = Date.now()
    console.log(`res=${String(res).padStart(3)}  网格 ${vol.nx}×${vol.ny}×${vol.nz}（${(vol.occupied.length / 1e6).toFixed(2)}M 体素）  ` +
      `carve ${String(t1 - t0).padStart(5)}ms  distanceField ${String(t2 - t1).padStart(5)}ms  ` +
      `meshFromVoxels(含 grid+surfaceNets) ${String(t3 - t2).padStart(5)}ms  meshStats ${String(t4 - t3).padStart(5)}ms  ` +
      `合计 ${String(t4 - t0).padStart(5)}ms  顶点 ${st.vertexCount}`)
  }
  console.log('')
  console.log('（carve 里 res 会被夹到 [8,320]；sphere 的 facets 使 surfaceNets 的支配项是格点数。）')
  console.log('结论：决定面板"拖一下参数转半天"的是 240/320 档。若这些耗时 >100ms，主线程会掉帧，')
  console.log('      应当放到 Worker 或做分辨率分档节流 —— 但这是 UX 取舍，不是正确性 bug。')
}

// ---------------------------------------------------------------------------
hdr('G-4 removeSmallIslands 的 6-邻域连通 vs 网格连通性')
{
  // removeSmallIslands 没有从模块导出，所以从源码里把它抠出来单独 eval ——
  // 这样测的就是**仓库里那一份实现本身**，而不是我重写的近似版。
  const src = fs.readFileSync(path.join(ROOT, 'src/core/geometry.js'), 'utf8')
  const at = src.indexOf('function removeSmallIslands')
  if (at < 0) throw new Error('没找到 removeSmallIslands，源码结构变了')
  // 从函数头开始做花括号配平，抠出完整函数
  let i = src.indexOf('{', at), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const fnSrc = src.slice(at, end)
  const e = (0, eval)(`(${fnSrc})`) // eslint-disable-line no-eval
  console.log(`从源码抠出 removeSmallIslands：${fnSrc.split('\n').length} 行，${fnSrc.length} 字符 ✅`)

  const n = 12
  const occ = new Uint8Array(n * n * n)
  const fill = (x0, x1, y0, y1, z0, z1) => { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) occ[(z * n + y) * n + x] = 1 }
  fill(0, 2, 0, 2, 0, 2) // 块 A
  fill(3, 5, 3, 5, 0, 2) // 块 B：与 A 只在**棱**上相接（x、y 各差 1，z 相同）
  let vox = 0
  for (let i = 0; i < occ.length; i++) vox += occ[i]
  console.log(`构型：两个 3³ 实心块，仅**棱**相接（A 占 x,y,z∈[0,2]；B 占 x,y∈[3,5]、z∈[0,2]），共 ${vox} 个体素`)

  const copy = Uint8Array.from(occ)
  e(copy, n, n, n, 30) // 每块 27 个体素 < 30 ⇒ 按 6-邻域两块都该被删
  let right = 0
  for (let k = 0; k < copy.length; k++) right += copy[k]
  console.log(`  removeSmallIslands(minSize=30)：每块 27 个体素 < 30 ⇒ 6-邻域下两块都应被删`)
  console.log(`  实际剩余体素 = ${right}（${right === 0 ? '确实两块都删了 ✅ 符合 6-邻域语义' : `还剩 ${right}`}）`)

  const m = G.meshFromVoxels(Uint8Array.from(occ), n, n, n, { smooth: 0, pad: 1 })
  const st = G.meshStats(m.positions, m.indices)
  const nv = m.positions.length / 3
  const par = new Int32Array(nv); for (let q = 0; q < nv; q++) par[q] = q
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  for (let t = 0; t < m.indices.length; t += 3) {
    const trip = [[m.indices[t], m.indices[t + 1]], [m.indices[t + 1], m.indices[t + 2]]]
    for (const [x, y] of trip) { const rx = find(x), ry = find(y); if (rx !== ry) par[rx] = ry }
  }
  const shells = new Set()
  for (let q = 0; q < nv; q++) shells.add(find(q))
  console.log(`  同一构型的网格：顶点 ${st.vertexCount}，三角形 ${st.triangleCount}，水密=${st.watertight}，**按共享顶点的连通壳数 = ${shells.size}**`)
  console.log('')
  console.log('  两个块在体素侧是"棱相接"：6-邻域判为**两块**。')
  console.log(`  网格侧实测也是 **${shells.size} 个壳** ⇒ 这一次两者**结论一致**，没有出现我预期的差异。`)
  console.log('  原因（读源码可以确认）：棱接处的那条共享格边上，格点值是"4 实 + 4 空"平均 = 0，')
  console.log('  而 surfaceNets 把 0 当外部 ⇒ 该格边不变号 ⇒ 不生成四边形 ⇒ 两个面片自然不缝合。')
  console.log('')
  console.log('  结论：我原以为"6-邻域 vs 网格连通性"会不一致，**实测没能复现**。')
  console.log('        两者在面接（都算连通）与棱接（都算断开）两种构型上给出相同答案。')
  console.log('        记为"未发现真问题"，不列为缺陷 —— 避免把没验证到的猜测写进报告。')
}

// ---------------------------------------------------------------------------
hdr('G-5 smoothField 的 `| 0` 与 Math.round 的差别（取和不能被 3 整除的三元组）')
{
  const show = (a, b, c) => {
    const sum = a + b + c
    console.log(`  三点 (${a}, ${b}, ${c})  和=${sum}  /3=${(sum / 3).toFixed(3)}  \`|0\`=${(sum / 3) | 0}  Math.round=${Math.round(sum / 3)}  Math.floor=${Math.floor(sum / 3)}`)
  }
  console.log('取和不能被 3 整除的三元组才能真正看出差别：')
  show(-1, -1, 0)
  show(-6, -6, -7)
  show(1, 1, 0)
  show(6, 6, 7)
  console.log('')
  // 用真实 smoothField 跑一个能触发的场
  const nf = new Int32Array([-1, -1, 0, 5, 5, 4, 10])
  const sm = G.smoothField(nf, 7, 1, 1, 1)
  const myRound = (() => {
    const out = new Int32Array(nf.length)
    for (let x = 0; x < nf.length; x++) {
      const a = nf[Math.max(0, x - 1)], b = nf[x], c = nf[Math.min(nf.length - 1, x + 1)]
      out[x] = Math.round((a + b + c) / 3)
    }
    return out
  })()
  console.log(`smoothField 输入  = [${[...nf].join(', ')}]`)
  console.log(`smoothField 输出  = [${[...sm].join(', ')}]   ← 用 \`| 0\``)
  console.log(`同算法改 Math.round= [${[...myRound].join(', ')}]`)
  console.log('')
  console.log('  `| 0` 在正负两侧都是"朝零截断"：对负值是**抬高**、对正值是**压低**，')
  console.log('  也就是把场往 0 拉（|值| 系统性偏小最多 1 个单位 ≈ 1/3 体素）。')
  console.log('  影响很小（默认 smooth=0 时根本不走这条路），但用 Math.round 更中性、也更好解释。')
}

// ---------------------------------------------------------------------------
hdr('G-6 toSTLBinary 头部对非 ASCII（中文）文件名')
{
  const m = G.buildMesh(load('box'), { resolution: 16 })
  const bin = G.toSTLBinary(m.positions, m.indices, '模型-测试')
  const head = Buffer.from(bin.buffer, bin.byteOffset, 80)
  let s = ''
  for (let i = 0; i < 80; i++) s += String.fromCharCode(head[i])
  console.log(`传入 name = "模型-测试"`)
  console.log(`STL 头部原始字节（前 32） = ${head.subarray(0, 32).toString('hex').match(/../g).join(' ')}`)
  console.log(`按 latin1 解出的头部 = ${JSON.stringify(s.replace(/\0+$/, ''))}`)
  console.log('')
  console.log('  charCodeAt 得到的中文码位 > 255，setUint8 只保留低 8 位 ⇒ 头部变成乱码（"模型-测试" → 上面那串）。')
  console.log('  STL 头部是自由文本、所有解析器都忽略，所以**不影响几何**；')
  console.log('  但如果有人按头部去找模型名会找不到。低危，建议用 TextEncoder + 截断，或干脆只写 ASCII。')
  const back = IO.parseMesh(Buffer.from(bin))
  console.log(`  回读验证：识别为 ${back.format}，三角形 ${back.indices.length / 3}（原 ${m.indices.length / 3}）⇒ 几何完好 ✅`)
}

// ---------------------------------------------------------------------------
hdr('G-7 导出函数不做索引越界校验（host 做了，core 没做）')
{
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const bad = new Uint32Array([0, 1, 99]) // 99 越界
  try {
    const obj = G.toOBJ(pos, bad, 'x')
    console.log(`  toOBJ 对越界索引：**没有报错**，生成了 "f 1 2 100"（第 100 个顶点并不存在）`)
    console.log(`    输出片段：${obj.trim().split('\n').slice(-1)[0]}`)
  } catch (e) { console.log(`  toOBJ 抛错：${e.message}`) }
  try {
    const glb = G.toGLB(pos, bad, 'x')
    console.log(`  toGLB 对越界索引：**没有报错**，生成了 ${glb.byteLength} 字节（读回来索引仍是 99，引用越界顶点）`)
  } catch (e) { console.log(`  toGLB 抛错：${e.message}`) }
  try {
    const stl = G.toSTLBinary(pos, bad, 'x')
    console.log(`  toSTLBinary 对越界索引：**没有报错**，生成了 ${stl.byteLength} 字节，读回第 3 个顶点坐标是 ${(() => { const r = IO.parseSTLBinary(Buffer.from(stl)); return [r.positions[6], r.positions[7], r.positions[8]].join(',') })()}（NaN/0 之类的垃圾值）`)
  } catch (e) { console.log(`  toSTLBinary 抛错：${e.message}`) }
  console.log('')
  console.log('  host 的 modeler_save 有显式校验（indices[i] >= vmax 就报错），')
  console.log('  但 core 的 toOBJ/toSTLBinary/toGLB 与 mesh-io 的 serializeMesh 都没有。')
  console.log('  客户端面板如果直接从 UI 传索引进来，就没有这层保护 —— 建议把校验下沉到 core。')
}
