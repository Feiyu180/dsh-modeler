/**
 * 网格文件读写：OBJ / STL(二进制 + ASCII) / GLB / dsh-modeler JSON。
 * 与 src/core/geometry.js 里的导出函数配对 —— 那边只管写，这边既能写也能读，
 * 并且读回来的东西要能和原网格对齐（tools/selftest 里有往返一致性测试）。
 *
 * 只做几何，不碰材质/UV/法线/层级：这个插件产出的是纯几何体。
 */

import { toOBJ, toSTLBinary, toSTLAscii, toGLB, toGLTF, toMeshJSON } from './geometry.js'

// ---------------------------------------------------------------------------
// 顶点焊接
// ---------------------------------------------------------------------------

/**
 * 按位置焊接重合顶点（量化到 eps）。
 *
 * 为什么必须做：**二进制 STL 的每个三角形都独立存三个顶点，不共享顶点索引**。
 * 直接对读回来的 STL 算拓扑，会得到"每条边只属于 1 个三角形" —— 于是
 * `watertight` 永远是 false、`boundaryEdges` 恒等于边数，给出"不水密、打印前
 * 需要修"的错误结论（模型明明是水密的，只是格式不表达共享）。
 *
 * 量化而不是精确比较：STL 的 float32 往返会有微小误差，浮点全等判断会漏焊。
 *
 * @returns {{positions:Float32Array, indices:Uint32Array, mergedVertices:number}}
 */
export function weldVertices(positions, indices, eps = 1e-6) {
  const q = 1 / eps
  const map = new Map()
  const out = []
  const remap = new Uint32Array(positions.length / 3)
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const kx = Math.round(positions[i] * q)
    const ky = Math.round(positions[i + 1] * q)
    const kz = Math.round(positions[i + 2] * q)
    const key = kx + ',' + ky + ',' + kz
    let id = map.get(key)
    if (id === undefined) {
      id = out.length / 3
      map.set(key, id)
      out.push(positions[i], positions[i + 1], positions[i + 2])
    }
    remap[v] = id
  }
  const outIdx = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]]
  return {
    positions: new Float32Array(out),
    indices: outIdx,
    mergedVertices: positions.length / 3 - out.length / 3,
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export const FORMATS = ['obj', 'stl', 'stl-ascii', 'glb', 'gltf', 'json']

export function serializeMesh(positions, indices, format, name = 'model') {
  const f = String(format || 'obj').toLowerCase()
  if (f === 'obj') return { data: toOBJ(positions, indices, name), binary: false, ext: 'obj' }
  if (f === 'stl') return { data: toSTLBinary(positions, indices, name), binary: true, ext: 'stl' }
  if (f === 'stl-ascii') return { data: toSTLAscii(positions, indices, name), binary: false, ext: 'stl' }
  if (f === 'glb') return { data: toGLB(positions, indices, name), binary: true, ext: 'glb' }
  if (f === 'gltf') return { data: toGLTF(positions, indices, name), binary: false, ext: 'gltf' }
  if (f === 'json') return { data: toMeshJSON(positions, indices, { name }), binary: false, ext: 'json' }
  throw new Error(`不支持的导出格式 "${format}"，可用：${FORMATS.join(' / ')}`)
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 读网格文件，按内容自动识别 OBJ / STL(二进制或 ASCII) / GLB / dsh-modeler JSON。
 * @param {Buffer|Uint8Array} buf
 * @returns {{positions:Float32Array, indices:Uint32Array, format:string}}
 */
export function parseMesh(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 4) throw new Error('文件太小，不是网格文件')

  // GLB: 'glTF'
  if (b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return parseGLB(b)

  // ASCII STL / OBJ / JSON 系（自家的 .json 与 .gltf 都以 '{' 开头）：看开头是不是可打印文本
  const head = b.toString('utf8', 0, Math.min(512, b.length)).trimStart().toLowerCase()
  // 文本 JSON 必须在 OBJ 之前判：它们内部也有 "positions": [...] 之类的字样
  if (head.startsWith('{')) {
    // 两种 JSON 长得像但语义不同：自家转储有 format 字段，glTF 有 asset/meshes。
    // 先各自认领，认不出来才报错 —— 不猜。
    const text = b.toString('utf8')
    if (/"format"\s*:\s*"dsh-modeler\.mesh"/.test(text.slice(0, 4096))) return parseMeshJSON(b)
    if (/"asset"\s*:/.test(text.slice(0, 4096))) return parseGLTF(b)
    throw new Error('是 JSON，但既不是 dsh-modeler 网格转储（缺 format 字段）也不是 glTF（缺 asset 字段）')
  }
  if (head.startsWith('solid') && looksLikeAsciiSTL(b)) return parseSTLAscii(b)
  if (head.startsWith('solid')) return parseSTLBinary(b)
  if (head.startsWith('#') || head.includes('\nv ') || head.startsWith('v ') || head.includes('\nf ') || head.startsWith('o ') || head.startsWith('mtllib')) {
    return parseOBJ(b)
  }
  // 兜底：当成二进制 STL
  return parseSTLBinary(b)
}

/**
 * 读 `toMeshJSON` 写出的 JSON。**故意严格**：格式/字段/长度/索引范围任何一项不对就报错，
 * 不要"尽力猜" —— 猜出来的半截网格导进别的程序只会更迷惑。
 */
export function parseMeshJSON(buf) {
  const text = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8')
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法 JSON：${e.message}`)
  }
  if (!doc || typeof doc !== 'object') throw new Error('JSON 顶层不是对象')
  if (doc.format !== 'dsh-modeler.mesh') {
    throw new Error(`不是 dsh-modeler 网格 JSON（format = ${JSON.stringify(doc.format)}）`)
  }
  const pos = doc.positions
  const idx = doc.indices
  if (!Array.isArray(pos) || !Array.isArray(idx)) throw new Error('缺少 positions / indices 数组')
  if (pos.length % 3 !== 0) throw new Error(`positions 长度 ${pos.length} 不是 3 的倍数`)
  if (idx.length % 3 !== 0) throw new Error(`indices 长度 ${idx.length} 不是 3 的倍数`)
  if (!idx.length) throw new Error('indices 为空，没有三角形')
  // 计数对不上说明文件被改坏了 —— 宁可报错，也别拿一个"看着有内容"的错网格继续跑
  if (doc.vertexCount != null && doc.vertexCount !== pos.length / 3) {
    throw new Error(`vertexCount 与实际不符：声明 ${doc.vertexCount}，实际 ${pos.length / 3}`)
  }
  if (doc.triangleCount != null && doc.triangleCount !== idx.length / 3) {
    throw new Error(`triangleCount 与实际不符：声明 ${doc.triangleCount}，实际 ${idx.length / 3}`)
  }
  const vmax = pos.length / 3
  const positions = new Float32Array(pos.length)
  for (let i = 0; i < pos.length; i++) {
    const v = pos[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`positions 第 ${i} 项不是有限数字`)
    positions[i] = v
  }
  const indices = new Uint32Array(idx.length)
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]
    if (!Number.isInteger(v) || v < 0 || v >= vmax) {
      throw new Error(`indices 第 ${i} 项 ${v} 越界（顶点数 ${vmax}）`)
    }
    indices[i] = v
  }
  return { positions, indices, format: 'dsh-modeler-json', meta: doc }
}

function looksLikeAsciiSTL(b) {
  const text = b.toString('utf8', 0, Math.min(4096, b.length))
  return /facet\s+normal/i.test(text) || /outer\s+loop/i.test(text)
}

// --- OBJ ---------------------------------------------------------------------

export function parseOBJ(buf) {
  const text = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8')
  const v = []
  const idx = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line || line[0] === '#') continue
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const tag = line.slice(0, sp)
    if (tag === 'v') {
      const p = line.slice(sp + 1).trim().split(/\s+/)
      v.push(Number(p[0]), Number(p[1]), Number(p[2]))
    } else if (tag === 'f') {
      const parts = line.slice(sp + 1).trim().split(/\s+/)
      const corners = parts.map((tok) => {
        const first = tok.split('/')[0]
        let n = parseInt(first, 10)
        if (Number.isNaN(n)) return -1
        // OBJ 索引从 1 开始；负数表示相对末尾
        if (n < 0) n = v.length / 3 + n
        else n = n - 1
        return n
      }).filter((n) => n >= 0 && n < v.length / 3)
      // 多边形三角化（扇形）
      for (let i = 1; i + 1 < corners.length; i++) {
        idx.push(corners[0], corners[i], corners[i + 1])
      }
    }
  }
  if (!v.length) throw new Error('OBJ 里没有顶点')
  return { positions: new Float32Array(v), indices: new Uint32Array(idx), format: 'obj' }
}

// --- STL ---------------------------------------------------------------------

export function parseSTLBinary(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 84) throw new Error('二进制 STL 太短（应至少 84 字节）')
  const count = b.readUInt32LE(80)
  const need = 84 + count * 50
  if (b.length < need) {
    throw new Error(`二进制 STL 长度不符：头部声明 ${count} 个三角形需要 ${need} 字节，实际只有 ${b.length} 字节`)
  }
  const positions = new Float32Array(count * 9)
  const indices = new Uint32Array(count * 3)
  let off = 84
  for (let t = 0; t < count; t++) {
    off += 12 // 跳过面法线
    for (let k = 0; k < 3; k++) {
      positions[t * 9 + k * 3] = b.readFloatLE(off)
      positions[t * 9 + k * 3 + 1] = b.readFloatLE(off + 4)
      positions[t * 9 + k * 3 + 2] = b.readFloatLE(off + 8)
      indices[t * 3 + k] = t * 3 + k
      off += 12
    }
    off += 2 // attribute byte count
  }
  return { positions, indices, format: 'stl-binary' }
}

export function parseSTLAscii(buf) {
  const text = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8')
  const v = []
  const idx = []
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    v.push(Number(m[1]), Number(m[2]), Number(m[3]))
    if (v.length % 9 === 0) {
      const base = v.length / 3 - 3
      idx.push(base, base + 1, base + 2)
    }
  }
  if (!v.length) throw new Error('ASCII STL 里没有 vertex 行')
  return { positions: new Float32Array(v), indices: new Uint32Array(idx), format: 'stl-ascii' }
}

// --- GLB ---------------------------------------------------------------------

export function parseGLB(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（魔数不对）')
  const version = b.readUInt32LE(4)
  if (version !== 2) throw new Error(`只支持 glTF 2.0，这个文件是 ${version}`)
  const total = b.readUInt32LE(8)
  if (total > b.length) throw new Error('GLB 长度字段超过文件实际大小')

  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off)
    const type = b.readUInt32LE(off + 4)
    const data = b.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8').replace(/\0+$/, '').trim())
    else if (type === 0x004e4942) bin = data
    off += 8 + len
  }
  if (!json) throw new Error('GLB 里没有 JSON chunk')
  if (!bin) throw new Error('GLB 里没有 BIN chunk（外部 .bin 引用的模型请先转成内嵌）')
  return readGltfMesh(json, bin, 'GLB')
}

/**
 * 文本 glTF（`.gltf`）。只支持**缓冲内嵌**（data URI）的单文件 —— 外部 .bin 的
 * 两件套会报一条说清楚原因的错误，而不是猜着读半个模型。
 */
export function parseGLTF(buf) {
  const text = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`glTF 不是合法 JSON：${e.message}`)
  }
  if (!json || typeof json !== 'object') throw new Error('glTF 顶层不是对象')
  if (!json.asset || String(json.asset.version || '') !== '2.0') {
    throw new Error(`只支持 glTF 2.0，这个文件声明的是 ${JSON.stringify(json.asset && json.asset.version)}`)
  }
  const bufs = Array.isArray(json.buffers) ? json.buffers : []
  if (!bufs.length) throw new Error('glTF 没有 buffers')
  const chunks = []
  for (const b of bufs) {
    const uri = String(b.uri || '')
    if (!uri) throw new Error('glTF 的 buffer 没有 uri（GLB 那种二进制块请用 .glb）')
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(uri)
    if (!m) {
      throw new Error(`glTF 引用了外部文件（${uri.slice(0, 80)}）。请改用内嵌式 .gltf 或 .glb —— `
        + '本工具不读两件套，硬读只会得到半个模型。')
    }
    chunks.push(Buffer.from(m[1], 'base64'))
  }
  const bin = Buffer.concat(chunks)
  return readGltfMesh(json, bin, 'glTF')
}

/** glTF 文档 + 二进制缓冲 → 网格。GLB 与 .gltf 共用（accessor 语义完全一样）。 */
function readGltfMesh(json, bin, label) {
  const COMPONENT = {
    5120: { size: 1, read: (dv, o) => dv.getInt8(o) },
    5121: { size: 1, read: (dv, o) => dv.getUint8(o) },
    5122: { size: 2, read: (dv, o) => dv.getInt16(o, true) },
    5123: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
    5125: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
    5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
  }
  const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const readAccessor = (ai) => {
    const acc = json.accessors[ai]
    const bv = json.bufferViews[acc.bufferView]
    const comp = COMPONENT[acc.componentType]
    const n = TYPE_COUNT[acc.type]
    if (!comp) throw new Error(`${label} accessor 用了不支持的 componentType ${acc.componentType}`)
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0)
    const stride = bv.byteStride || comp.size * n
    const out = new (acc.componentType === 5126 ? Float32Array : Uint32Array)(acc.count * n)
    for (let i = 0; i < acc.count; i++) {
      for (let k = 0; k < n; k++) {
        out[i * n + k] = comp.read(dv, base + i * stride + k * comp.size)
      }
    }
    return out
  }

  let positions = null
  let indices = null
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue // 只要三角形
      const pos = prim.attributes?.POSITION
      if (pos === undefined) continue
      const p = readAccessor(pos)
      const i = prim.indices !== undefined
        ? Uint32Array.from(readAccessor(prim.indices))
        : Uint32Array.from({ length: p.length / 3 }, (_, k) => k)
      if (!positions) {
        positions = p
        indices = i
      } else {
        // 多个 primitive：拼起来
        const base = positions.length / 3
        const merged = new Float32Array(positions.length + p.length)
        merged.set(positions, 0)
        merged.set(p, positions.length)
        positions = merged
        const mergedI = new Uint32Array(indices.length + i.length)
        mergedI.set(indices, 0)
        for (let k = 0; k < i.length; k++) mergedI[indices.length + k] = i[k] + base
        indices = mergedI
      }
    }
  }
  if (!positions) throw new Error(`${label} 里没找到三角形网格（POSITION + mode=4）`)
  return { positions, indices, format: label === 'GLB' ? 'glb' : 'gltf' }
}
