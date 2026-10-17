/**
 * dsh-modeler —— host 半边。
 *
 * 职责边界（故意的）：
 *   - **不做雕刻计算**。雕刻跑在浏览器面板里（算法是同一份 src/core/geometry.js，
 *     打包进客户端 bundle），所以拖动参数是即时的、不需要往返 host。
 *   - host 只做浏览器做不到的三件事：把网格**写到磁盘**、把磁盘上的模型**读回来**、
 *     把模型**切片成 PNG**（可以用 read_image 直接看，也能和输入剪影并排对照）。
 *
 * 工具：
 *   modeler_save    网格数据 → 工作区 Modeler\<名字>.<obj|stl|glb>
 *   modeler_load    读模型文件 → 统计（顶点/三角形/水密/体积/包围盒）
 *   modeler_views   模型文件 → 三视图 PNG（前/侧/俯 拼一张，附对照）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { meshStats, projectViews, toOBJ, toSTLBinary, toSTLAscii, toGLB, toGLTF, toMeshJSON } from '../core/geometry.js'
import { describeProviders, probeEnvironment, recommend, INSTALL_PLANS, listInstallPlans } from './ai-models.js'
import { encodeGrayPNG } from '../core/png.js'
import { parseMesh, weldVertices } from '../core/mesh-io.js'

export const name = 'modeler'
// 依赖声明必须是**数组**：DSH 的插件加载器只认数组形式，写成
// { required, optional } 会让它去找名为 "required"/"optional" 的服务，插件永远停在 pending。
//
// webServer 原本想走"可选获取"（不写进 inject、用 ctx.get('webServer')），实测**拿不到** ——
// Cordis 的 ctx.get 只沿当前 context 的祖先链找服务，而 webServer 由 web 组合提供，
// 不在本插件的祖先链上，所以永远返回 undefined、路由静默不注册（表现为 404，且毫无报错）。
// 要拿到就必须声明依赖：声明后 Cordis 会把服务实例挂到 ctx.webServer 上。
// 代价是硬依赖 —— webServer 缺席时本插件不激活；对本插件可接受，它本来就是给 Web GUI 用的。
export const inject = ['tools', 'webServer']

const DEFAULTS = {
  /** 输出目录（相对会话工作区） */
  outDir: 'Modeler',
  /** 单个工具返回里最多列几个文件 */
  maxListed: 40,
}

const cfg = { ...DEFAULTS }
const state = { logger: null }

const log = (...a) => {
  try {
    const logger = state.logger
    if (logger && typeof logger.info === 'function') logger.info('[modeler]', ...a)
  } catch {
    /* 记日志失败不影响功能 */
  }
}

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function sessionCwd(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : ''
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

function outDir(exec, sub) {
  const base = path.resolve(sessionCwd(exec), cfg.outDir)
  const dir = sub ? path.join(base, sanitize(sub)) : base
  return dir
}

function sanitize(name) {
  const s = String(name == null ? '' : name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim()
  return s === '' || s === '.' || s === '..' ? '' : s.slice(0, 80)
}

function safeJoin(dir, name) {
  const target = path.resolve(dir, name)
  const root = path.resolve(dir)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界：${name}`)
  return target
}

function uniquePath(dir, base, ext) {
  fs.mkdirSync(dir, { recursive: true })
  let i = 1
  for (;;) {
    const p = path.join(dir, i === 1 ? `${base}.${ext}` : `${base}_${String(i).padStart(3, '0')}.${ext}`)
    if (!fs.existsSync(p)) return p
    i++
  }
}

// ---------------------------------------------------------------------------
// 网格数据的两种传法：base64 二进制（推荐）或数字数组
// ---------------------------------------------------------------------------

function readTyped(arg, Type, label) {
  if (arg == null) throw new Error(`${label} 不能为空`)
  if (typeof arg === 'string') {
    const b64 = arg.startsWith('base64:') ? arg.slice(7) : arg
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length) throw new Error(`${label} 解码后为空`)
    if (buf.length % Type.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`${label} 字节数 ${buf.length} 不是 ${Type.BYTES_PER_ELEMENT} 的整数倍`)
    }
    return new Type(buf.buffer, buf.byteOffset, buf.length / Type.BYTES_PER_ELEMENT)
  }
  if (Array.isArray(arg)) return Type.from(arg)
  throw new Error(`${label} 必须是 base64 字符串或数字数组`)
}

function summarize(positions, indices) {
  const st = meshStats(positions, indices)
  return {
    vertexCount: st.vertexCount,
    triangleCount: st.triangleCount,
    // empty 必须往上带：0 三角形时 boundary 也是 0，只看 watertight 会得到
    // "空网格是水密的、可以直接 3D 打印"这种误导结论（独立审查发现的坑）。
    empty: st.empty === true,
    watertight: st.watertight,
    boundaryEdges: st.boundaryEdges,
    nonManifoldEdges: st.nonManifoldEdges,
    volume: Number(st.volume.toFixed(6)),
    bbox: {
      min: st.bbox.min.map((v) => Number(v.toFixed(4))),
      max: st.bbox.max.map((v) => Number(v.toFixed(4))),
    },
    extent: st.extent.map((v) => Number(v.toFixed(4))),
  }
}

// ---------------------------------------------------------------------------
// 工具 1：保存
// ---------------------------------------------------------------------------

const saveTool = {
  name: 'modeler_save',
  description:
    '把三维网格保存成文件（OBJ / STL / GLB），默认写到会话工作区的 Modeler 目录。' +
    '网格数据用 base64 传（两个 Float32/Uint32 小端缓冲区：positions 是每顶点 3 个 float，indices 是每三角形 3 个 uint32）。' +
    '也可以直接传数字数组（小模型方便）。返回落盘路径与网格统计（含是否水密、体积）。',
  parameters: {
    type: 'object',
    properties: {
      positions: {
        type: 'string',
        description: '顶点坐标。base64（推荐，Float32 小端，每顶点 3 个）或数字数组。',
      },
      indices: {
        type: 'string',
        description: '三角形索引。base64（Uint32 小端，每三角形 3 个）或数字数组。',
      },
      format: {
        type: 'string',
        enum: ['obj', 'stl', 'stl-ascii', 'glb', 'gltf', 'json'],
        description: '默认 obj。stl 是二进制（3D 打印最通用），glb 体积最小，gltf 是文本 glTF'
          + '（缓冲内嵌成 data URI，单文件自包含），json 是数据转储（顶点/三角形 + 统计，便于程序再加工或留档）。',
      },
      name: { type: 'string', description: '文件名（不含扩展名），默认 model' },
      subdir: { type: 'string', description: '可选：在 Modeler 下再开一个子目录，用来归档同一次建模' },
    },
    required: ['positions', 'indices'],
    additionalProperties: false,
  },
  output: stringOutput,
  async execute(args, exec) {
    const positions = readTyped(args.positions, Float32Array, 'positions')
    const indices = readTyped(args.indices, Uint32Array, 'indices')
    if (positions.length % 3 !== 0) throw new Error('positions 长度必须是 3 的倍数')
    if (indices.length % 3 !== 0) throw new Error('indices 长度必须是 3 的倍数')
    if (!indices.length) throw new Error('indices 为空，没有三角形可保存')
    const vmax = positions.length / 3
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= vmax) throw new Error(`indices 第 ${i} 项 ${indices[i]} 超出顶点数 ${vmax}`)
    }

    const format = String(args.format || 'obj').toLowerCase()
    const base = sanitize(args.name) || 'model'
    const dir = outDir(exec, args.subdir)

    // 先算统计、再决定写不写。
    // 顺序很重要：空网格必须在**落盘之前**挡住，否则会留下一个 0 三角形的空文件
    // 外加一句"水密、可直接 3D 打印"。0 三角形时 meshStats 的 boundary 也是 0，
    // 只看 watertight 就会得到那个误导结论（独立审查发现的坑）。
    const st = summarize(positions, indices)
    if (st.empty) {
      throw new Error(
        '没有可保存的几何：三角形数为 0，未写入任何文件。' +
        '常见原因：模型相对分辨率太薄（只有 1 个体素厚，角点采样重建不出网格）—— ' +
        '把「分辨率」调高，或确认三视图不是细线条画。',
      )
    }

    let data, ext
    if (format === 'obj') { data = toOBJ(positions, indices, base); ext = 'obj' }
    else if (format === 'stl') { data = toSTLBinary(positions, indices, base); ext = 'stl' }
    else if (format === 'stl-ascii') { data = toSTLAscii(positions, indices, base); ext = 'stl' }
    else if (format === 'glb') { data = toGLB(positions, indices, base); ext = 'glb' }
    else if (format === 'gltf') { data = toGLTF(positions, indices, base); ext = 'gltf' }
    // JSON 与其它格式共用同一套统计（st），所以文件里既有几何也有"水密/体积/包围盒"
    else if (format === 'json') {
      const { empty: _empty, ...stats } = st
      data = toMeshJSON(positions, indices, { name: base, source: 'modeler_save', stats })
      ext = 'json'
    }
    else throw new Error(`不支持的格式 "${args.format}"，可用 obj / stl / stl-ascii / glb / json`)

    const file = uniquePath(dir, base, ext)
    fs.writeFileSync(file, data)

    log('保存', file, `${st.triangleCount} 三角形`)
    return JSON.stringify({
      ok: true,
      file,
      bytes: fs.statSync(file).size,
      format,
      ...st,
      hint: st.watertight
        ? '网格水密，可以直接 3D 打印或做布尔运算。'
        : '⚠ 网格不水密（有边界边），3D 打印前需要修；可以增大平滑或提高分辨率后重出。',
    }, null, 2)
  },
}

// ---------------------------------------------------------------------------
// 工具 2：读取
// ---------------------------------------------------------------------------

const loadTool = {
  name: 'modeler_load',
  description:
    '读取一个模型文件（OBJ / STL / GLB）并给出几何统计：顶点数、三角形数、是否水密、有符号体积、包围盒。' +
    '用来确认别人给的模型能不能直接 3D 打印（水密 = 边界边 0 且无非流形边）。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '模型文件路径（绝对路径，或相对会话工作区）' },
    },
    required: ['file'],
    additionalProperties: false,
  },
  output: stringOutput,
  async execute(args, exec) {
    const file = resolveFile(args.file, exec)
    const parsed = parseMesh(fs.readFileSync(file))

    // STL（二进制或 ASCII）的每个三角形都独立存顶点、不共享索引，
    // 直接算拓扑会得到"每条边只属于 1 个三角形"→ watertight 恒为 false。
    // 那是**格式的性质**，不是模型破了。所以先按位置焊接再判，否则会误导用户
    // 以为一个好好的模型"打印前需要修"。（这个误报是在本机真实调用时发现的）
    const needWeld = parsed.format.startsWith('stl')
    const welded = needWeld ? weldVertices(parsed.positions, parsed.indices) : null
    const P = welded ? welded.positions : parsed.positions
    const I = welded ? welded.indices : parsed.indices

    const st = summarize(P, I)
    return JSON.stringify({
      ok: true,
      file,
      bytes: fs.statSync(file).size,
      detectedFormat: parsed.format,
      ...st,
      ...(welded
        ? {
            weldNote:
              `${parsed.format} 的顶点不共享，已按位置焊接后判定拓扑：` +
              `顶点 ${parsed.positions.length / 3} → ${P.length / 3}（合并 ${welded.mergedVertices} 个重合顶点）`,
          }
        : {}),
      hint: st.watertight
        ? '水密，可直接 3D 打印。'
        : `不水密（边界边 ${st.boundaryEdges}），打印前需要修。`,
    }, null, 2)
  },
}

function resolveFile(p, exec) {
  const raw = String(p || '').trim()
  if (!raw) throw new Error('file 不能为空')
  const abs = path.isAbsolute(raw) ? raw : path.resolve(sessionCwd(exec), raw)
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  if (!fs.statSync(abs).isFile()) throw new Error(`不是文件：${abs}`)
  return abs
}

// ---------------------------------------------------------------------------
// 工具 3：切片回三视图
// ---------------------------------------------------------------------------

const viewsTool = {
  name: 'modeler_views',
  description:
    '把模型切片成三视图 PNG 并保存（前/侧/俯各一张 + 一张横向拼图），用于肉眼或视觉模型检查重建是否忠实、轴向有没有反。' +
    '切片是正交投影：前视图压 Z、侧视图压 X、俯视图压 Y。返回所有 PNG 路径，可直接用 read_image 看。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '模型文件路径（绝对路径，或相对会话工作区）' },
      size: { type: 'integer', description: '拼图长边像素，默认 256（每张视图按比例缩放到这个长边内）' },
      name: { type: 'string', description: '输出文件名前缀，默认取模型文件名' },
      subdir: { type: 'string', description: '可选：输出到 Modeler 下的子目录' },
      voxelize: {
        type: 'integer',
        description: '可选：先把网格体素化到该分辨率再投影（0=直接从三角形投影，默认 0）。用于和输入剪影做同尺度对照。',
      },
    },
    required: ['file'],
    additionalProperties: false,
  },
  output: stringOutput,
  async execute(args, exec) {
    const file = resolveFile(args.file, exec)
    const parsed = parseMesh(fs.readFileSync(file))
    const size = Math.max(32, Math.min(1024, Number(args.size) || 256))
    const base = sanitize(args.name) || sanitize(path.basename(file).replace(/\.[^.]+$/, '')) || 'model'
    const dir = outDir(exec, args.subdir)

    const occ = rasterize(parsed.positions, parsed.indices, size)
    const views = projectViews(occ.data, occ.nx, occ.ny, occ.nz, size)

    const written = []
    for (const key of ['front', 'side', 'top']) {
      const v = views[key]
      const gray = new Uint8Array(v.width * v.height)
      for (let i = 0; i < gray.length; i++) gray[i] = v.data[i * 4]
      const f = uniquePath(dir, `${base}-${key}`, 'png')
      fs.writeFileSync(f, encodeGrayPNG(gray, v.width, v.height))
      written.push(f)
    }

    // 横向拼图（前 | 侧 | 俯）
    const merged = mergeRow(
      [maskOf(views.front), maskOf(views.side), maskOf(views.top)],
      [views.front.width, views.side.width, views.top.width],
      [views.front.height, views.side.height, views.top.height],
    )
    const sheet = uniquePath(dir, `${base}-三视图`, 'png')
    fs.writeFileSync(sheet, encodeGrayPNG(merged.gray, merged.width, merged.height))
    written.push(sheet)

    const st = summarize(parsed.positions, parsed.indices)
    return JSON.stringify({
      ok: true,
      source: file,
      detectedFormat: parsed.format,
      voxelGrid: [occ.nx, occ.ny, occ.nz],
      files: written,
      sheet,
      ...st,
      hint: '用 read_image 打开最后那张拼图即可一眼看到前/侧/俯三个投影。',
    }, null, 2)
  },
}

function maskOf(v) {
  const m = new Uint8Array(v.width * v.height)
  for (let i = 0; i < m.length; i++) m[i] = v.data[i * 4] ? 1 : 0
  return m
}

function mergeRow(masks, widths, heights) {
  const gap = 6
  const W = widths.reduce((a, b) => a + b, 0) + gap * (masks.length - 1)
  const H = Math.max(...heights)
  const gray = new Uint8Array(W * H).fill(26)
  let ox = 0
  for (let k = 0; k < masks.length; k++) {
    const m = masks[k], w = widths[k], h = heights[k]
    // 垂直居中
    const oy = Math.floor((H - h) / 2)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) gray[(oy + y) * W + ox + x] = 235
      }
    }
    ox += w + gap
  }
  return { gray, width: W, height: H }
}

/**
 * 把三角网格体素化成占据栅格。
 *
 * 做法：对每个三角形的包围盒内的体素，判断其中心到三角形的距离是否小于半个体素，
 * 是就占据。这是保守近似（会略微"胖"半格），但对"看轮廓对不对"这件事足够，
 * 而且比对每个体素做精确相交测试快得多。
 */
function rasterize(positions, indices, targetLong) {
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minx) minx = positions[i]
    if (positions[i] > maxx) maxx = positions[i]
    if (positions[i + 1] < miny) miny = positions[i + 1]
    if (positions[i + 1] > maxy) maxy = positions[i + 1]
    if (positions[i + 2] < minz) minz = positions[i + 2]
    if (positions[i + 2] > maxz) maxz = positions[i + 2]
  }
  const ext = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1
  const k = targetLong / ext
  const nx = Math.max(2, Math.round((maxx - minx) * k))
  const ny = Math.max(2, Math.round((maxy - miny) * k))
  const nz = Math.max(2, Math.round((maxz - minz) * k))
  const data = new Uint8Array(nx * ny * nz)
  const half = 0.5 / k

  const triCount = indices.length / 3
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]

    const lo = (v, mn) => Math.max(0, Math.floor(((Math.min(v[0], v[1], v[2])) - mn) * k - half))
    const hi = (v, mn, n) => Math.min(n - 1, Math.ceil((Math.max(v[0], v[1], v[2]) - mn) * k + half))
    const x0 = lo([ax, bx, cx], minx), x1 = hi([ax, bx, cx], minx, nx)
    const y0 = lo([ay, by, cy], miny), y1 = hi([ay, by, cy], miny, ny)
    const z0 = lo([az, bz, cz], minz), z1 = hi([az, bz, cz], minz, nz)

    for (let z = z0; z <= z1; z++) {
      const pz = minz + (z + 0.5) / k
      for (let y = y0; y <= y1; y++) {
        const py = miny + (y + 0.5) / k
        for (let x = x0; x <= x1; x++) {
          const px = minx + (x + 0.5) / k
          if (pointTriDist(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) <= half) {
            data[(z * ny + y) * nx + x] = 1
          }
        }
      }
    }
  }
  return { data, nx, ny, nz }
}

/** 点到三角形的最短距离（Ericson, Real-Time Collision Detection 的经典算法） */
function pointTriDist(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz)

  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz)

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return Math.hypot(px - (ax + abx * v), py - (ay + aby * v), pz - (az + abz * v))
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz)

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return Math.hypot(px - (ax + acx * w), py - (ay + acy * w), pz - (az + acz * w))
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    return Math.hypot(px - (bx + (cx - bx) * w), py - (by + (cy - by) * w), pz - (bz + (cz - bz) * w))
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return Math.hypot(
    px - (ax + abx * v + acx * w),
    py - (ay + aby * v + acy * w),
    pz - (az + abz * v + acz * w),
  )
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTTP 路由 —— 浏览器面板调 host 的通道
// ---------------------------------------------------------------------------
//
// 为什么走 HTTP 而不是 client 的 `host.call`：
//   client builtin 里确实有 `host.call(method, args)`（package-private JSON RPC 到本包的
//   host 半边），但 host 侧要让那个方法可被找到，得走 `@Remote` + TypeScript 代码生成
//   （Typert 那一套）。本插件是**纯 JS、无构建步骤**，接不了。所以改用
//   `ctx.webServer.register()` —— client 半边直接 fetch 这条路由，链路更短也更直观。
//
// 关于 webServer 依赖：**必须写进 inject**（见文件上方 inject 处注释）。
// 曾经试过不声明、用 ctx.get('webServer') 可选获取 —— 实测永远拿到 undefined，
// 路由静默不注册、只在浏览器侧表现为 404，完全没有报错，极难排查。

const ROUTE_PREFIX = '/dsh-modeler/api'

/**
 * 导出格式 → 扩展名。**扩展名只认这张表**（不读客户端传来的 ext）：
 * 否则一个请求就能往任意文件名写数据，而"文件后缀"恰恰是用户判断"这是什么"的依据。
 */
const EXPORT_EXTS = {
  obj: 'obj',
  stl: 'stl',
  'stl-ascii': 'stl',
  glb: 'glb',
  gltf: 'gltf',
  json: 'json',
}

/**
 * 声称的格式 → 允许被识别成哪些格式。
 * 目的只有一个：**后缀别骗人**。把 OBJ 文本写成 .json 是能在磁盘上活下来的，
 * 但用户看到 .json 会以为是我们的数据转储，工具再打开就一头雾水。
 * stl 允许两种：二进制 STL 的头部是任意字节，识别成 stl-ascii 也合法（反过来同理）。
 */
const EXPORT_DETECTED = {
  obj: ['obj'],
  stl: ['stl-binary', 'stl-ascii'],
  'stl-ascii': ['stl-ascii'],
  glb: ['glb'],
  gltf: ['gltf'],
  json: ['dsh-modeler-json'],
}

// 这台机器上 DSH 只落崩溃日志，普通 log() 根本看不到。
// 排查"路由到底注册没注册"时，把关键事实直接写进文件 —— 唯一可靠的办法。
function hostDebug(msg) {
  try {
    fs.appendFileSync('D:\\dsh-modeler\\_host-debug.log', `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 调试日志失败不影响功能 */
  }
}

/** 读请求体并解析 JSON（带体积上限，别让一个请求把内存吃光） */
async function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error(`请求体过大（>${Math.round(limitBytes / 1024 / 1024)}MB）`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// TripoSR：单图 → 3D（调本机那套独立 Python 环境）
// ---------------------------------------------------------------------------
//
// 走的不是 node 原生 child_process 的默认姿势，而是显式 spawn + Promise 包装：
// 面板要看到"跑到哪一步了"，所以 stdout/stderr 逐行回吐进 job.lines。

const TRIPOSR = {
  python: 'D:\\dsh-data\\dsh-triposr\\python311\\python.exe',
  cwd: 'D:\\dsh-data\\dsh-triposr\\TripoSR-main',
  weights: 'D:\\dsh-data\\dsh-triposr\\weights',
  dinoConfig: 'D:\\dsh-data\\dsh-triposr\\weights\\dino-vitb16\\config.json',
  glbToJson: 'D:\\dsh-data\\dsh-triposr\\glb-to-json.py',
}

// Zero123 多视角生成。⚠ 必须用 **ComfyUI 的嵌入式 Python**，因为脚本要 import comfy
// （我们复用 ComfyUI 自带的 Stable Zero123 节点实现，而不是自己重写推理）。
const ZERO123 = {
  python: 'D:\\dsh-data\\ComfyUI_windows_portable\\python_embeded\\python.exe',
  script: 'D:\\dsh-data\\dsh-triposr\\zero123-views-cli.py',
  ckpt: 'D:\\dsh-data\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints\\stable_zero123.ckpt',
  weightsDir: 'D:\\dsh-data\\dsh-triposr\\weights',
}

// Hunyuan3D-2：单图直接生成精细 3D（三维原生生成，不是逐视角重画）。
// 同样必须用 ComfyUI 的嵌入式 Python —— 复用的是它自带的 Hunyuan3D DiT / ShapeVAE
// 和 DINOv2-giant 编码器，没有自己实现推理。
const HUNYUAN = {
  python: 'D:\\dsh-data\\ComfyUI_windows_portable\\python_embeded\\python.exe',
  script: 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-run.py',
  // 多视图版是**同一个脚本结构的另一个入口**：只换 DiT 权重 + 条件构造方式
  scriptMv: 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-mv-run.py',
  dir: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full',
  ditMv: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full\\dit-mv-fp16.safetensors',
}

// ComfyUI 根目录：环境探测要在这里看它带了哪些 3D 节点（它是我们复用推理实现的宿主）
const COMFY_ROOT = 'D:\\dsh-data\\ComfyUI_windows_portable\\ComfyUI'

// 多线程下载器（一键安装用）。只用标准库 urllib，所以任意 python 都能跑；
// 用 TripoSR 那个独立环境是因为它一定在。
const DOWNLOADER = {
  python: 'D:\\dsh-data\\dsh-triposr\\python311\\python.exe',
  script: 'D:\\dsh-data\\dsh-triposr\\fastdl.py',
}

/** 交给 ai-models.js 的路径配置（provider 可用性检测 + 环境探测都用它） */
function providerPaths() {
  return {
    triposr: TRIPOSR,
    zero123: ZERO123,
    hunyuan: HUNYUAN,
    comfyRoot: COMFY_ROOT,
  }
}

function runProcess(exe, args, { cwd, env, onLine, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      reject(e)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    // 进度条节流：tqdm 和下载器的进度都是 \r 原地刷新的，20 分钟的下载会刷出上千行。
    // 全丢会让用户完全看不到进度，全收又会把真正的日志挤掉 —— 所以每 10 秒放一行过去，
    // 并且标成 isProgress，调用方可以只把它记进 lines、不拿它当"当前步骤"。
    const PROGRESS_RE = /^\s*\d{1,3}(?:\.\d+)?%\s*[|\s]/
    let lastProgressAt = 0
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 尽力而为 */ }
      finish(reject, new Error(`子进程超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    const feed = (chunk, sink) => {
      const s = chunk.toString('utf8')
      sink(s)
      if (onLine) {
        // ⚠ 必须把单独的 \r 也当换行。下载器（fastdl.py）和 tqdm 都用 \r 原地刷新、
        // 不输出 \n，只按 \n 切的话整段进度会攒成**一个几十 KB 的巨行**，
        // 一路进 job.step，UI 上就是一坨糊掉的百分比。
        for (const l of s.split(/\r\n|\r|\n/)) {
          const t = l.trim()
          if (!t) continue
          const isProgress = PROGRESS_RE.test(t)
          if (isProgress) {
            const now = Date.now()
            if (now - lastProgressAt < 10000) continue
            lastProgressAt = now
          }
          onLine(t, isProgress)
        }
      }
    }
    child.stdout.on('data', (d) => feed(d, (s) => { stdout += s }))
    child.stderr.on('data', (d) => feed(d, (s) => { stderr += s }))
    child.on('error', (e) => finish(reject, e))
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
  })
}

// 任务表：面板轮询用。跑一张图约 1 分钟，同步 HTTP 会超时，所以改成"提交 → 轮询"。
const jobs = new Map()
const JOB_TTL_MS = 30 * 60 * 1000

// AI 任务互斥：单图 / 多图 / Zero123 / Hunyuan3D 四个端点都要加载模型进 GPU，
// 而本机 8 GB 显存同一时刻只够一个模型（Hunyuan3D 的 DiT+VAE+编码器就要 ~5 GB）。
// 不拦的话，用户快速点两下（或切模式再点）就会起两个 Python 进程、两次加载模型，
// CUDA OOM 严重时能带崩显示驱动。所以提交端加一道闸，一个任务跑完才放行下一个。
let aiBusy = false

function tryAcquireAi(res) {
  if (aiBusy) {
    sendJson(res, 429, { ok: false, error: '已有 AI 任务在跑（GPU 同一时刻只够一个模型），等它完成再提交' })
    return false
  }
  aiBusy = true
  return true
}

function newJob() {
  const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const job = { id, state: 'running', step: '排队', lines: [], result: null, error: null, started: Date.now() }
  jobs.set(id, job)
  for (const [k, v] of jobs) if (Date.now() - v.started > JOB_TTL_MS) jobs.delete(k)
  return job
}

function jobNote(job, step, line) {
  job.step = step
  if (line) {
    job.lines.push(line)
    if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200)
  }
}

/** 只往 lines 里塞一行，不动"当前步骤"（给进度条心跳用，别让百分比盖掉步骤名） */
function jobLine(job, line) {
  jobNote(job, job.step, line)
}

/** 图 → GLB → 原始数组。返回的形态与面板现有的 mesh 对象一致。 */
async function runTripoSR(imageBuffer, opts, job) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modeler-'))
  try {
    const imgPath = path.join(tmp, 'input.png')
    const outDir = path.join(tmp, 'out')
    fs.writeFileSync(imgPath, imageBuffer)
    fs.mkdirSync(path.join(outDir, '0'), { recursive: true })

    jobNote(job, '推理中（GPU）', `输入 ${(imageBuffer.length / 1024).toFixed(0)} KB`)

    const r = await runProcess(
      TRIPOSR.python,
      [
        'run.py', imgPath,
        '--pretrained-model-name-or-path', TRIPOSR.weights,
        '--output-dir', outDir,
        '--no-remove-bg',
        '--chunk-size', String(opts.chunkSize || 200),
        '--mc-resolution', String(opts.mcResolution || 192),
        '--model-save-format', 'glb',
      ],
      {
        cwd: TRIPOSR.cwd,
        env: { PYTHONIOENCODING: 'utf-8', DINO_CONFIG_PATH: TRIPOSR.dinoConfig },
        onLine: (l) => jobNote(job, '推理中（GPU）', l),
      },
    )
    if (r.code !== 0) {
      throw new Error(`TripoSR 退出码 ${r.code}\n${(r.stderr || r.stdout).slice(-2000)}`)
    }

    const glbPath = path.join(outDir, '0', 'mesh.glb')
    if (!fs.existsSync(glbPath)) throw new Error(`没有产出 ${glbPath}`)
    jobNote(job, '读取网格', `GLB ${(fs.statSync(glbPath).size / 1024).toFixed(0)} KB`)

    // 复用 TripoSR 那边已经验证过的 glb-to-json.py，免得在 host 里再写一个 GLB 解析器。
    const jsonPath = path.join(tmp, 'mesh.json')
    const r2 = await runProcess(TRIPOSR.python, [TRIPOSR.glbToJson, glbPath, jsonPath], {
      cwd: TRIPOSR.cwd,
      env: { PYTHONIOENCODING: 'utf-8' },
      onLine: (l) => jobNote(job, '读取网格', l),
    })
    if (r2.code !== 0) throw new Error(`glb-to-json 退出码 ${r2.code}\n${(r2.stderr || '').slice(-2000)}`)

    const mesh = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    jobNote(job, '完成', `${mesh.vertexCount} 顶点 / ${mesh.triangleCount} 三角形`)
    return mesh
  } finally {
    // 中间产物跑完就清（失败也清），别在 temp 里攒垃圾
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'

  try {
    // ---- 只读端点：建模 AI 清单 + 本地环境探测 ----
    // 面板启动时拉一次，用来渲染"模型选择器"（哪些能跑、哪些没装）。
    if ((sub === '/providers' || sub === '/providers/') && req.method === 'GET') {
      sendJson(res, 200, { ok: true, providers: describeProviders(providerPaths()) })
      return
    }
    if ((sub === '/environment' || sub === '/environment/') && req.method === 'GET') {
      const env = await probeEnvironment(providerPaths())
      const provs = describeProviders(providerPaths())
      sendJson(res, 200, {
        ok: true,
        environment: env,
        recommendations: recommend(env, provs),
        plans: listInstallPlans(),
      })
      return
    }

    // 一键安装：按安装方案把权重下到目标目录。
    // 唯一的副作用就是往那个目录写方案里列出的文件；用现成的 32 线程下载器
    // （它对 ModelScope 的单连接限速有实测优势，而且分段临时文件支持续传）。
    if ((sub === '/install' || sub === '/install/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const id = String(body.provider || '')
      const plan = INSTALL_PLANS[id]
      if (!plan) {
        sendJson(res, 400, { ok: false, error: id ? `没有 ${id} 的安装方案` : '缺少 provider' })
        return
      }
      const dir = String(body.dir || plan.dir || '')
      if (!dir) { sendJson(res, 400, { ok: false, error: '没有目标目录' }); return }
      if (!tryAcquireAi(res)) return

      const files = plan.files
      const totalBytes = files.reduce((s, f) => s + (f.bytes || 0), 0)
      const job = newJob()
      jobNote(job, '准备下载', `${plan.label} · ${files.length} 个文件 / ${(totalBytes / 1024 ** 3).toFixed(2)} GiB → ${dir}`)
      ;(async () => {
        fs.mkdirSync(dir, { recursive: true })
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const dest = path.join(dir, f.name)
          const want = f.bytes || 0
          // 已经下好且字节数完全一致就跳过（重跑安装不会白下几 GB）。
          // ⚠ 必须按**字节**比：之前按 MB 估值算，估值和实际差了 200 MB，
          // 结果每次都会把已经完整的文件重下一遍。
          try {
            if (want > 0 && fs.statSync(dest).size === want) {
              jobNote(job, `第 ${i + 1}/${files.length} 个`, `${f.name} 已存在且字节数吻合，跳过`)
              continue
            }
          } catch { /* 不存在或读不到，继续下载 */ }

          jobNote(job, `下载 ${i + 1}/${files.length}：${f.label}`,
            `${(want / 1024 ** 3).toFixed(2)} GiB → ${dest}`)
          const r = await runProcess(DOWNLOADER.python, [DOWNLOADER.script, f.url, dest, '32'], {
            cwd: path.dirname(DOWNLOADER.script),
            env: { PYTHONIOENCODING: 'utf-8' },
            onLine: (l, isProgress) => (
              isProgress
                ? jobLine(job, l)
                : jobNote(job, `下载 ${i + 1}/${files.length}：${f.label}`, l)
            ),
            // 单个文件给 3 小时：实测 32 线程约 5.8 MB/s，4.59 GiB 的 DiT 要 13 分钟；
            // 留足余量给网络抖动（限速到 2 MB/s 时也要 40 分钟）。
            timeoutMs: 180 * 60 * 1000,
          })
          if (r.code !== 0) {
            throw new Error(`${f.name} 下载失败（退出码 ${r.code}）\n${(r.stderr || r.stdout).slice(-1500)}`)
          }
        }
        const me = describeProviders(providerPaths()).find((p) => p.id === id)
        const ok = !!(me && me.available)
        jobNote(job, '完成', ok ? '权重就位，可以用了' : `仍有缺项：${(me && me.missing || []).join(' / ')}`)
        job.state = 'done'
        job.result = { installed: id, available: ok, missing: (me && me.missing) || [] }
      })().catch((e) => {
        job.state = 'error'
        job.error = String(e && e.message ? e.message : e)
      }).finally(() => { aiBusy = false })

      hostDebug(`提交安装任务 ${job.id}（${id}）`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // 导出到本机指定目录。
    // 面板的"选择目录"拿到的是一个绝对路径，写盘这一步交给 host ——
    // 浏览器那边没有随便写盘的能力（除非用 File System Access API，那条路是另一分支）。
    // ⚠ 只写"用户明确给的那个目录 + 净化过的文件名"，扩展名由 format 决定（不认客户端传的 ext），
    //   重名不覆盖（走 uniquePath），免得把人家已有的文件悄悄盖掉。
    if ((sub === '/export' || sub === '/export/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const dirArg = String(body.dir || '').trim()
      if (!dirArg) { sendJson(res, 400, { ok: false, error: '缺少 dir（必须是绝对路径）' }); return }
      if (!path.isAbsolute(dirArg)) { sendJson(res, 400, { ok: false, error: `dir 必须是绝对路径：${dirArg}` }); return }
      const dir = path.resolve(dirArg)
      try {
        const stt = fs.existsSync(dir) ? fs.statSync(dir) : null
        if (stt && !stt.isDirectory()) { sendJson(res, 400, { ok: false, error: `不是目录：${dir}` }); return }
        if (!stt) fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `目录不可用：${e.message}` })
        return
      }

      const format = String(body.format || '').toLowerCase()
      const ext = EXPORT_EXTS[format]
      if (!ext) {
        sendJson(res, 400, { ok: false, error: `不支持的格式 "${format}"，可用 ${Object.keys(EXPORT_EXTS).join(' / ')}` })
        return
      }
      const base = sanitize(body.name) || 'model'
      const b64 = String(body.dataBase64 || '')
      if (!b64) { sendJson(res, 400, { ok: false, error: '缺少 dataBase64' }); return }
      let data
      try {
        data = Buffer.from(b64, 'base64')
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `dataBase64 解不开：${e.message}` })
        return
      }
      if (!data.length) { sendJson(res, 400, { ok: false, error: '数据是空的，没有写出文件' }); return }

      // 落盘前先**读一遍**：解析不了、或者内容与声称的格式对不上，就不写。
      // 代价是几十毫秒（GLB/JSON 都是轻量扫描），换来的是"写到磁盘上的文件一定能用" ——
      // 传输被截断、编码搞错这类问题会在这里当场暴露，而不是等用户拿去 Blender 才发现是坏的。
      let detected
      try {
        detected = parseMesh(data).format
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `数据不是有效的网格文件（按 ${format} 校验）：${e.message}` })
        return
      }
      if (!EXPORT_DETECTED[format].includes(detected)) {
        sendJson(res, 400, {
          ok: false,
          error: `内容与格式不符：声称 ${format}，但内容是 ${detected}`,
        })
        return
      }
      try {
        const file = uniquePath(dir, base, ext)
        fs.writeFileSync(file, data)
        hostDebug(`导出 ${format} → ${file}（${data.length} 字节）`)
        sendJson(res, 200, { ok: true, file, bytes: data.length, format })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `写文件失败：${e.message}` })
      }
      return
    }

    // 提交一个"单图 → 3D"任务，立刻返回 jobId（跑完约 1 分钟，不能同步等）
    if ((sub === '/single' || sub === '/single/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const b64 = String(body.imageBase64 || '')
      if (!b64) {
        sendJson(res, 400, { ok: false, error: '缺少 imageBase64' })
        return
      }
      const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      if (buf.length < 64) {
        sendJson(res, 400, { ok: false, error: `图片数据太小（${buf.length} 字节）` })
        return
      }

      if (!tryAcquireAi(res)) return

      const job = newJob()
      jobNote(job, '排队', `收到 ${(buf.length / 1024).toFixed(0)} KB`)
      // 故意不 await：立刻把 jobId 还给面板，让它可以轮询进度
      runTripoSR(buf, { mcResolution: body.mcResolution, chunkSize: body.chunkSize }, job)
        .then((mesh) => { job.state = 'done'; job.result = mesh })
        .catch((e) => { job.state = 'error'; job.error = String(e && e.message ? e.message : e) })
        .finally(() => { aiBusy = false })
      hostDebug(`提交任务 ${job.id}（${(buf.length / 1024).toFixed(0)} KB）`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // 三视图 → AI：每张图各跑一次 TripoSR，返回多个 mesh 交给面板去融合。
    //
    // 为什么融合不放在 host：TripoSR 是单图模型（它接受多图只是"每张各跑一遍"，
    // 不做联合推理），这里没有可借力的联合建模；而融合本质是体素投票，放面板侧
    // 能让用户实时看到进度、也能自己调阈值。
    if ((sub === '/multi' || sub === '/multi/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const list = Array.isArray(body.images) ? body.images : []
      if (!list.length) { sendJson(res, 400, { ok: false, error: '缺少 images 数组' }); return }
      if (list.length > 6) { sendJson(res, 400, { ok: false, error: '最多 6 张' }); return }

      if (!tryAcquireAi(res)) return

      const job = newJob()
      jobNote(job, '排队', `收到 ${list.length} 张图`)
      ;(async () => {
        const meshes = []
        for (let i = 0; i < list.length; i++) {
          const tag = ['前', '侧', '俯', '后'][i] || `第${i + 1}`
          jobNote(job, `第 ${i + 1}/${list.length} 张（${tag}）`, '开始推理')
          const buf = Buffer.from(String(list[i]).replace(/^data:image\/\w+;base64,/, ''), 'base64')
          const mesh = await runTripoSR(
            buf,
            { mcResolution: body.mcResolution, chunkSize: body.chunkSize },
            job,
          )
          meshes.push(mesh)
          jobNote(job, `第 ${i + 1}/${list.length} 张（${tag}）`, `完成：${mesh.vertexCount} 顶点`)
        }
        job.state = 'done'
        job.result = { meshes }
      })().catch((e) => {
        job.state = 'error'
        job.error = String(e && e.message ? e.message : e)
      }).finally(() => { aiBusy = false })

      hostDebug(`提交多图任务 ${job.id}（${list.length} 张）`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // Zero123 多视角：一张图 → 三个正交视角图，再交给面板做视觉外壳。
    //
    // 为什么只返回"图"而不是直接返回网格：面板已经有完整的剪影 + 雕刻链路
    // （三视图那条），返回图就能直接复用，而且用户还能调分辨率/平滑重新雕。
    if ((sub === '/zero123' || sub === '/zero123/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const b64 = String(body.imageBase64 || '')
      if (!b64) { sendJson(res, 400, { ok: false, error: '缺少 imageBase64' }); return }
      const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      if (buf.length < 64) { sendJson(res, 400, { ok: false, error: `图片太小（${buf.length} 字节）` }); return }

      if (!tryAcquireAi(res)) return

      const job = newJob()
      jobNote(job, '排队', `收到 ${(buf.length / 1024).toFixed(0)} KB`)
      ;(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zero123-'))
        try {
          const imgPath = path.join(tmp, 'input.png')
          fs.writeFileSync(imgPath, buf)
          const outDir = path.join(tmp, 'out')
          fs.mkdirSync(outDir, { recursive: true })

          jobNote(job, 'Zero123 生成多视角（约 40s）', '启动')
          const r = await runProcess(
            ZERO123.python,
            [
              ZERO123.script, '--image', imgPath, '--out', outDir,
              '--steps', String(body.steps || 24), '--size', String(body.size || 256),
            ],
            {
              cwd: path.dirname(ZERO123.script),
              env: {
                PYTHONIOENCODING: 'utf-8',
                // 跑完是否主动卸载模型 + 清空显存缓存（面板上的「自动卸载模型」开关）。
                // 三个模型都是独立进程，退出本来就会还显存；这一步是**额外**再显式清一次，
                // 好处是确定、也更早 —— 8G 卡上和别的任务抢显存时尤其有用。
                ...(body.freeAfter === false ? {} : { HY3D_FREE_AFTER: '1' }),
              },
              onLine: (l) => jobNote(job, 'Zero123 生成多视角', l),
              timeoutMs: 10 * 60 * 1000,
            },
          )
          if (r.code !== 0) {
            throw new Error(`Zero123 退出码 ${r.code}\n${(r.stderr || r.stdout).slice(-2000)}`)
          }

          const views = {}
          for (const k of ['front', 'side', 'top']) {
            const p = path.join(outDir, `${k}.png`)
            if (!fs.existsSync(p)) throw new Error(`没有产出 ${k}.png`)
            views[k] = fs.readFileSync(p).toString('base64')
            jobNote(job, '读取视角', `${k}.png ${(fs.statSync(p).size / 1024).toFixed(0)} KB`)
          }
          job.state = 'done'
          job.result = { views }
        } finally {
          try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      })().catch((e) => {
        job.state = 'error'
        job.error = String(e && e.message ? e.message : e)
      }).finally(() => { aiBusy = false })

      hostDebug(`提交 Zero123 任务 ${job.id}`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // Hunyuan3D-2：一张图 → 精细 3D 网格（直接返回 mesh，不像 Zero123 还要再雕刻）。
    //
    // 与 Zero123 那条路的区别：这个模型**在三维空间里直接生成**（DiT 出 3D latent，
    // VAE 解成体素），所以不存在"各视角互相矛盾"，几何细节也高一个数量级
    // （实测 19 万顶点 / 52 万三角形，而 Zero123+外壳只有 5 万顶点）。
    // 代价是慢（约 130 秒）且没有颜色。
    if ((sub === '/hunyuan' || sub === '/hunyuan/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const b64 = String(body.imageBase64 || '')
      if (!b64) { sendJson(res, 400, { ok: false, error: '缺少 imageBase64' }); return }
      const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      if (buf.length < 64) { sendJson(res, 400, { ok: false, error: `图片太小（${buf.length} 字节）` }); return }

      if (!tryAcquireAi(res)) return

      const job = newJob()
      jobNote(job, '排队', `收到 ${(buf.length / 1024).toFixed(0)} KB`)
      ;(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hunyuan-'))
        try {
          const imgPath = path.join(tmp, 'input.png')
          fs.writeFileSync(imgPath, buf)
          const jsonPath = path.join(tmp, 'mesh.json')

          jobNote(job, 'Hunyuan3D 生成中（约 130s）', '启动')
          const r = await runProcess(HUNYUAN.python, [HUNYUAN.script], {
            cwd: path.dirname(HUNYUAN.script),
            env: {
              PYTHONIOENCODING: 'utf-8',
              HY3D_IMG: imgPath,
              HY3D_JSON: jsonPath,
              HY3D_OUT: tmp,
              ...(body.steps ? { HY3D_STEPS: String(body.steps) } : {}),
              ...(body.octree ? { HY3D_OCTREE: String(body.octree) } : {}),
              // 同 Zero123：跑完主动卸载模型 + 清显存缓存（「自动卸载模型」开关）
              ...(body.freeAfter === false ? {} : { HY3D_FREE_AFTER: '1' }),
            },
            onLine: (l) => jobNote(job, 'Hunyuan3D 生成中', l),
            timeoutMs: 20 * 60 * 1000,
          })
          if (r.code !== 0) {
            throw new Error(`Hunyuan3D 退出码 ${r.code}\n${(r.stderr || r.stdout).slice(-2000)}`)
          }
          if (!fs.existsSync(jsonPath)) throw new Error('没有产出 mesh.json')

          const mesh = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
          jobNote(job, '完成', `${mesh.vertexCount} 顶点 / ${mesh.triangleCount} 三角形`)
          job.state = 'done'
          job.result = { mesh }
        } finally {
          try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      })().catch((e) => {
        job.state = 'error'
        job.error = String(e && e.message ? e.message : e)
      }).finally(() => { aiBusy = false })

      hostDebug(`提交 Hunyuan3D 任务 ${job.id}`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // Hunyuan3D-2mv（多视图）：前/左/后(/右) 一起推理 → 精细 3D 网格。
    //
    // 与单图版的差别**只在条件构造**：模型结构完全一样（实测两者 safetensors 的
    // 张量表逐项相同：1649 个张量、零形状差异），多视图是把 N 路图像 token 拼成一条
    // 条件序列，并给每路加上"第几个视角"的正弦位置编码再交给 DiT。
    // 好处很实际：单图重建的背面全靠先验猜，多视图能把它钉住。
    //
    // ⚠ 视角名只有 front/left/back/right（绕物体一圈的方位角视角），**没有 top**。
    //   工程三视图里的俯视图喂不进来 —— 这是模型设定，不是我们没做。
    if ((sub === '/hunyuan-mv' || sub === '/hunyuan-mv/') && req.method === 'POST') {
      const body = await readJsonBody(req)
      const src = (body.images && typeof body.images === 'object') ? body.images : {}
      const VIEWS = ['front', 'left', 'back', 'right']
      const bufs = {}
      for (const k of VIEWS) {
        const raw = String(src[k] || '')
        if (!raw) continue
        const b = Buffer.from(raw.replace(/^data:image\/\w+;base64,/, ''), 'base64')
        if (b.length < 64) {
          sendJson(res, 400, { ok: false, error: `${k} 图太小（${b.length} 字节），多半不是图片` })
          return
        }
        bufs[k] = b
      }
      const given = Object.keys(bufs)
      if (!given.length) {
        sendJson(res, 400, { ok: false, error: '至少要给一个视角（front / left / back / right）' })
        return
      }

      if (!tryAcquireAi(res)) return

      const job = newJob()
      jobNote(job, '排队', `收到 ${given.length} 个视角：${given.join(' / ')}`)
      ;(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hunyuan-mv-'))
        try {
          const env = {
            PYTHONIOENCODING: 'utf-8',
            HY3D_JSON: path.join(tmp, 'mesh.json'),
            HY3D_OUT: tmp,
            ...(body.steps ? { HY3D_STEPS: String(body.steps) } : {}),
            ...(body.octree ? { HY3D_OCTREE: String(body.octree) } : {}),
            ...(body.freeAfter === false ? {} : { HY3D_FREE_AFTER: '1' }),
          }
          for (const k of given) {
            const p = path.join(tmp, `${k}.png`)
            fs.writeFileSync(p, bufs[k])
            env[`HY3D_MV_${k.toUpperCase()}`] = p
          }

          jobNote(job, 'Hunyuan3D-2mv 生成中（约 130s）',
            `视角 ${given.join(' / ')}（模型没有"俯视"槽，前/左/后是绕物体一圈的方位角视角）`)
          const r = await runProcess(HUNYUAN.python, [HUNYUAN.scriptMv], {
            cwd: path.dirname(HUNYUAN.scriptMv),
            env,
            onLine: (l) => jobNote(job, 'Hunyuan3D-2mv 生成中', l),
            timeoutMs: 20 * 60 * 1000,
          })
          if (r.code !== 0) {
            throw new Error(`Hunyuan3D-2mv 退出码 ${r.code}\n${(r.stderr || r.stdout).slice(-2000)}`)
          }
          if (!fs.existsSync(env.HY3D_JSON)) throw new Error('没有产出 mesh.json')

          const mesh = JSON.parse(fs.readFileSync(env.HY3D_JSON, 'utf8'))
          jobNote(job, '完成', `${mesh.vertexCount} 顶点 / ${mesh.triangleCount} 三角形（视角 ${(mesh.views || given).join('/')}）`)
          job.state = 'done'
          job.result = { mesh }
        } finally {
          try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      })().catch((e) => {
        job.state = 'error'
        job.error = String(e && e.message ? e.message : e)
      }).finally(() => { aiBusy = false })

      hostDebug(`提交 Hunyuan3D-2mv 任务 ${job.id}`)
      sendJson(res, 200, { ok: true, jobId: job.id })
      return
    }

    // 轮询任务状态
    if (sub === '/job' || sub === '/job/') {
      const id = url.searchParams.get('id') || ''
      const job = jobs.get(id)
      if (!job) {
        sendJson(res, 404, { ok: false, error: `没有任务 ${id}` })
        return
      }
      sendJson(res, 200, {
        ok: true,
        id: job.id,
        state: job.state,
        step: job.step,
        lines: job.lines.slice(-40),
        error: job.error,
        result: job.state === 'done' ? job.result : null,
      })
      return
    }

    if (sub === '/ping' || sub === '/ping/') {
      sendJson(res, 200, {
        ok: true,
        pong: true,
        plugin: 'dsh-modeler',
        node: process.version,
        time: new Date().toISOString(),
        // 顺便让 host 报一下 TripoSR 环境在不在 —— 第 1 步就是先确认这条链路能通，
        // 以及 host 进程确实能读到那些本机路径。
        triposr: {
          python: fs.existsSync('D:\\dsh-data\\dsh-triposr\\python311\\python.exe'),
          runner: fs.existsSync('D:\\dsh-data\\dsh-triposr\\run-triposr.ps1'),
          ckpt: fs.existsSync('D:\\dsh-data\\dsh-triposr\\weights\\model.ckpt'),
        },
      })
      return
    }

    sendJson(res, 404, { ok: false, error: `未知端点 ${sub}` })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
}

export function apply(ctx, config = {}) {
  state.logger = ctx && ctx.logger ? ctx.logger : null
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined && config[key] !== null) cfg[key] = config[key]
    }
  }

  const disposers = []
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(saveTool))
    disposers.push(ctx.tools.register(loadTool))
    disposers.push(ctx.tools.register(viewsTool))
    log('已注册 3 个工具：modeler_save / modeler_load / modeler_views')
  }

  // HTTP 路由：浏览器面板靠它调 host。（webServer 已写进 inject，见文件上方注释）
  hostDebug(`apply 开始；ctx.webServer = ${ctx && ctx.webServer ? '有' : '无'}`)
  const webServer = (ctx && ctx.webServer) || (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  hostDebug(`webServer 解析结果 = ${webServer ? `有（register=${typeof webServer.register}）` : '空/undefined'}`)
  if (webServer && typeof webServer.register === 'function') {
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: handleApi,
      }))
      hostDebug(`路由注册成功 ${ROUTE_PREFIX}`)
    } catch (e) {
      hostDebug(`路由注册抛异常：${e && e.stack ? e.stack : e}`)
    }
  } else {
    hostDebug('webServer 仍不可用，跳过路由注册')
  }

  return () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch { /* 忽略 */ }
    }
  }
}

export { DEFAULTS }
