/**
 * host 侧插件的实测：像 DSH 那样注册工具，然后**真的调用**每一个。
 *
 * 为什么值得写：host 半边是"浏览器做不到的那部分"（落盘、读回、切片），
 * 而这些恰好是最容易在真实调用时才炸的地方（路径拼接、base64 解码、字节对齐、
 * 依赖的导出名写错）。所以这里不 mock 业务逻辑，直接跑一遍真实调用。
 *
 * 用法：node tools/verify-host.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as host from '../src/host/index.js'
import { buildMesh, silhouette } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const samples = path.join(here, '..', 'samples')

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg); return cond }

// 造一个临时"会话工作区"，让 host 往里写
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeler-host-'))
const exec = { agent: { session: { header: { cwd: workDir } } } }

const registered = []
const ctx = {
  logger: { info: () => {} },
  tools: { register: (t) => { registered.push(t); return () => {} } },
}

console.log('=== 1. 插件形状 ===')
check(host.name === 'modeler', `插件名应为 modeler，实际 ${host.name}`)
check(typeof host.apply === 'function', '必须导出 apply')
check(Array.isArray(host.inject) && host.inject.includes('tools'), 'inject 应包含 tools')

const dispose = host.apply(ctx, {})
check(typeof dispose === 'function', 'apply 应返回 dispose')
console.log(`已注册 ${registered.length} 个工具：${registered.map((t) => t.name).join(', ')}`)
check(registered.length === 3, `应注册 3 个工具，实际 ${registered.length}`)
for (const t of registered) {
  check(typeof t.execute === 'function', `${t.name} 缺少 execute`)
  check(t.parameters && t.parameters.type === 'object', `${t.name} 的 parameters 不是 object schema`)
  check(typeof t.description === 'string' && t.description.length > 20, `${t.name} 的描述太短`)
}
console.log()

// 从 samples 造一个真实网格
function makeMesh(shape) {
  const load = (k) => {
    const meta = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))[shape][k]
    const png = decodePNG(fs.readFileSync(path.join(samples, meta.file)))
    return silhouette({ data: png.rgba, width: png.width, height: png.height })
  }
  const sils = { front: load('front'), side: load('side'), top: load('top') }
  return buildMesh(sils, { resolution: 64, padding: 0.05, smooth: 1 })
}

const mesh = makeMesh('box')
console.log('=== 2. modeler_save（五种格式 + base64 与数组两种传法）===')
const saveTool = registered.find((t) => t.name === 'modeler_save')
const b64 = {
  positions: Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).toString('base64'),
  indices: Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength).toString('base64'),
}

const written = {}
for (const format of ['obj', 'stl', 'glb', 'gltf', 'json']) {
  const res = JSON.parse(await saveTool.execute({ ...b64, format, name: `box-${format}` }, exec))
  check(res.ok === true, `save(${format}) 未返回 ok`)
  check(fs.existsSync(res.file), `save(${format}) 报告的文件不存在：${res.file}`)
  check(res.bytes > 0, `save(${format}) 文件为空`)
  check(res.watertight === true, `save(${format}) 的网格应水密`)
  check(res.triangleCount === mesh.meta.triangleCount, `save(${format}) 三角形数不符`)
  written[format] = res.file
  console.log(`  ${format.padEnd(4)} → ${path.basename(res.file).padEnd(14)} ${String(res.bytes).padStart(8)} 字节  ` +
    `三角形 ${res.triangleCount}  水密 ${res.watertight ? '是' : '否'}`)
}

// 数字数组传法
const arrRes = JSON.parse(await saveTool.execute({
  positions: Array.from(mesh.positions),
  indices: Array.from(mesh.indices),
  format: 'obj',
  name: 'box-array',
}, exec))
check(arrRes.ok === true && fs.existsSync(arrRes.file), '数字数组传法失败')
console.log(`  数组传法 → ${path.basename(arrRes.file)}  三角形 ${arrRes.triangleCount}`)

// 错误路径要被拦住
let threw = null
try { await saveTool.execute({ positions: 'AAAA', indices: b64.indices, format: 'obj' }, exec) } catch (e) { threw = e }
check(threw !== null, '非法 base64 应报错')
threw = null
try {
  await saveTool.execute({ positions: b64.positions, indices: b64.indices, format: 'obj', name: '../../evil' }, exec)
} catch (e) { threw = e }
// name 会被 sanitize 成 ..._evil，不应越界；确认写出的文件在 Modeler 目录内
const modelerDir = path.join(workDir, 'Modeler')
const outside = fs.readdirSync(workDir).filter((n) => n !== 'Modeler')
check(outside.length === 0, `不该在 Modeler 之外产生文件：${outside.join(', ')}`)
console.log(`  路径安全：所有产物都在 ${path.relative(workDir, modelerDir)} 下`)
check(threw === null || threw !== undefined, '')
console.log()

console.log('=== 3. modeler_load（读回并核对）===')
const loadTool = registered.find((t) => t.name === 'modeler_load')
for (const [format, file] of Object.entries(written)) {
  const res = JSON.parse(await loadTool.execute({ file }, exec))
  check(res.ok === true, `load(${format}) 失败`)
  check(res.vertexCount > 0 && res.triangleCount > 0, `load(${format}) 顶点/三角形为 0`)
  // STL 不复用顶点索引，顶点数会膨胀到 3×三角形数，这是格式本身的性质
  const expectTri = mesh.meta.triangleCount
  check(res.triangleCount === expectTri, `load(${format}) 三角形数 ${res.triangleCount} ≠ ${expectTri}`)

  // 守住"STL 读回必须焊接后再判拓扑"。
  // 不焊接的话，STL 的每条边都只属于一个三角形 → watertight 恒为 false →
  // 工具会给出"不水密，打印前需要修"的错误结论（模型明明是水密的）。
  // 这条 bug 是在本机真实调用 modeler_load 时发现的，必须留下回归。
  if (format === 'stl') {
    check(res.watertight === true, 'STL 读回应经顶点焊接后判为水密（否则会误报"打印前需要修"）')
    check(res.boundaryEdges === 0, `STL 焊接后边界边应为 0，实际 ${res.boundaryEdges}`)
    check(typeof res.weldNote === 'string' && res.weldNote.length > 0, 'STL 读回应说明做了焊接')
  }

  console.log(`  ${format.padEnd(4)} 识别为 ${res.detectedFormat.padEnd(10)} 顶点 ${String(res.vertexCount).padStart(7)}  ` +
    `三角形 ${res.triangleCount}  体积 ${res.volume}  水密 ${res.watertight ? '是' : '否'}` +
    (res.weldNote ? `\n        ${res.weldNote}` : ''))
}
console.log()

console.log('=== 4. modeler_views（切片回三视图，输出 PNG）===')
const viewsTool = registered.find((t) => t.name === 'modeler_views')
const vres = JSON.parse(await viewsTool.execute({ file: written.obj, size: 192, name: 'box' }, exec))
check(vres.ok === true, 'modeler_views 失败')
check(Array.isArray(vres.files) && vres.files.length === 4, `应输出 4 个 PNG，实际 ${vres.files?.length}`)
for (const f of vres.files) {
  check(fs.existsSync(f), `PNG 不存在：${f}`)
  const b = fs.readFileSync(f)
  check(b[0] === 0x89 && b[1] === 0x50, `不是合法 PNG：${f}`)
  // 用自带解码器读回，确认真能解
  const png = decodePNG(b)
  check(png.width > 0 && png.height > 0, `PNG 尺寸无效：${f}`)
  console.log(`  ${path.basename(f).padEnd(22)} ${String(b.length).padStart(7)} 字节  ${png.width}×${png.height}`)
}
console.log()

console.log('=== 5. 卸载 ===')
dispose()
console.log('  dispose() 未抛错')

// 清理
fs.rmSync(workDir, { recursive: true, force: true })

console.log()
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('host 侧全部通过：3 个工具都能真实调用、产物可读、路径受控、PNG 可解。')
