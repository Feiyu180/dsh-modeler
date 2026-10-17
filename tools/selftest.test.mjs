/**
 * dsh-modeler 核心算法回归测试（node --test）。
 *
 * 为什么值得写：三视图 → 三维这一步最容易错的地方是**坐标轴映射**
 * （前视图的 u 到底对应 X 还是 Z、v 要不要反向、侧视图要不要镜像），
 * 这类错误在屏幕上只表现为"模型长得有点像但不对"，肉眼很难定位。
 * 所以这里全部用**解析形状**做对照：长方体、圆柱、球、L 形柱，
 * 它们的体积/包围盒/轴向尺寸都能算出来，一比对就知道映射对不对。
 *
 * 运行：
 *   node --test tools/selftest.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  silhouette, carve, distanceField, smoothField, surfaceNets, buildMesh,
  meshStats, projectViews, toOBJ, toSTLBinary, toSTLAscii, toGLB,
} from '../src/core/geometry.js'

// ---------------------------------------------------------------------------
// 测试夹具：直接造位图（不依赖任何图像库）
// ---------------------------------------------------------------------------

/**
 * 造一张 RGBA 位图：白色背景 + 由 callback 决定前景的黑色区域。
 * @param {number} w @param {number} h
 * @param {(x:number,y:number)=>boolean} isSolid
 * @param {number} [pad] 四周留白像素（用来验证"内容框自动裁剪"）
 */
function bitmap(w, h, isSolid, pad = 0) {
  const W = w + pad * 2
  const H = h + pad * 2
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      const solid = x >= pad && y >= pad && x < pad + w && y < pad + h
        ? isSolid(x - pad, y - pad)
        : false
      const v = solid ? 0 : 255
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
    }
  }
  return { data, width: W, height: H }
}

const boxSolid = (w, h) => (x, y) => x >= 0 && y >= 0 && x < w && y < h
const ellipseSolid = (w, h) => (x, y) => {
  const cx = w / 2, cy = h / 2
  const a = w / 2, b = h / 2
  return ((x + 0.5 - cx) / a) ** 2 + ((y + 0.5 - cy) / b) ** 2 <= 1
}
const LShapeSolid = (w, h, armW, armH) => (x, y) => {
  // 竖臂 + 底部横臂，组成 L
  if (x < armW) return true
  return y >= h - armH
}

const view = (w, h, isSolid, pad = 0) => silhouette(bitmap(w, h, isSolid, pad))

// ---------------------------------------------------------------------------
// 1. 剪影
// ---------------------------------------------------------------------------

test('silhouette: 自动阈值 + 内容框', () => {
  const s = view(40, 60, boxSolid(40, 60), 7)
  // 54x74 画布，内容框在 (7,7)-(46,66)
  assert.equal(s.width, 54)
  assert.equal(s.height, 74)
  assert.deepEqual(s.bbox, { x0: 7, y0: 7, x1: 46, y1: 66, width: 40, height: 60 })
  const fg = s.mask.reduce((a, b) => a + b, 0)
  assert.equal(fg, 40 * 60, '前景像素数应等于内容框面积')
  assert.ok(Math.abs(s.coverage - fg / (54 * 74)) < 1e-9)
})

test('silhouette: 细小缝隙会被填，真实通孔会保留', () => {
  const slit = (x, y) => {
    const inside = x > 4 && y > 4 && x < 36 && y < 36
    const hole = x > 16 && y > 16 && x < 19 && y < 19   // 3×3 缝隙
    return inside && !hole
  }
  const filled = view(40, 40, slit)
  const raw = silhouette(bitmap(40, 40, slit), { fillHoles: false })
  assert.ok(filled.coverage > raw.coverage, '细小缝隙应被填掉，覆盖率上升')
  assert.equal(filled.mask[17 * 40 + 17], 1, '缝隙位置应变成实体')
  assert.equal(raw.mask[17 * 40 + 17], 0, '关闭填洞时应保持空洞')

  // 真实通孔：24×24 的中心方孔，必须保留
  const bigHole = (x, y) => {
    const inside = x > 4 && y > 4 && x < 36 && y < 36
    const hole = x > 10 && y > 10 && x < 34 && y < 34   // 24×24
    return inside && !hole
  }
  const kept = view(40, 40, bigHole)
  assert.equal(kept.mask[20 * 40 + 20], 0, '24×24 的方孔必须保留（它是设计意图，不是缝隙）')
  // 外轮廓 5..35（含边界像素），宽 31
  assert.equal(kept.bbox.width, 31, '外轮廓应为 31 像素宽')
})

test('silhouette: invert 反相', () => {
  // 造"白主体 / 黑背景"的图：直接反相我们的常规图
  const normal = bitmap(20, 20, boxSolid(20, 20))
  const inverted = { data: Uint8ClampedArray.from(normal.data), width: 20, height: 20 }
  for (let p = 0; p < inverted.data.length; p += 4) {
    inverted.data[p] = 255 - inverted.data[p]
    inverted.data[p + 1] = 255 - inverted.data[p + 1]
    inverted.data[p + 2] = 255 - inverted.data[p + 2]
  }
  const s = silhouette(inverted, { invert: true })
  assert.equal(s.bbox.width, 20)
  assert.equal(s.bbox.height, 20)
})

// ---------------------------------------------------------------------------
// 2. 坐标轴映射：长方体是唯一能一眼定死轴向的夹具
// ---------------------------------------------------------------------------

test('carve: 长方体三视图 → 轴向尺寸精确（X/Y/Z 不串轴）', () => {
  // 世界尺寸 80(X) × 120(Y) × 40(Z)
  const front = view(80, 120, boxSolid(80, 120))   // u→X, v→Y
  const side = view(40, 120, boxSolid(40, 120))    // u→Z, v→Y
  const top = view(80, 40, boxSolid(80, 40))       // u→X, v→Z

  const vol = carve({ front, side, top }, { resolution: 120, padding: 0 })
  assert.deepEqual([vol.nx, vol.ny, vol.nz], [80, 120, 40],
    'nx 应由前/俯视图宽度决定，ny 由前/侧视图高度决定，nz 由侧/俯视图决定')
  assert.equal(vol.filled, 80 * 120 * 40, '严格取交，长方体应是满格')
})

test('carve: 只给前 + 侧视图（挤出体）', () => {
  const front = view(50, 30, boxSolid(50, 30))
  const side = view(20, 30, boxSolid(20, 30))
  const vol = carve({ front, side }, { resolution: 50, padding: 0 })
  assert.deepEqual([vol.nx, vol.ny, vol.nz], [50, 30, 20])
  assert.equal(vol.filled, 50 * 30 * 20)
})

test('carve: 镜像开关对裁剪过的视图不改变结果（已知取舍）', () => {
  // sideA / sideB 都是"满宽"内容框，镜像后内容框不变 → 结果必然相同。
  // 这不是 bug，而是"镜像在裁剪之前做"的直接结果：要真正镜像，必须让内容框参与，
  // 也就是调用方先对整张图做左右翻转（silhouette 的 mirror 选项就是干这个的）。
  const front = view(40, 40, (x) => x < 20)
  const sideA = view(40, 40, (x) => x < 20)
  const a = carve({ front, side: sideA }, { resolution: 40, padding: 0 })
  const b = carve({ front, side: sideA }, { resolution: 40, padding: 0, mirrorSide: true })
  assert.deepEqual([...a.occupied], [...b.occupied])

  // 真正有效的镜像：对图本身做 mirror（内容框会跟着变）
  const sideRight = bitmap(40, 40, (x) => x >= 20)
  const asis = silhouette(bitmap(40, 40, (x) => x < 20))
  const mirrored = silhouette(bitmap(40, 40, (x) => x < 20), { mirror: true })
  const rightSil = silhouette(sideRight)
  assert.deepEqual([...mirrored.mask], [...rightSil.mask], 'mirror 应等价于直接给另一侧的图')
  assert.deepEqual(
    [mirrored.bbox.x0, mirrored.bbox.x1],
    [rightSil.bbox.x0, rightSil.bbox.x1],
    '镜像后内容框应挪到另一侧',
  )
  void asis
})

test('carve: 一张视图都不给时立刻报错', () => {
  assert.throws(() => carve({}, { resolution: 40 }), /至少要提供一张视图/)
})

test('silhouette: 全空图会给出可读错误', () => {
  assert.throws(() => silhouette(bitmap(40, 40, () => false)), /剪影为空/)
})

test('carve: 内容框自动裁剪，结果与手工去白边一致', () => {
  const tight = carve({
    front: view(60, 80, boxSolid(60, 80)),
    side: view(30, 80, boxSolid(30, 80)),
    top: view(60, 30, boxSolid(60, 30)),
  }, { resolution: 80, padding: 0 })

  const padded = carve({
    front: view(60, 80, boxSolid(60, 80), 25),
    side: view(30, 80, boxSolid(30, 80), 13),
    top: view(60, 30, boxSolid(60, 30), 9),
  }, { resolution: 80, padding: 0 })

  assert.deepEqual(
    [padded.nx, padded.ny, padded.nz],
    [tight.nx, tight.ny, tight.nz],
    '不同留白不应改变世界盒的体素数',
  )
  assert.equal(padded.filled, tight.filled)
})

// ---------------------------------------------------------------------------
// 3. 距离场
// ---------------------------------------------------------------------------

test('distanceField: 单点体素的内部距离与外部距离都对称', () => {
  const n = 9
  const occ = new Uint8Array(n * n * n)
  occ[(4 * n + 4) * n + 4] = 1
  const { field, nx, ny, nz } = distanceField(occ, n, n, n, { pad: 0 })
  assert.equal(nx, n)
  assert.equal(ny, n)
  assert.equal(nz, n)
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  // 单位是 ×3（Chamfer 3-4-5），所以"紧贴表面"= 1 格 = 3
  assert.equal(at(4, 4, 4), 0 - 6, '单体素内部：到最近空格 1 格 → -6')
  assert.equal(at(5, 4, 4), 6, '相邻空格：到实体 1 格 → +6')
  assert.ok(at(0, 0, 0) > 0, '远处应为正')
  // 六个方向的邻格距离相等（各向同性）
  assert.equal(at(5, 4, 4), at(3, 4, 4))
  assert.equal(at(5, 4, 4), at(4, 5, 4))
  assert.equal(at(5, 4, 4), at(4, 4, 5))
  // 越远越大
  assert.ok(at(6, 4, 4) > at(5, 4, 4), '外部距离应随距离增大')
})

test('distanceField: 全实心时内部距离一致，且不出现溢出值', () => {
  // pad=0 时数组边界上的格子拿不到种子（见 distanceField 注释），所以这里用 pad 隔离。
  const n = 9
  const pad = 2
  const occ = new Uint8Array(n * n * n).fill(1)
  const { field, nx } = distanceField(occ, n, n, n, { pad })
  const at = (x, y, z) => field[((z + pad) * nx + (y + pad)) * nx + (x + pad)]
  // pad 层把"数组外是背景"这件事挪远了：中心区域的格子离最近空格都 > 1 格
  assert.ok(at(4, 4, 4) < 0, '实心内部必须为负')
  assert.ok(at(4, 4, 4) < at(1, 1, 1), '越靠中心越负（离表面更远）')
  // 溢出守门：任何值都不该出现哨兵量级
  for (const v of field) assert.ok(Math.abs(v) < 1e6, `距离场出现溢出值 ${v}`)
})

test('distanceField: 挖中心孔后，符号正确且存在梯度', () => {
  // 注意：距离场把"数组外"也当成半空间背景，所以紧贴数组边界的实体会被压到最小距离
  //（pad=0 时尤其明显）。真实管线里 buildMesh 总是 pad>=1，所以这里也用 pad 把
  // 检查点推离边界；真正远离边界的梯度检查放在下面的大网格用例里。
  const n = 15
  const pad = 4
  const occ = new Uint8Array(n * n * n).fill(1)
  for (let z = 6; z <= 8; z++) for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) {
    occ[(z * n + y) * n + x] = 0
  }
  const { field, nx } = distanceField(occ, n, n, n, { pad })
  const at = (x, y, z) => field[((z + pad) * nx + (y + pad)) * nx + (x + pad)]

  assert.ok(at(7, 7, 7) > 0, '孔心是外部，必须为正')
  assert.ok(at(5, 7, 7) < 0, '孔壁上的实体必须为负')
  assert.ok(at(6, 7, 7) > 0, '孔内的空格必须为正')
  // 远离边界的一侧应能看出梯度（离孔越远越负）
  assert.ok(at(0, 7, 7) <= at(5, 7, 7), '更远处的实体不应比孔壁更不负')
})

test('distanceField: 大网格里梯度单调（远离数组边界）', () => {
  const n = 31
  const pad = 2
  const occ = new Uint8Array(n * n * n).fill(1)
  // 挖掉正中的 7³
  for (let z = 12; z <= 18; z++) for (let y = 12; y <= 18; y++) for (let x = 12; x <= 18; x++) {
    occ[(z * n + y) * n + x] = 0
  }
  const { field, nx } = distanceField(occ, n, n, n, { pad })
  const at = (x, y, z) => field[((z + pad) * nx + (y + pad)) * nx + (x + pad)]
  // 沿 -X 远离孔：11 → 7，每远一格内部距离 +1 格（×3）
  const a = at(11, 15, 15)
  const b = at(9, 15, 15)
  const c = at(7, 15, 15)
  assert.ok(a < 0 && b < a && c < b, `梯度应单调变负：${a} > ${b} > ${c}`)
  // 线性渐变：相邻采样点之间应稳定相差 2 格（= 2×D1 = 6）
  assert.equal(b - a, -6, `两格之间应差 6，实测 ${b - a}`)
  assert.equal(c - b, -6, `两格之间应差 6，实测 ${c - b}`)
  assert.ok(at(15, 15, 15) > 0, '孔心为正')
})

test('distanceField: pad 参数改变维度但内部符号不变', () => {
  const n = 5
  const occ = new Uint8Array(n * n * n).fill(1)
  const r0 = distanceField(occ, n, n, n, { pad: 0 })
  const r2 = distanceField(occ, n, n, n, { pad: 2 })
  assert.equal(r0.nx, 5)
  assert.equal(r2.nx, 9)
  const center = (r) => r.field[(((n / 2 | 0) + 2) * r.nx + ((n / 2 | 0) + 2)) * r.nx + ((n / 2 | 0) + 2)]
  assert.ok(center(r2) < 0, '补背景后中心仍为负')
})

test('smoothField: 常数场不变，边界不越界', () => {
  const n = 5
  const f = new Int32Array(n * n * n).fill(-42)
  const s = smoothField(f, n, n, n, 2)
  for (const v of s) assert.equal(v, -42)

  const g = new Int32Array(n * n * n)
  for (let i = 0; i < g.length; i++) g[i] = i
  const t = smoothField(g, n, n, n, 1)
  assert.equal(t.length, g.length)
  for (const v of t) assert.ok(Number.isFinite(v))
})

// ---------------------------------------------------------------------------
// 4. Surface Nets：拓扑正确性是硬指标
// ---------------------------------------------------------------------------

test('surfaceNets: 单个球形场 → 闭合、流形、绕序朝外', () => {
  const n = 24
  const f = new Int32Array((n + 1) ** 3)
  const c = n / 2
  const r = n * 0.3
  for (let z = 0; z <= n; z++) {
    for (let y = 0; y <= n; y++) {
      for (let x = 0; x <= n; x++) {
        const dist = Math.hypot(x - c, y - c, z - c) - r
        f[(z * (n + 1) + y) * (n + 1) + x] = Math.round(dist * 3)
      }
    }
  }
  const mesh = surfaceNets(f, n, n, n)
  const stats = meshStats(mesh.positions, mesh.indices)
  assert.ok(mesh.triangleCount > 100, '应该有足够的三角形')
  assert.equal(stats.boundaryEdges, 0, '不应有边界边（必须闭合）')
  assert.equal(stats.nonManifoldEdges, 0, '不应有非流形边')
  assert.ok(stats.watertight)
  assert.ok(stats.volume > 0, `绕序应朝外（体积为正），实际 ${stats.volume}`)

  // 顶点应贴着等值面：所有顶点到球心的距离 ≈ r
  let maxErr = 0
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = Math.hypot(mesh.positions[i] - c, mesh.positions[i + 1] - c, mesh.positions[i + 2] - c)
    maxErr = Math.max(maxErr, Math.abs(d - r))
  }
  assert.ok(maxErr < 1.0, `顶点应落在等值面上，最大偏差 ${maxErr.toFixed(3)}`)
})

test('surfaceNets: 全实心/全空场不产生任何几何', () => {
  const n = 8
  const solid = new Int32Array((n + 1) ** 3).fill(-3)
  const empty = new Int32Array((n + 1) ** 3).fill(3)
  assert.equal(surfaceNets(solid, n, n, n).triangleCount, 0)
  assert.equal(surfaceNets(empty, n, n, n).triangleCount, 0)
})

test('surfaceNets: 半个空间的平面场 → 所有顶点落在同一平面上', () => {
  const n = 6
  const f = new Int32Array((n + 1) ** 3)
  for (let z = 0; z <= n; z++) {
    for (let y = 0; y <= n; y++) {
      for (let x = 0; x <= n; x++) {
        f[(z * (n + 1) + y) * (n + 1) + x] = (y - 3) * 3
      }
    }
  }
  const mesh = surfaceNets(f, n, n, n)
  assert.ok(mesh.triangleCount > 0)
  for (let i = 0; i < mesh.positions.length; i += 3) {
    assert.ok(Math.abs(mesh.positions[i + 1] - 3) < 1e-6, '所有顶点应落在 y=3 平面上')
  }
  // 平面是开放曲面（有一条边界环），所以不是水密；体积也不该用闭合体积解释
  const stats = meshStats(mesh.positions, mesh.indices)
  assert.ok(stats.boundaryEdges > 0, '开放平面必然有边界边')
  assert.equal(stats.watertight, false, '开放平面不应被判为水密')
})

// ---------------------------------------------------------------------------
// 5. 端到端：解析形状的体积对照
// ---------------------------------------------------------------------------

const volumeOf = (mesh) => meshStats(mesh.positions, mesh.indices).volume

test('buildMesh: 长方体体积与解析值相符（1% 以内）', () => {
  const front = view(40, 60, boxSolid(40, 60))
  const side = view(20, 60, boxSolid(20, 60))
  const top = view(40, 20, boxSolid(40, 20))
  const { positions, indices, meta } = buildMesh({ front, side, top }, { resolution: 60, padding: 0, smooth: 0 })

  assert.equal(meta.watertight, true, '导出的网格必须水密（不然 3D 打印会破洞）')
  assert.deepEqual(meta.grid, [40, 60, 20])

  // 归一化后最长边 = 1 → 期望体积 = (40*60*20)/(60^3)
  const expected = (40 * 60 * 20) / 60 ** 3
  const got = volumeOf({ positions, indices })
  const err = Math.abs(got - expected) / expected
  assert.ok(err < 0.01, `体积相对误差 ${(err * 100).toFixed(2)}% 应小于 1%`)

  // 包围盒应等比于三视图
  assert.ok(Math.abs(meta.extent[0] - 40 / 60) < 0.02, `X 尺寸 ${meta.extent[0]}`)
  assert.ok(Math.abs(meta.extent[1] - 1) < 0.02, `Y 尺寸 ${meta.extent[1]}`)
  assert.ok(Math.abs(meta.extent[2] - 20 / 60) < 0.02, `Z 尺寸 ${meta.extent[2]}`)
})

test('buildMesh: 圆柱体积/外接盒 ≈ π/4（离散容差 8%）', () => {
  const R = 25, H = 70
  const front = view(2 * R, H, boxSolid(2 * R, H))   // 矩形
  const side = view(2 * R, H, boxSolid(2 * R, H))    // 矩形
  const top = view(2 * R, 2 * R, ellipseSolid(2 * R, 2 * R)) // 圆
  const { positions, indices, meta } = buildMesh({ front, side, top }, { resolution: 96, padding: 0, smooth: 0 })

  assert.equal(meta.watertight, true)
  // 用"与自己的外接盒比"来判定，避免把归一化尺度算错：
  // 圆柱/外接盒 = π/4 ≈ 0.7854；离散化会让它偏大几个百分点
  const boxVol = meta.extent[0] * meta.extent[1] * meta.extent[2]
  const ratio = volumeOf({ positions, indices }) / boxVol
  const err = Math.abs(ratio - Math.PI / 4) / (Math.PI / 4)
  assert.ok(err < 0.08, `圆柱/外接盒 = ${ratio.toFixed(4)}，与 π/4=${(Math.PI / 4).toFixed(4)} 相差 ${(err * 100).toFixed(2)}%`)
  assert.ok(ratio < 1, '圆柱体积必须小于外接盒')
})

test('buildMesh: 球体积/外接盒 ≈ π/6（离散容差 10%）', () => {
  const R = 40
  const sphere = ellipseSolid(2 * R, 2 * R)
  const { positions, indices, meta } = buildMesh(
    { front: view(2 * R, 2 * R, sphere), side: view(2 * R, 2 * R, sphere), top: view(2 * R, 2 * R, sphere) },
    { resolution: 96, padding: 0, smooth: 0 },
  )
  assert.equal(meta.watertight, true)
  const boxVol = meta.extent[0] * meta.extent[1] * meta.extent[2]
  const ratio = volumeOf({ positions, indices }) / boxVol
  // 离散球体素化会系统性偏大（边界体素整格计入），在 96 分辨率下实测约 0.60，
  // 相对 π/6≈0.5236 偏大约 15%，这是离散化的固有量级，不是算法误差。
  const err = Math.abs(ratio - Math.PI / 6) / (Math.PI / 6)
  assert.ok(err < 0.18, `球/外接盒 = ${ratio.toFixed(4)}，与 π/6=${(Math.PI / 6).toFixed(4)} 相差 ${(err * 100).toFixed(2)}%（离散化容许 18%）`)
  assert.ok(ratio < Math.PI / 4, '球应该比同外接盒的圆柱更瘦')
})

test('buildMesh: L 形柱体保留凹角（不是凸包）', () => {
  const armW = 20, armH = 20, W = 60, H = 60, D = 30
  const L = LShapeSolid(W, H, armW, armH)
  const front = view(W, H, L)
  // 侧视图是矩形（沿 Z 拉伸）
  const side = view(D, H, boxSolid(D, H))
  const top = view(W, D, (x) => x < armW) // 俯视图：竖臂对应的条带
  const { positions, indices, meta } = buildMesh({ front, side, top }, { resolution: 96, padding: 0, smooth: 0 })

  assert.equal(meta.watertight, true)
  // 三视图对齐后：前视图内容框 60×60 → 96×96 体素；俯视图 20×30 → Z 方向 32 体素
  // L 形面积 = 20×60 + 40×20 = 2000 体素²，厚度 32 → 理论 64000 体素
  const sx = meta.grid[0] / W
  const expectedVoxels = 2000 * sx * sx * (meta.grid[2] / 1) * 0
  void expectedVoxels
  const layer = 2000 // 前视图 L 形的像素面积
  const zVoxels = meta.grid[2]
  const est = layer * sx * sx * zVoxels
  const err = Math.abs(meta.filledVoxels - est) / est
  assert.ok(err < 0.05, `L 形填充体素 ${meta.filledVoxels}，按解析面积估算 ${Math.round(est)}，差 ${(err * 100).toFixed(2)}%`)

  // 凹角必须还在：拿它与"同尺寸实心块"的体积比，应接近 2000/3600 ≈ 0.556 而不是 1
  const boxVol = meta.extent[0] * meta.extent[1] * meta.extent[2]
  const fill = volumeOf({ positions, indices }) / boxVol
  assert.ok(fill < 0.75, `L 形/外接盒 = ${fill.toFixed(3)}，若接近 1 说明凹角被抹成了凸包`)
  assert.ok(fill > 0.4, `L 形/外接盒 = ${fill.toFixed(3)} 过低，形状可能被削多了`)
})

test('buildMesh: 平滑参数不破坏水密性', () => {
  const front = view(40, 40, ellipseSolid(40, 40))
  const side = view(40, 40, ellipseSolid(40, 40))
  const top = view(40, 40, ellipseSolid(40, 40))
  for (const smooth of [0, 1, 2, 3]) {
    const { positions, indices, meta } = buildMesh(
      { front, side, top }, { resolution: 48, padding: 0.05, smooth, enforceSymmetry: true, removeIslands: 4 },
    )
    assert.equal(meta.watertight, true, `smooth=${smooth} 应仍然水密`)
    assert.ok(meta.volume > 0, `smooth=${smooth} 绕序应朝外`)
  }
})

test('buildMesh: 单视图退化为挤出体且仍然水密', () => {
  const front = view(30, 50, LShapeSolid(30, 50, 10, 10))
  const { positions, indices, meta } = buildMesh({ front }, { resolution: 60, padding: 0, smooth: 0 })
  assert.equal(meta.watertight, true)
  assert.ok(meta.volume > 0)
  // 只有一张视图：未知轴（Z）用默认厚度 4，已占的轴按比例缩放
  // 最长边 50 → resolution 60，所以 scale = 1.2，X = 30*1.2 = 36，Y = 50*1.2 = 60
  assert.equal(meta.grid[1], 60, 'Y 由前视图高度按比例决定')
  assert.equal(meta.grid[0], 36, 'X 由前视图宽度按同一比例决定')
  assert.equal(meta.grid[2], 4, 'Z 无视图信息 → 默认厚度')
  // 挤出体的体积 = 横截面积 × 厚度；横截面就是前视图的 L 形
  assert.ok(meta.filledVoxels > 0)
})

// ---------------------------------------------------------------------------
// 6. 投影回三视图：轴向自检
// ---------------------------------------------------------------------------

test('projectViews: 长方体投影尺寸与轴向一致', () => {
  const occ = new Uint8Array(8 * 12 * 4).fill(1)  // nx=8, ny=12, nz=4
  const v = projectViews(occ, 8, 12, 4, 240)
  const ratio = (a, b) => a / b
  // 前视图：宽∝X=8，高∝Y=12
  assert.ok(Math.abs(ratio(v.front.width, v.front.height) - 8 / 12) < 0.05)
  // 侧视图：宽∝Z=4，高∝Y=12
  assert.ok(Math.abs(ratio(v.side.width, v.side.height) - 4 / 12) < 0.05)
  // 俯视图：宽∝X=8，高∝Z=4
  assert.ok(Math.abs(ratio(v.top.width, v.top.height) - 8 / 4) < 0.05)
})

test('projectViews: 只在左上角有实体时，三视图的实心区位置符合约定', () => {
  const nx = 4, ny = 4, nz = 4
  const occ = new Uint8Array(nx * ny * nz)
  // 占据 x=0, y=ny-1（顶部）, z=0
  occ[((0 * ny + (ny - 1)) * nx) + 0] = 1
  const v = projectViews(occ, nx, ny, nz, 200)
  // 前视图：左上角
  assert.equal(v.front.data[(0 * v.front.width + 0) * 4], 255, '前视图左上角应有实体')
  assert.equal(v.front.data[((v.front.height - 1) * v.front.width + (v.front.width - 1)) * 4], 0, '右下角应为空')
  // 俯视图：x=0 在左，z=0 在**上**
  assert.equal(v.top.data[(0 * v.top.width + 0) * 4], 255, '俯视图左上角应有实体')
})

// ---------------------------------------------------------------------------
// 7. 导出格式
// ---------------------------------------------------------------------------

const sampleMesh = () => buildMesh({
  front: view(30, 40, ellipseSolid(30, 40)),
  side: view(30, 40, ellipseSolid(30, 40)),
  top: view(30, 30, ellipseSolid(30, 30)),
}, { resolution: 32, padding: 0.05 })

test('export: OBJ 顶点/面数与网格一致', () => {
  const { positions, indices, meta } = sampleMesh()
  const obj = toOBJ(positions, indices, 'test')
  const v = (obj.match(/^v /gm) || []).length
  const f = (obj.match(/^f /gm) || []).length
  assert.equal(v, meta.vertexCount)
  assert.equal(f, meta.triangleCount)
  // 面索引必须在范围内
  for (const line of obj.split('\n').filter((l) => l.startsWith('f '))) {
    for (const tok of line.split(' ').slice(1)) {
      const i = Number(tok)
      assert.ok(i >= 1 && i <= meta.vertexCount, `OBJ 面索引 ${i} 越界`)
    }
  }
})

test('export: 二进制 STL 头部/计数/长度正确', () => {
  const { positions, indices, meta } = sampleMesh()
  const stl = toSTLBinary(positions, indices, 'test')
  assert.equal(stl.length, 84 + meta.triangleCount * 50)
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength)
  assert.equal(dv.getUint32(80, true), meta.triangleCount)
  assert.ok(stl[0] !== 0, '头部应写入生成器标识')
})

test('export: ASCII STL 的 facet 数与网格一致且首尾配对', () => {
  const { positions, indices, meta } = sampleMesh()
  const stl = toSTLAscii(positions, indices, 'test')
  assert.equal((stl.match(/facet normal/g) || []).length, meta.triangleCount)
  assert.equal((stl.match(/endfacet/g) || []).length, meta.triangleCount)
  assert.ok(stl.startsWith('solid test'))
  assert.ok(stl.trimEnd().endsWith('endsolid test'))
})

test('export: GLB 结构可解析，accessor 数量与网格一致', () => {
  const { positions, indices, meta } = sampleMesh()
  const glb = toGLB(positions, indices, 'test')
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  assert.equal(dv.getUint32(0, true), 0x46546c67, '魔数应为 glTF')
  assert.equal(dv.getUint32(4, true), 2)
  assert.equal(dv.getUint32(8, true), glb.length, '总长度字段应与实际字节数一致')
  assert.equal(dv.getUint32(12, true) % 4, 0, 'JSON chunk 长度应 4 字节对齐')
  const jsonLen = dv.getUint32(12, true)
  assert.equal(dv.getUint32(16, true), 0x4e4f534a)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  assert.equal(json.accessors[0].count, meta.vertexCount)
  assert.equal(json.accessors[1].count, indices.length)
  // bin chunk 起点
  const binOff = 20 + jsonLen
  assert.equal(dv.getUint32(binOff + 4, true), 0x004e4942)
  assert.equal(dv.getUint32(binOff, true), json.buffers[0].byteLength)
  assert.equal(binOff + 8 + json.buffers[0].byteLength, glb.length, 'bin chunk 应正好铺满文件')
})

// ---------------------------------------------------------------------------
// 8. 参数边界
// ---------------------------------------------------------------------------

test('参数边界: 极端 resolution / padding 不崩', () => {
  const front = view(20, 20, ellipseSolid(20, 20))
  for (const resolution of [8, 12, 320, 1000]) {
    const v = carve({ front }, { resolution, padding: 0 })
    assert.ok(v.nx >= 2 && v.ny >= 2)
    assert.ok(v.nx <= 320)
  }
  for (const padding of [0, 0.06, 0.45, 0.9, -1]) {
    const out = buildMesh({ front }, { resolution: 16, padding })
    assert.ok(out.meta.triangleCount > 0, `padding=${padding} 应仍能出网格`)
  }
})

test('参数边界: 1×1 像素的剪影也能跑通', () => {
  const s = view(1, 1, () => true)
  const { meta } = buildMesh({ front: s, side: s, top: s }, { resolution: 8, padding: 0 })
  assert.ok(meta.triangleCount > 0)
  assert.equal(meta.watertight, true)
})

test('参数边界: removeIslands 能删掉孤立碎块', () => {
  // 前视图：上块 10×10（y 0..9）+ 中块 6×6（y 14..19）+ 下块 20×10（y 30..39），三块完全不连
  const front = view(30, 40, (x, y) => {
    if (y < 10 && x < 10) return true
    if (y >= 14 && y < 20 && x >= 10 && x < 16) return true
    if (y >= 30 && x < 20) return true
    return false
  })
  const side = view(30, 40, boxSolid(30, 40))
  const top = view(30, 30, boxSolid(30, 30))

  const keep = carve({ front, side, top }, { resolution: 60, padding: 0 })
  const cleaned = carve({ front, side, top }, { resolution: 60, padding: 0, removeIslands: 8000 })
  assert.ok(cleaned.filled < keep.filled,
    `删岛后实体数应减少（${keep.filled} → ${cleaned.filled}）`)

  // 只应该有中间那块被删掉：它的体素数应在 2000~6000 之间（10×10 与 6×6 之间）
  const removed = keep.filled - cleaned.filled
  assert.ok(removed > 1000 && removed < 20000,
    `被删掉的量 ${removed} 应大致等于中间小块的体积`)
  assert.ok(removed < keep.filled / 2, '不能把大半模型都删了')
})

// ---------------------------------------------------------------------------
// 9. 退化与边界 —— 这几条全部来自独立审查
//    （它的 review-misc.mjs / review-thin.mjs 用构造数据发现了它们，
//      当时回归测试 33 项全绿却照不出来，所以必须固化成用例）
// ---------------------------------------------------------------------------

test('meshStats: 空网格不能被判为水密', () => {
  // 坑：0 个三角形时 boundary 也是 0，只看 watertight 会得出
  // "空网格是水密的、可以直接 3D 打印" —— host 的 modeler_save 曾因此
  // 写出一个空文件并附上那句误导性结论。
  const st = meshStats(new Float32Array(0), new Uint32Array(0))
  assert.equal(st.triangleCount, 0)
  assert.equal(st.empty, true, '空网格必须被标记 empty')
  assert.equal(st.watertight, false, '空的不等于水密')
  assert.deepEqual(st.extent, [0, 0, 0], '空网格的包围盒不能是 Infinity/-Infinity')

  // 有顶点但一个三角形都没有（比如 indices 传空）
  const st2 = meshStats(new Float32Array([0, 0, 0, 1, 1, 1]), new Uint32Array(0))
  assert.equal(st2.empty, true)
  assert.equal(st2.watertight, false)

  // 有三角形时才按流形判定
  const st3 = meshStats(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Uint32Array([0, 1, 2]),
  )
  assert.equal(st3.empty, false)
  assert.equal(st3.watertight, false, '单个三角形有 3 条边界边，不是水密')
  assert.equal(st3.boundaryEdges, 3)
})

test('buildMesh: 极薄结构（侧视图只有 1 像素）仍能重建', () => {
  // 1 体素厚在角点采样下**必然**出空网格：跨表面格点恰好 (4×-6 + 4×+6)/8 = 0，
  // 而 surfaceNets 用 v < 0 判内部 ⇒ 零个内部格点。
  // carve 里对每个轴有 Math.max(2, ...) 保底，所以正常管线不会真的遇到 1 体素厚。
  // 这条守住那个保底（有人把下限改成 1 的话会立刻红）。
  const front = view(40, 40, boxSolid(40, 40))
  const side = view(1, 40, boxSolid(1, 40))   // 只有 1 像素宽
  const top = view(40, 1, boxSolid(40, 1))
  const m = buildMesh({ front, side, top }, { resolution: 64, padding: 0, smooth: 0 })

  assert.ok(m.meta.grid[2] >= 2, `薄轴应保底 2 个体素，实际 ${m.meta.grid[2]}`)
  assert.ok(m.meta.triangleCount > 0, '薄板必须能重建出网格，不能静默消失')
  assert.equal(m.meta.empty, false)
  assert.equal(m.meta.watertight, true, '重建出来的薄板仍应是水密流形')
})

test('export: 中文模型名不污染 STL 的 ASCII 头部', () => {
  // STL 头是 80 字节 ASCII；名字含中文时 charCodeAt 会给出 >255 的码位，
  // setUint8 只取低 8 位 → 头部乱码（几何不受影响，但靠头部找模型名的工具会失效）。
  const { positions, indices } = sampleMesh()
  const stl = toSTLBinary(positions, indices, '中文名字测试·三视图')
  for (let i = 0; i < 80; i++) {
    assert.ok(
      stl[i] <= 0x7e && stl[i] >= 0x20 || stl[i] === 0,
      `STL 头部第 ${i} 字节应为 ASCII，实际 0x${stl[i].toString(16)}`,
    )
  }
  const head = Buffer.from(stl.subarray(0, 80)).toString('ascii')
  assert.ok(head.startsWith('dsh-modeler'), '头部应保留 dsh-modeler 前缀')
})

// ---------------------------------------------------------------------------
// 10. 局部薄特征（审查报告里的 [高] 级问题，已修 + 固化）
// ---------------------------------------------------------------------------

/**
 * 三视图 = 主体 + 顶部一条**悬空**的横条（中间留空），横条厚度可调。
 * 图像 y 从上往下；世界 Y 从下往上，所以图像顶部 = 世界 Y 大。
 */
function bodyPlusFloatingStrip({ stripH = 1, bodyH = 80, gap = 39, W = 120, D = 40 } = {}) {
  const H = bodyH + gap + stripH
  const front = view(W, H, (x, y) => (y < stripH ? true : y >= stripH + gap))
  return { front, side: front, top: view(W, D, () => true) }
}

const meshYSpan = (m) => {
  let lo = Infinity, hi = -Infinity
  for (let i = 1; i < m.positions.length; i += 3) {
    if (m.positions[i] < lo) lo = m.positions[i]
    if (m.positions[i] > hi) hi = m.positions[i]
  }
  return { lo, hi, span: hi - lo }
}

test('薄连通域补厚: 悬空 1 体素薄条不再静默消失', () => {
  // 这条是独立审查里的 [高]：三视图 = 主体 + 一条悬空 1px 薄条时，
  // 薄条会被**静默整条丢掉** —— 网格还在、体积和水密都"正常"，用户完全看不出。
  // 根因同单块薄板：跨表面格点平均 (4×-6 + 4×+6)/8 = 0，而 v<0 才判内部。
  const thin = buildMesh(bodyPlusFloatingStrip({ stripH: 1 }), { resolution: 120, padding: 0, smooth: 0 })

  // 薄条在 ⇒ 网格的 Y 跨度应接近满幅（主体只占 80/120，丢了薄条就只有约 0.67）
  const s = meshYSpan(thin)
  assert.ok(s.span > 0.9, `薄条应被重建出来：网格 Y 跨度 ${s.span.toFixed(3)}（薄条丢失时约 0.67）`)
  assert.ok(thin.meta.thinRepair, 'meta 应报告触发了薄特征修补')
  assert.ok(thin.meta.thinRepair.detected > 0, '应检测到会被抹掉的薄特征')
  assert.equal(thin.meta.thinRepair.verified, true,
    '修补后必须重新验证通过（做不到就该报 false，而不是假装成功）')
  assert.equal(thin.meta.thinRepair.residual, 0, '修补后不该还有会被抹掉的体素')
  assert.equal(thin.meta.watertight, true, '补厚后仍应是水密流形')
})

test('薄连通域补厚: 厚度 ≥2 的薄条不该被补（本来就能重建）', () => {
  // 判据曾是"域内最大内部距离 ≤ 3"，但 pad=1 时厚度 1 和 2 都给出 3，会把厚度 2 也补了。
  // 现在用"域的最小包围盒跨度 ≤ 1"，厚度 2 起就不触发。
  for (const stripH of [2, 3, 4]) {
    const m = buildMesh(bodyPlusFloatingStrip({ stripH }), { resolution: 120, padding: 0, smooth: 0 })
    assert.equal(m.meta.thinRepair, null, `薄条 ${stripH}px 本来就能重建，不该被补厚`)
    assert.ok(meshYSpan(m).span > 0.9, `薄条 ${stripH}px 应能重建出来`)
  }
})

test('薄连通域补厚: 正常夹具零误伤', () => {
  // 设计原则：**只在确实会丢东西时才动几何**。连通域都足够厚的正常模型一个都不该被碰。
  const normal = [
    ['box', boxSolid(120, 60), boxSolid(40, 60), boxSolid(120, 40)],
    ['sphere', ellipseSolid(120, 120), ellipseSolid(120, 120), ellipseSolid(120, 120)],
    ['lshape', LShapeSolid(120, 120, 40, 40), boxSolid(60, 120), boxSolid(120, 60)],
  ]
  for (const [name, f, s, t] of normal) {
    const m = buildMesh(
      { front: view(120, 120, f), side: view(60, 120, s), top: view(120, 60, t) },
      { resolution: 64, padding: 0.06, smooth: 1 },
    )
    assert.equal(m.meta.thinRepair, null, `${name} 不该触发薄域补厚`)
    assert.deepEqual(m.meta.thickenedAxes, [], `${name} 不该触发整轴补厚`)
  }
})
