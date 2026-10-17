/**
 * 独立审查脚本 E：mesh-io 的往返一致性 + 格式识别边界。
 *
 * 往返：buildMesh → toOBJ / toSTLBinary / toSTLAscii / toGLB → parseMesh → 比几何。
 * 说明：STL 无共享顶点，顶点数必然变成 3T，所以用**几何量**比（包围盒/体积/面积），
 *       而不是比顶点数。
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-io.mjs
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

const bboxOf = (p) => {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k] < a[k]) a[k] = p[i + k]
    if (p[i + k] > b[k]) b[k] = p[i + k]
  }
  return { min: a, max: b }
}
const volumeOf = (pos, idx) => {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6
  }
  return v
}
const areaOf = (pos, idx) => {
  let s = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    s += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  return s
}

// ---------------------------------------------------------------------------
hdr('E-1 四种格式的往返误差')
const fixtures = ['box', 'sphere', 'cylinder', 'cone', 'lshape', 'torus-ish', 'tiny', 'asym']
console.log('夹具      格式       顶点数(原→回)      三角形(原→回)     体积相对差       包围盒最大差     面积相对差')
let worst = { rel: 0 }
for (const base of fixtures) {
  const m = G.buildMesh(load(base), { resolution: 64, padding: 0.06, smooth: 0 })
  const P = m.positions, I = m.indices
  const v0 = volumeOf(P, I), a0 = areaOf(P, I), b0 = bboxOf(P)
  for (const fmt of ['obj', 'stl', 'stl-ascii', 'glb']) {
    const s = IO.serializeMesh(P, I, fmt, 'm')
    const back = IO.parseMesh(s.data)
    const v1 = volumeOf(back.positions, back.indices)
    const a1 = areaOf(back.positions, back.indices)
    const b1 = bboxOf(back.positions)
    const relV = Math.abs(v1 - v0) / Math.abs(v0)
    const relA = Math.abs(a1 - a0) / Math.abs(a0)
    let db = 0
    for (let k = 0; k < 3; k++) db = Math.max(db, Math.abs(b1.min[k] - b0.min[k]), Math.abs(b1.max[k] - b0.max[k]))
    if (relV > worst.rel) worst = { rel: relV, base, fmt }
    console.log(`${base.padEnd(10)} ${fmt.padEnd(10)} ${String(P.length / 3).padStart(6)}→${String(back.positions.length / 3).padStart(6)}  ${String(I.length / 3).padStart(6)}→${String(back.indices.length / 3).padStart(6)}  ${relV.toExponential(3).padStart(12)}  ${db.toExponential(3).padStart(14)}  ${relA.toExponential(3).padStart(12)}`)
  }
}
console.log('')
console.log(`最差体积往返误差：${worst.rel.toExponential(3)}（${worst.base} / ${worst.fmt}）`)
console.log('注：OBJ 走十进制文本（toFixed(6)）会有 1e-6 量级舍入；STL 是 float32 但顶点被复制 3 次；')
console.log('    GLB 若顶点数 ≤65535 用 u16 索引、否则 u32 —— 这里都是 float32 原样搬运。')

// ---------------------------------------------------------------------------
hdr('E-2 顶点顺序是否变化（GLB 声称"顺序可能不同但几何等价"）')
{
  const base = 'sphere'
  const m = G.buildMesh(load(base), { resolution: 64 })
  const P = m.positions, I = m.indices
  for (const fmt of ['obj', 'stl', 'stl-ascii', 'glb']) {
    const back = IO.parseMesh(IO.serializeMesh(P, I, fmt, 'm').data)
    let sameOrder = back.positions.length === P.length
    if (sameOrder) for (let i = 0; i < P.length; i++) if (P[i] !== back.positions[i]) { sameOrder = false; break }
    // 若顶点数不同（STL），检查三角形是否按序相同
    let triSame = back.indices.length === I.length
    if (triSame) for (let i = 0; i < I.length; i++) if (I[i] !== back.indices[i]) { triSame = false; break }
    console.log(`${fmt.padEnd(10)} 顶点逐位相同=${sameOrder}  三角形索引逐位相同=${triSame}  顶点数 ${P.length / 3}→${back.positions.length / 3}  三角形 ${I.length / 3}→${back.indices.length / 3}`)
  }
  console.log('')
  console.log('STL 必然"顶点数 = 3×三角形数"（格式本身不共享顶点），所以它的顶点索引是 0,1,2,3,4,5…')
  console.log('GLB/OBJ 则保持原顶点表与索引表 ⇒ 往返是**逐位**可逆的（OBJ 除了 1e-6 文本舍入）。')
}

// ---------------------------------------------------------------------------
hdr('E-3 格式识别与边界情形')
{
  const t = (name, fn) => {
    try { const r = fn(); console.log(`  ✅ ${name}  →  ${r}`) }
    catch (e) { console.log(`  ❌ ${name}  →  抛错：${e.message}`) }
  }

  console.log('E-3a 二进制 STL 头部以 "solid" 开头（业界经典的格式嗅探陷阱）')
  {
    const m = G.buildMesh(load('box'), { resolution: 32 })
    const bin = G.toSTLBinary(m.positions, m.indices, 'x')
    // 手工把头部前 5 字节改成 'solid'（真实世界很常见：很多工具写 "solid <name>"）
    const patched = Uint8Array.from(bin)
    const head = 'solid exported-by-some-cad '
    for (let i = 0; i < head.length && i < 80; i++) patched[i] = head.charCodeAt(i)
    // 同时确保后面没有 "facet normal" 文本（二进制当然没有）
    t('头部 "solid ..." 的二进制 STL 仍应按二进制解析', () => {
      const r = IO.parseMesh(Buffer.from(patched))
      return `识别为 ${r.format}，三角形 ${r.indices.length / 3}（原 ${m.indices.length / 3}）`
    })
  }

  console.log('')
  console.log('E-3b STL 声明三角形数与文件长度不符')
  {
    const m = G.buildMesh(load('box'), { resolution: 32 })
    const bin = Uint8Array.from(G.toSTLBinary(m.positions, m.indices, 'x'))
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    dv.setUint32(80, 999999, true)
    t('声明 999999 个三角形但文件很小', () => IO.parseMesh(Buffer.from(bin)).format)
  }

  console.log('')
  console.log('E-3c OBJ：负索引（相对末尾）与多边形扇形三角化')
  {
    const obj = '# t\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n'
    t('四边形 + 全负索引', () => {
      const r = IO.parseOBJ(Buffer.from(obj))
      return `顶点 ${r.positions.length / 3}，三角形 ${r.indices.length / 3}（期望 2），索引=[${r.indices.join(',')}]`
    })
  }

  console.log('')
  console.log('E-3d OBJ：索引越界（仓库实现会静默丢弃）')
  {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\nf 1 2 3\n'
    t('含一条越界索引的 OBJ', () => {
      const r = IO.parseOBJ(Buffer.from(obj))
      return `得到 ${r.indices.length / 3} 个三角形（输入 2 个面，其中 1 个越界）。**没有报警**`
    })
  }

  console.log('')
  console.log('E-3e GLB 的 u16/u32 索引分界（顶点数 65535 / 65536）')
  {
    const mk = (nv) => {
      const p = new Float32Array(nv * 3)
      for (let i = 0; i < nv; i++) { p[i * 3] = i * 1e-3; p[i * 3 + 1] = 0; p[i * 3 + 2] = 0 }
      const idx = new Uint32Array((nv - 2) * 3)
      for (let i = 0; i + 2 < nv; i++) { idx[i * 3] = 0; idx[i * 3 + 1] = i + 1; idx[i * 3 + 2] = i + 2 }
      return { p, idx }
    }
    for (const nv of [65535, 65536]) {
      const { p, idx } = mk(nv)
      const glb = G.toGLB(p, idx, 'big')
      // 从 JSON 里读 componentType
      const len = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true)
      const json = JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, len).toString('utf8').trim())
      const ct = json.accessors[1].componentType
      const back = IO.parseGLB(Buffer.from(glb))
      const maxIdx = back.indices.reduce((a, b) => (b > a ? b : a), 0)
      console.log(`  顶点数=${nv}  componentType=${ct}（5123=u16, 5125=u32）  回读最大索引=${maxIdx}  期望 ${nv - 1}  ${maxIdx === nv - 1 ? '✅' : '❌'}`)
    }
    console.log('  说明：useU16 的判据是 vertexCount ≤ 65535，正好卡在 u16 的上界上，是对的。')
  }

  console.log('')
  console.log('E-3f 空网格 / 极短输入')
  {
    t('空 OBJ（只有注释）', () => IO.parseOBJ(Buffer.from('# nothing\n')).format)
    t('空 STL（84 字节但 count=0）', () => IO.parseSTLBinary(Buffer.alloc(84)).format)
    t('2 字节垃圾', () => IO.parseMesh(Buffer.from([1, 2])).format)
  }
}

// ---------------------------------------------------------------------------
hdr('E-4 toGLB 是否符合 glTF 2.0 的硬性约束（用独立解析核对 chunk/对齐）')
{
  const m = G.buildMesh(load('sphere'), { resolution: 64 })
  const glb = G.toGLB(m.positions, m.indices, 'm')
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const magic = dv.getUint32(0, true), ver = dv.getUint32(4, true), total = dv.getUint32(8, true)
  const jLen = dv.getUint32(12, true), jType = dv.getUint32(16, true)
  const bOff = 20 + jLen
  const bLen = dv.getUint32(bOff, true), bType = dv.getUint32(bOff + 4, true)
  console.log(`魔数 0x${magic.toString(16)}（应为 46546c67 'glTF'）  版本=${ver}  total=${total}  实际字节=${glb.byteLength}`)
  console.log(`JSON chunk: len=${jLen}  type=0x${jType.toString(16)}（应为 4e4f534a 'JSON'）  len%4=${jLen % 4}`)
  console.log(`BIN  chunk: len=${bLen}  type=0x${bType.toString(16)}（应为 004e4942 'BIN\\0'）  len%4=${bLen % 4}`)
  const json = JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, jLen).toString('utf8').trim())
  const expPos = (m.positions.length / 3) * 12
  const expIdx = (m.indices.length) * (json.accessors[1].componentType === 5123 ? 2 : 4)
  console.log(`缓冲期望：POSITION ${expPos} 字节 + 索引 ${expIdx} 字节 = ${expPos + expIdx}；bufferViews 声明 = ${json.bufferViews.map((b) => b.byteLength).join(' + ')}`)
  console.log(`buffers[0].byteLength=${json.buffers[0].byteLength}  BIN chunk len=${bLen}  ${json.buffers[0].byteLength === bLen ? '✅ 一致' : '❌ 不一致'}`)
  const checks = [
    ['魔数正确', magic === 0x46546c67],
    ['版本为 2', ver === 2],
    ['total 与实际字节相等', total === glb.byteLength],
    ['JSON chunk 4 字节对齐', jLen % 4 === 0],
    ['BIN chunk 4 字节对齐', bLen % 4 === 0],
    ['JSON chunk 类型正确', jType === 0x4e4f534a],
    ['BIN chunk 类型正确', bType === 0x004e4942],
    ['buffers[0] 长度与 BIN chunk 一致', json.buffers[0].byteLength === bLen],
    ['POSITION accessor 有 min/max（glTF 2.0 要求）', Array.isArray(json.accessors[0].min) && Array.isArray(json.accessors[0].max)],
  ]
  console.log('')
  for (const [n, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${n}`)
}
