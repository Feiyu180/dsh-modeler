/** 逐个复现 selftest 里剩余失败的夹具数值，避免盲改断言 */
import { silhouette, carve, distanceField } from '../src/core/geometry.js'

function bitmap(w, h, isSolid, pad = 0) {
  const W = w + pad * 2, H = h + pad * 2
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      const solid = x >= pad && y >= pad && x < pad + w && y < pad + h ? isSolid(x - pad, y - pad) : false
      const v = solid ? 0 : 255
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
    }
  }
  return { data, width: W, height: H }
}
const box = (w, h) => () => true

console.log('--- 1. silhouette 前景像素数与覆盖率 ---')
{
  const s = silhouette(bitmap(40, 60, box(40, 60), 7))
  let fg = 0
  for (const v of s.mask) fg += v
  console.log('尺寸', s.width + 'x' + s.height, 'bbox', JSON.stringify(s.bbox))
  console.log('前景像素', fg, '期望 2400；覆盖率', s.coverage, '计算值', (fg / (s.width * s.height)).toFixed(6))
  console.log('阈值', s.threshold)
}

console.log('--- 2. 填洞对外轮廓的影响（3x3 缝隙 / 24x24 孔）---')
{
  const slit = (x, y) => {
    const inside = x > 4 && y > 4 && x < 36 && y < 36
    const hole = x > 16 && y > 16 && x < 19 && y < 19
    return inside && !hole
  }
  const s1 = silhouette(bitmap(40, 40, slit))
  const s1raw = silhouette(bitmap(40, 40, slit), { fillHoles: false })
  console.log('3x3 缝隙：填洞后 bbox', JSON.stringify(s1.bbox), 'raw bbox', JSON.stringify(s1raw.bbox))
  console.log('  缝隙位置 (17,17) =', s1.mask[17 * 40 + 17], 'raw =', s1raw.mask[17 * 40 + 17])

  const big = (x, y) => {
    const inside = x > 4 && y > 4 && x < 36 && y < 36
    const hole = x > 10 && y > 10 && x < 34 && y < 34
    return inside && !hole
  }
  const s2 = silhouette(bitmap(40, 40, big))
  console.log('24x24 孔：bbox', JSON.stringify(s2.bbox), '中心 (20,20) =', s2.mask[20 * 40 + 20])
  // 外轮廓的实心范围在哪
  let x0 = 40, x1 = -1
  for (let x = 0; x < 40; x++) if (s2.mask[20 * 40 + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x }
  console.log('  中心行 y=20 的实心范围:', x0, '..', x1, '(应为 5..34，宽 30)')
  let fx0 = 40, fx1 = -1
  for (let x = 0; x < 40; x++) {
    let any = false
    for (let y = 0; y < 40; y++) if (s2.mask[y * 40 + x]) { any = true; break }
    if (any) { if (x < fx0) fx0 = x; if (x > fx1) fx1 = x }
  }
  console.log('  整体行方向实心范围:', fx0, '..', fx1, '→ 宽', fx1 - fx0 + 1)
}

console.log('--- 3. carve 空集 ---')
{
  const makeView = (bx0, bx1) => ({
    mask: new Uint8Array(40 * 40).fill(1),
    width: 40, height: 40, threshold: 0.5, alphaUsed: false, coverage: 1,
    bbox: { x0: bx0, y0: 0, x1: bx1, y1: 39, width: bx1 - bx0 + 1, height: 40 },
  })
  try {
    const v = carve({ front: makeView(0, 9), top: makeView(30, 39) }, { resolution: 40, padding: 0 })
    console.log('没有抛错！nx,ny,nz =', v.nx, v.ny, v.nz, 'filled =', v.filled)
  } catch (e) {
    console.log('正确抛错:', e.message.slice(0, 60))
  }
}

console.log('--- 4. 距离场：挖角后的梯度 ---')
{
  const n = 9
  const occ = new Uint8Array(n * n * n).fill(1)
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) occ[(z * n + y) * n + x] = 0
  const { field, nx } = distanceField(occ, n, n, n, { pad: 0 })
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  console.log('挖掉 (0..3)³ 后：')
  console.log('  (4,4,4) =', at(4, 4, 4), ' （离挖空区最近）')
  console.log('  (8,8,8) =', at(8, 8, 8), ' （离挖空区最远）')
  console.log('  (0,0,0) =', at(0, 0, 0), ' （被挖掉，应为正）')
  console.log('说明：更负 = 离表面更远。所以 (8,8,8) 应该比 (4,4,4) 更负，而不是反过来。')
}
