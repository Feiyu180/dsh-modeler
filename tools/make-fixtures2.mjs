/**
 * task-3 · 优先级 2：生成**自洽**的夹具，另开 samples2/
 * ===========================================================================
 * 背景（来自一份外部审查报告的 A-5）：
 *   `samples/lshape-*` 与 `samples/torus-ish-*` 违反了"每张视图必须是完整正交投影"，
 *   于是 `carve` 会把某个视图**非等比拉伸**（实测 lshape 的 top 被拉宽 3×、
 *   torus-ish 的 side 被拉高 4×），重建出来的形状不是作者想要的那个。
 *
 * 自洽条件（三视图互相印证同一个世界盒）：
 *     front.width == top.width      （都是 X 方向的长度）
 *     front.height == side.height   （都是 Y 方向的长度）
 *     side.width  == top.height     （都是 Z 方向的长度）
 *
 * 本脚本生成：
 *   samples2/lshape-front.png    120×120  L 形（竖臂宽 40、底横条高 40）
 *   samples2/lshape-side.png      60×120  满矩形（沿 Z 挤出 ⇒ 侧视是完整矩形）
 *   samples2/lshape-top.png      120×60   满矩形（L 的 X 跨度是满的）
 *   samples2/torus-ish-front.png 120×120  方环（方管横截面，壁厚 40）
 *   samples2/torus-ish-side.png  120×120  满矩形
 *   samples2/torus-ish-top.png   120×120  满矩形
 *   samples2/expected.json       期望尺寸/内容框/面积 + 自洽性断言结论
 *
 * 自带断言（跑不过就抛错，不生成 expected.json）：
 *   1. 每张图的实心内容框必须**铺满整张图**（否则 carve 会按内容框裁剪，尺寸对不上）
 *   2. 上面三条自洽等式必须成立
 *   3. carve 的 viewConsistency.stretched 必须为 false
 *   4. 重建结果的**亏格**必须对：L 形柱 = 0（V−E+F = 2），方管 = 1（V−E+F = 0）
 *   5. 重建体积与"剪影面积 × 挤出长度"的偏差 < 5%
 *   6. 重投影回三视图，与输入剪影的 IoU > 0.97
 *
 * 运行：
 *   DSH_ROOT=D:/dsh-modeler/tools/_rev3-b3d83f23 <node> D:/dsh-modeler/tools/make-fixtures2.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const OUT = path.join(ROOT, 'samples2')
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const { encodeGrayPNG, decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const log = (...a) => console.log(...a)
const hdr = (s) => { log(''); log('='.repeat(74)); log(s); log('='.repeat(74)) }

// ---------------------------------------------------------------------------
// 形状定义（灰度：0 = 实体，255 = 背景；与 samples/ 里旧夹具的极性一致）
// ---------------------------------------------------------------------------
const FULL = () => true
const SHAPES = {
  lshape: {
    // L 形柱：竖臂 x < 40 ∪ 底横条 y >= 80，沿 **Z** 挤出。
    // 挤出方向为 Z ⇒ 侧视（Z×Y）与俯视（X×Z）都是**完整矩形**。
    front: { size: [120, 120], fn: (x, y) => (x < 40) || (y >= 80) },
    side: { size: [60, 120], fn: FULL },
    top: { size: [120, 60], fn: FULL },
    kind: 'prism',
    desc: 'L 形柱（竖臂 40×120 + 底横条 120×40，沿 Z 挤出 60）',
  },
  'torus-ish': {
    // 方管：方环横截面（壁厚 40、方孔 40×40）沿 **Z** 挤出。
    // 孔是穿过 Z 的 ⇒ 只有前视图能看到那个方孔；侧视/俯视都是满矩形。
    front: { size: [120, 120], fn: (x, y) => !(x >= 40 && x < 80 && y >= 40 && y < 80) },
    side: { size: [120, 120], fn: FULL },
    top: { size: [120, 120], fn: FULL },
    kind: 'tube',
    desc: '方管（方环横截面 120×120、壁厚 40、方孔 40×40，沿 Z 挤出 120）',
  },
}

/** 生成三视图灰度图，并断言"内容框铺满整张图" */
function buildViews(spec) {
  const out = {}
  for (const key of ['front', 'side', 'top']) {
    const [w, h] = spec[key].size
    const fn = spec[key].fn
    const gray = new Uint8Array(w * h).fill(255)
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        if (!fn(u, v)) continue
        gray[v * w + u] = 0
        area++
        if (u < x0) x0 = u
        if (u > x1) x1 = u
        if (v < y0) y0 = v
        if (v > y1) y1 = v
      }
    }
    assert.ok(area > 0, `${key} 视图为空`)
    assert.ok(x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1,
      `${key} 的内容框没铺满整张图（x ${x0}..${x1} / y ${y0}..${y1}，图 ${w}×${h}）—— carve 会按内容框裁剪，尺寸会对不上`)
    out[key] = { gray, width: w, height: h, bbox: [x0, y0, x1, y1], area }
  }
  return out
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const silhouetteOf = (v) => G.silhouette({ data: rgbaOf(v.gray), width: v.width, height: v.height })
function rgbaOf(gray) {
  const out = new Uint8ClampedArray(gray.length * 4)
  for (let i = 0; i < gray.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = gray[i]; out[i * 4 + 3] = 255 }
  return out
}
/** 亏格：闭合可定向曲面 V−E+F = 2−2g ⇒ g = (2 − (V−E+F)) / 2 */
function eulerGenus(mesh) {
  const V = mesh.positions.length / 3
  const F = mesh.indices.length / 3
  const edges = new Set()
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2]
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`)
    edges.add(b < c ? `${b}|${c}` : `${c}|${b}`)
    edges.add(c < a ? `${c}|${a}` : `${a}|${c}`)
  }
  const E = edges.size
  const chi = V - E + F
  return { V, E, F, chi, genus: (2 - chi) / 2 }
}
function volumeOf(mesh) {
  let v = 0
  const p = mesh.positions, i = mesh.indices
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  }
  return v
}
/** 输入剪影 vs 重投影（都先裁到内容框再比） */
function iouWithReprojection(views, vol, key, N = 128) {
  const proj = G.projectViews(vol.occupied, vol.nx, vol.ny, vol.nz, 240)[key]
  const om = new Uint8Array(proj.width * proj.height)
  for (let i = 0; i < om.length; i++) om[i] = proj.data[i * 4] ? 1 : 0
  const crop = (mask, w, h) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1
    const out = new Uint8Array(cw * ch)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = mask[(y0 + y) * w + x0 + x] ? 1 : 0
    return { mask: out, width: cw, height: ch }
  }
  const toGrid = (m) => {
    const g = new Uint8Array(N * N)
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const px = Math.min(m.width - 1, Math.floor(c * m.width / N))
      const py = Math.min(m.height - 1, Math.floor(r * m.height / N))
      g[r * N + c] = m.mask[py * m.width + px] ? 1 : 0
    }
    return g
  }
  const a = toGrid(crop(views[key].mask, views[key].width, views[key].height))
  const b = toGrid(crop(om, proj.width, proj.height))
  let inter = 0, uni = 0
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++ }
  return inter / uni
}

// ===========================================================================
hdr('生成自洽夹具到 samples2/')
fs.mkdirSync(OUT, { recursive: true })
const expected = {}
const built = {}

for (const [name, spec] of Object.entries(SHAPES)) {
  log('')
  log(`【${name}】${spec.desc}`)
  const views = buildViews(spec)
  const files = {}
  for (const key of ['front', 'side', 'top']) {
    const f = path.join(OUT, `${name}-${key}.png`)
    fs.writeFileSync(f, encodeGrayPNG(views[key].gray, views[key].width, views[key].height))
    files[key] = path.basename(f)
    log(`  ✅ ${path.basename(f).padEnd(24)} ${views[key].width}×${views[key].height}  面积 ${views[key].area}  内容框铺满 ✅`)
  }

  // ---- 断言 2：自洽等式 ----
  assert.equal(views.front.width, views.top.width, `${name}: front.width 应等于 top.width`)
  assert.equal(views.front.height, views.side.height, `${name}: front.height 应等于 side.height`)
  assert.equal(views.side.width, views.top.height, `${name}: side.width 应等于 top.height`)
  log(`  ✅ 自洽等式：front.width(=top.width)=${views.front.width}，front.height(=side.height)=${views.front.height}，side.width(=top.height)=${views.side.width}`)

  // 包成 silhouette 结果，供 carve 使用
  const sil = {}
  for (const key of ['front', 'side', 'top']) sil[key] = silhouetteOf(views[key])
  built[name] = { views: sil, spec, files, raw: views }

  expected[name] = {
    desc: spec.desc,
    kind: spec.kind,
    files,
    views: Object.fromEntries(['front', 'side', 'top'].map((k) => [k, {
      file: files[k], width: views[k].width, height: views[k].height,
      area: views[k].area, bbox: views[k].bbox,
    }])),
  }
}

// ===========================================================================
hdr('端到端验证：自洽性 + 亏格 + 体积 + 重投影')
log('夹具        carve 网格        stretched  亏格(V−E+F)   体积         期望体积      偏差     重投影 IoU(front/side/top)')
for (const [name, b] of Object.entries(built)) {
  const vol = G.carve(b.views, { resolution: 120, padding: 0 })
  const vc = vol.viewConsistency
  assert.equal(vc.stretched, false, `${name}: viewConsistency.stretched 应为 false，实际 ${vc.stretched} —— ${vc.warning}`)
  assert.equal(vc.inconsistent.length, 0, `${name}: 不该有不相容的视图对`)

  // 用**未归一化**的 meshFromVoxels：buildMesh 会把坐标归一化，体积就不是体素单位了。
  const m = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
  const st = G.meshStats(m.positions, m.indices)
  const topo = eulerGenus(m)
  const volume = volumeOf(m)

  // 期望体积 = 剪影面积（体素化后）× 挤出长度
  const [nx, ny, nz] = [vol.nx, vol.ny, vol.nz]
  const flat = name === 'lshape'
    ? (nx * ny - (nx - 40) * (ny - 40))   // L 形面积
    : (nx * ny - 40 * 40)                  // 方环面积
  const wantVol = flat * nz
  const dev = (volume - wantVol) / wantVol

  const ious = ['front', 'side', 'top'].map((k) => iouWithReprojection(b.views, vol, k, 128))
  const wantGenus = b.spec.kind === 'tube' ? 1 : 0
  log(`${name.padEnd(11)} [${String(nx).padStart(3)},${String(ny).padStart(3)},${String(nz).padStart(3)}]      ${String(vc.stretched).padStart(5)}    ${String(topo.genus).padStart(4)} (χ=${topo.chi})   ${volume.toFixed(0).padStart(9)}   ${wantVol.toFixed(0).padStart(9)}   ${(dev * 100).toFixed(2).padStart(6)}%   ${ious.map((x) => x.toFixed(3)).join(' / ')}`)

  // ---- 断言 4：亏格 ----
  assert.equal(topo.genus, wantGenus,
    `${name}: 亏格应为 ${wantGenus}（${b.spec.kind === 'tube' ? '方管有通孔' : '实心柱'}），实际 ${topo.genus}`)
  // ---- 断言 5：体积偏差 < 5% ----
  assert.ok(Math.abs(dev) < 0.05, `${name}: 体积偏差 ${(dev * 100).toFixed(2)}% 超过 5%`)
  // ---- 断言 6：重投影 IoU > 0.97 ----
  for (const [i, k] of ['front', 'side', 'top'].entries()) {
    assert.ok(ious[i] > 0.97, `${name}: ${k} 重投影 IoU ${ious[i].toFixed(3)} 低于 0.97`)
  }
  assert.equal(st.watertight, true, `${name}: 重建结果应水密`)

  expected[name].verified = {
    carveGrid: [nx, ny, nz],
    stretched: vc.stretched,
    genus: topo.genus,
    eulerCharacteristic: topo.chi,
    volume: Number(volume.toFixed(3)),
    expectedVolume: Number(wantVol.toFixed(3)),
    volumeDeviation: Number(dev.toFixed(6)),
    watertight: st.watertight,
    reprojectionIoU: Object.fromEntries(['front', 'side', 'top'].map((k, i) => [k, Number(ious[i].toFixed(5))])),
    vertexCount: st.vertexCount,
    triangleCount: st.triangleCount,
  }
}
log('')
log('✅ 全部断言通过：viewConsistency.stretched === false；亏格与形状语义一致；体积/重投影在容差内')

// ===========================================================================
hdr('对照：旧夹具（拉伸版）vs 新夹具（自洽版）')
const OLD = path.join(ROOT, 'samples')
log('夹具        版本   carve 网格      拉伸                 体积(体素坐标)  包围盒(体素坐标)              亏格')
for (const name of ['lshape', 'torus-ish']) {
  for (const which of ['old', 'new']) {
    const dir = which === 'old' ? OLD : OUT
    const suffix = which === 'old' ? '-front.png' : '-front.png'
    const loadOne = (k) => {
      const buf = fs.readFileSync(path.join(dir, `${name}-${k}.png`))
      return G.silhouette(pngToRGBA(buf))
    }
    const views = { front: loadOne('front'), side: loadOne('side'), top: loadOne('top') }
    const vol = G.carve(views, { resolution: 120, padding: 0 })
    const m = G.meshFromVoxels(vol.occupied, vol.nx, vol.ny, vol.nz, { smooth: 0, pad: 1 })
    const st = G.meshStats(m.positions, m.indices)
    const topo = eulerGenus(m)
    const vc = vol.viewConsistency
    const stretch = vc.inconsistent.map((p) => `${p.label.split(' ')[0]}=${p.ratio}×`).join(',') || '无'
    log(`${name.padEnd(11)} ${which.padEnd(5)} [${String(vol.nx).padStart(3)},${String(vol.ny).padStart(3)},${String(vol.nz).padStart(3)}]    ${stretch.padEnd(20)} ${volumeOf(m).toFixed(0).padStart(13)}  ${st.extent.map((v) => v.toFixed(1)).join(' × ').padEnd(26)} ${topo.genus}`)
  }
}
log('')
log('说明：')
log('  · 旧 lshape 的 top 是 40×60（竖臂条带），新的是 120×60（完整俯视投影）⇒ 旧的被拉宽 3×；')
log('  · 旧 torus-ish 的 side 是 120×30，新的是 120×120 ⇒ 旧的被拉高 4×；')
log('  · 亏格：L 形柱应为 0、方管应为 1。旧夹具因为被拉伸，重建出的拓扑与作者意图不符。')
log('')
log('注：本脚本**不动 samples/ 里的旧文件** —— 它们现在是"不自洽检测"的回归用例，有价值。')

function pngToRGBA(buf) {
  const png = decodePNG(buf)
  return { data: png.rgba, width: png.width, height: png.height }
}

// ===========================================================================
hdr('写 expected.json')
const expPath = path.join(OUT, 'expected.json')
fs.writeFileSync(expPath, JSON.stringify(expected, null, 2))
log(`✅ ${path.relative(ROOT, expPath)}（${Object.keys(expected).length} 个夹具，含 verified 段）`)
log('')
log('生成完毕。')
