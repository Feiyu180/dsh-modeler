/** 诊断：核对测试夹具本身的预期值，避免"测试错了却去改算法" */
import { silhouette, carve, buildMesh, meshStats } from '../src/core/geometry.js'

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
const ell = (w, h) => (x, y) => ((x + 0.5 - w / 2) / (w / 2)) ** 2 + ((y + 0.5 - h / 2) / (h / 2)) ** 2 <= 1

console.log('--- 1. silhouette 阈值 ---')
{
  const s = silhouette(bitmap(40, 60, box(40, 60), 7))
  console.log('阈值 =', s.threshold, 'bbox =', JSON.stringify(s.bbox), 'coverage =', s.coverage)
  // 统计前景/背景亮度分布
  const img = bitmap(40, 60, box(40, 60), 7)
  const hist = {}
  for (let p = 0; p < img.data.length; p += 4) hist[img.data[p]] = (hist[img.data[p]] || 0) + 1
  console.log('亮度直方图 =', JSON.stringify(hist))
}

console.log('--- 2. 填洞后的 bbox ---')
{
  const hollow = (x, y) => {
    const inside = x > 4 && y > 4 && x < 36 && y < 36
    const hole = x > 16 && y > 16 && x < 24 && y < 24
    return inside && !hole
  }
  const s = silhouette(bitmap(40, 40, hollow))
  console.log('bbox =', JSON.stringify(s.bbox), 'mask(0,0) 与 (39,39) =', s.mask[0], s.mask[39 * 40 + 39])
}

console.log('--- 3. 镜像测试的夹具 ---')
{
  const front = silhouette(bitmap(40, 40, (x) => x < 20))
  const sideA = silhouette(bitmap(40, 40, (x) => x < 20))
  console.log('front bbox =', JSON.stringify(front.bbox), 'sideA bbox =', JSON.stringify(sideA.bbox))
  const a = carve({ front, side: sideA }, { resolution: 40, padding: 0 })
  const b = carve({ front, side: sideA }, { resolution: 40, padding: 0, mirrorSide: true })
  console.log('a.filled =', a.filled, 'b.filled =', b.filled, 'grid =', a.nx, a.ny, a.nz)
  // 镜像后 bbox 会变（u 映射反转），但内容框一样宽，所以结果应该相同 → 夹具本身无法区分镜像
}

console.log('--- 4. "空集"夹具 ---')
{
  const a = silhouette(bitmap(40, 40, (x) => x < 20))
  const b = silhouette(bitmap(40, 40, (x) => x >= 20))
  const v = carve({ front: a, top: b }, { resolution: 40, padding: 0 })
  console.log('前视图左半 + 俯视图右半 → filled =', v.filled, '（>0 说明两个条件能同时满足）')
}

console.log('--- 5. 实心块距离场 ---')
{
  const n = 9
  const occ = new Uint8Array(n * n * n).fill(1)
  const { field, nx } = (await import('../src/core/geometry.js')).distanceField(occ, n, n, n, { pad: 0 })
  const at = (x, y, z) => field[(z * nx + y) * nx + x]
  console.log('中心', at(4, 4, 4), '棱中点', at(0, 4, 4), '角', at(0, 0, 0))
  console.log('说明：全实心块的"内部到空格"距离在每格都是 1（没有任何空格），所以处处都是 -3')
}

console.log('--- 6. 圆柱 / 球 / L 形的实际体积 ---')
{
  const R = 25, H = 70
  const m = buildMesh({
    front: silhouette(bitmap(2 * R, H, box(2 * R, H))),
    side: silhouette(bitmap(2 * R, H, box(2 * R, H))),
    top: silhouette(bitmap(2 * R, 2 * R, ell(2 * R, 2 * R))),
  }, { resolution: 96, padding: 0, smooth: 0 })
  const expected = (Math.PI * R * R * H) / (2 * R) ** 3
  console.log('圆柱 grid =', m.meta.grid, 'V =', m.meta.volume.toFixed(6), '期望 =', expected.toFixed(6),
    'filledVoxels =', m.meta.filledVoxels)
}

console.log('--- 7. 单视图 grid 维度 ---')
{
  const front = silhouette(bitmap(30, 50, (x, y) => (x < 10 ? true : y >= 40)))
  const m = buildMesh({ front }, { resolution: 60, padding: 0, smooth: 0 })
  console.log('grid =', m.meta.grid, '（X 应为 30×scale, Y 应为 50×scale）')
}

console.log('--- 8. removeIslands 夹具 ---')
{
  const front = silhouette(bitmap(60, 20, box(60, 20)))
  const side = silhouette(bitmap(60, 20, box(60, 20)))
  const top = silhouette(bitmap(60, 60, (x, y) => x < 15 || x > 45 || (x >= 25 && x <= 30 && y < 10)))
  const keep = carve({ front, side, top }, { resolution: 60, padding: 0 })
  const cleaned = carve({ front, side, top }, { resolution: 60, padding: 0, removeIslands: 500 })
  console.log('keep =', keep.filled, 'cleaned =', cleaned.filled, 'grid =', keep.nx, keep.ny, keep.nz)
  console.log('说明：front/side 都是满矩形，所以 top 的三条带各自都被 front×side 填满 → 应是 3 个独立块')
}
