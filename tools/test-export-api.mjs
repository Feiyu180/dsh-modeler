/**
 * `POST /export`（导出到本机指定目录）的端点测试。
 *
 * 为什么值得单独测：这个端点**按客户端给的路径写文件**，是整个插件里唯一"能写到工作区之外"
 * 的入口。所以除了happy path，重点是把不该放行的都试一遍：相对路径、指向文件的路径、
 * 不认识的格式、空数据、以及重名时会不会把已有文件盖掉。
 *
 * 做法和 tools/host-harness.mjs 一样：伪造一个 ctx 把真正的 handleApi 抢出来，
 * 用本地 http server 打真实请求（不依赖 DSH，也不用等重启）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/host/index.js'
import { toGLTF, toOBJ, toMeshJSON } from '../src/core/geometry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tmp = path.join(root, '.tmp-export-api')

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

let handler = null
apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  webServer: { register: (r) => { handler = r.handler; return () => {} } },
}, {})
assert.equal(typeof handler, 'function', '没拿到 handleApi')

const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => {}) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/dsh-modeler/api`

const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

// 夹具：一个真实的小网格，导出成 gltf（文本）和 obj，再按 base64 传回去
const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
const idx = new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
const gltfText = toGLTF(pos, idx, 'unit')
const objText = toOBJ(pos, idx, 'unit')
const jsonText = toMeshJSON(pos, idx, { name: 'unit' })
const jsonB64 = Buffer.from(jsonText, 'utf8').toString('base64')

try {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  // 1. happy path：内容必须逐字节落盘
  const b64 = Buffer.from(gltfText, 'utf8').toString('base64')
  let r = await post('/export', { dir: tmp, name: 'unit', format: 'gltf', dataBase64: b64 })
  check(r.status === 200 && r.json.ok === true, `正常导出失败：${JSON.stringify(r.json)}`)
  check(r.json.file === path.join(tmp, 'unit.gltf'), `落盘路径不对：${r.json.file}`)
  check(fs.readFileSync(r.json.file, 'utf8') === gltfText, '写出的内容与源不一致（不是逐字节）')
  check(r.json.bytes === Buffer.byteLength(gltfText), `字节数不符：${r.json.bytes}`)
  console.log(`  gltf → ${path.basename(r.json.file)}  ${r.json.bytes} 字节  内容逐字节一致`)

  // 2. 重名不能覆盖：第二次应落成 unit_002.gltf，且第一个文件没被动过
  const before = fs.readFileSync(path.join(tmp, 'unit.gltf'), 'utf8')
  r = await post('/export', { dir: tmp, name: 'unit', format: 'gltf', dataBase64: b64 })
  check(r.json.ok === true, '重名导出失败')
  check(r.json.file !== path.join(tmp, 'unit.gltf'), `重名时不该覆盖：${r.json.file}`)
  check(fs.existsSync(r.json.file), '重名导出的文件不存在')
  check(fs.readFileSync(path.join(tmp, 'unit.gltf'), 'utf8') === before, '重名导出把已有文件改了')
  console.log(`  重名 → ${path.basename(r.json.file)}（原有文件未被覆盖）`)

  // 3. 扩展名由 format 决定，客户端传什么都不认
  r = await post('/export', { dir: tmp, name: 'unit', format: 'obj', ext: 'exe', dataBase64: Buffer.from(objText).toString('base64') })
  check(r.json.ok === true && r.json.file.endsWith('.obj'), `扩展名没按 format 走：${r.json.file}`)
  console.log(`  format=obj → ${path.basename(r.json.file)}（无视客户端传的 ext）`)

  // 4. 各种该拦住的
  const bad = [
    [{ dir: 'relative/dir', name: 'x', format: 'json', dataBase64: b64 }, '相对路径'],
    [{ dir: '', name: 'x', format: 'json', dataBase64: b64 }, '空 dir'],
    [{ dir: tmp, name: 'x', format: 'exe', dataBase64: b64 }, '未知格式'],
    [{ dir: tmp, name: 'x', format: 'json', dataBase64: '' }, '空数据'],
    // 内容与后缀不符：OBJ 文本不许写进 .json（读一遍就能发现，别等用户拿去打开才知道）
    [{ dir: tmp, name: 'x', format: 'json', dataBase64: Buffer.from(objText).toString('base64') }, '内容与格式不符'],
    // 根本不是网格：随便一段文字
    [{ dir: tmp, name: 'x', format: 'gltf', dataBase64: Buffer.from('not a mesh at all').toString('base64') }, '不是网格文件'],
    // 截断的 glTF：JSON 合法但缺 asset / accessor
    [{ dir: tmp, name: 'x', format: 'gltf', dataBase64: Buffer.from('{"meshes":[]}').toString('base64') }, '缺字段的 glTF'],
  ]
  for (const [body, why] of bad) {
    const res = await post('/export', body)
    check(res.json.ok === false, `${why} 应该被拒绝，实际：${JSON.stringify(res.json)}`)
    check(res.status >= 400, `${why} 的 HTTP 状态应是 4xx/5xx，实际 ${res.status}`)
  }
  // dir 指向一个文件
  const aFile = path.join(tmp, 'not-a-dir.txt')
  fs.writeFileSync(aFile, 'x')
  const res = await post('/export', { dir: aFile, name: 'x', format: 'json', dataBase64: b64 })
  check(res.json.ok === false, `dir 指向文件时应拒绝，实际：${JSON.stringify(res.json)}`)
  console.log('  非法请求 8 种全部拦下（相对路径 / 空 dir / 未知格式 / 空数据 / 内容与后缀不符 / 不是网格 / 缺字段 / dir 是文件）')

  // 5. 文件名净化：不许用它跳出目录
  r = await post('/export', { dir: tmp, name: '../../evil', format: 'json', dataBase64: jsonB64 })
  check(r.json.ok === true, `净化后的名字应该能正常导出：${JSON.stringify(r.json)}`)
  const esc = path.resolve(r.json.file || path.join(tmp, 'missing'))
  check(esc.startsWith(path.resolve(tmp)), `文件名跑出目录了：${esc}`)
  console.log(`  name="../../evil" → ${path.basename(r.json.file)}（仍在目标目录内）`)

  // 6. 目录不存在时应自动建出来（面板允许用户手填一个新目录）
  const nested = path.join(tmp, 'a', 'b')
  r = await post('/export', { dir: nested, name: 'deep', format: 'json', dataBase64: jsonB64 })
  check(r.json.ok === true && fs.existsSync(path.join(nested, 'deep.json')), '不存在的目录应被创建')
  console.log('  不存在的目录 → 自动创建后写入')
} finally {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length) {
  console.error('POST /export 测试失败：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('POST /export 测试通过：写入路径/内容正确，重名不覆盖，8 种非法请求全部拦下')
