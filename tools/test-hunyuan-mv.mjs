/**
 * 多视图 Hunyuan3D-2mv 的端到端实测（+ 与单图版的对照）。
 *
 * 做三件事：
 *   0. **预检回归**：给 3 个视角时必须被拒绝（退出码 3）且**不加载模型** ——
 *      这台 8G 卡上 3 视图实测触发过 GPU 驱动复位（TDR，整个桌面闪断），
 *      所以"拒绝"本身就是要守住的行为。
 *   1. 用 samples/mv/{front,back}.png（同一非对称物体的真实着色渲染）跑 **2 视图** mv，
 *      断言：退出码 0、条件序列是 2 路拼接、网格规模/外框正常。
 *   2. 用同一张 front.png 跑**单图版**，同样步数/八叉树，把两边外框摆在一起比 ——
 *      夹具 +Z 方向有根"鼻子"，正面图看不出它多长（深度纯靠猜），背面图才能约束它。
 *
 * 为什么只跑 2 视图：3 视图（4110 token）在这台机器上会把驱动打崩，脚本会直接拒绝
 * （HY3D_MV_ALLOW_RISKY=1 才能绕过）。换到显存更大的机器再改这里。
 *
 * 用法：
 *   node tools/test-hunyuan-mv.mjs            # 预检 + 2 视图 + 单图对照（约 5 分钟）
 *   node tools/test-hunyuan-mv.mjs --mv-only  # 跳过单图对照
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const PY = 'D:\\dsh-data\\ComfyUI_windows_portable\\python_embeded\\python.exe'
const SCRIPT_MV = 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-mv-run.py'
const SCRIPT_SV = 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-run.py'
const DIR = 'D:\\dsh-data\\dsh-triposr\\hunyuan-full'
const DIT_MV = path.join(DIR, 'dit-mv-fp16.safetensors')
const DIT_SV = path.join(DIR, 'dit-fp16.safetensors')
const IMGS = path.join(root, 'samples', 'mv')
const TMP = path.join(root, '.tmp-mv-test')

const mvOnly = process.argv.includes('--mv-only')
const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

function run(exe, args, env, label) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: path.dirname(args[0]),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { out += d.toString('utf8') })
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', (e) => resolve({ code: -1, out: String(e) }))
  })
}

const exists = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false } }

if (!exists(PY)) { console.error(`缺少 ComfyUI python：${PY}`); process.exit(2) }
if (!exists(SCRIPT_MV)) { console.error(`缺少多视图脚本：${SCRIPT_MV}`); process.exit(2) }
if (!exists(DIT_MV)) {
  console.error('多视图权重还没就位（dit-mv-fp16.safetensors）——先在面板「环境与模型」里一键安装。')
  process.exit(2)
}
for (const v of ['front', 'left', 'back']) {
  if (!exists(path.join(IMGS, `${v}.png`))) {
    console.error(`缺少测试图 ${v}.png（用 node build/make-mv-render-test.mjs 重新生成）`)
    process.exit(2)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const summarize = (jsonPath, label) => {
  const m = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const e = m.extents.map((x) => +x.toFixed(3))
  console.log(`  ${label.padEnd(10)} 顶点 ${String(m.vertexCount).padStart(7)}  `
    + `三角形 ${String(m.triangleCount).padStart(7)}  外框 ${e.join(' × ')}  ${m.seconds}s`)
  return m
}

// ---- 0. 按本机显存决定"该拒绝还是该跑通" ----
// 门槛 11G 是实测标定：8G 上 1 视角正常、2 视角反复 OOM/崩溃、3 视角把驱动打崩（TDR）。
// 所以这个测试在两种机器上期望相反 —— 小显存必须拒绝，大显存必须跑通。
const vramMb = (() => {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
    return Math.max(...out.trim().split(/\r?\n/).map((s) => Number(s.trim()) || 0))
  } catch { return 0 }
})()
const canMultiView = vramMb >= 11 * 1024
console.log(`\n=== 本机显存 ${(vramMb / 1024).toFixed(1)}G → 期望：${canMultiView ? '2 视图跑通' : '2 视图被拒绝'} ===`)

if (!canMultiView) {
  const cases = [
    [3, { HY3D_MV_FRONT: path.join(IMGS, 'front.png'), HY3D_MV_LEFT: path.join(IMGS, 'left.png'), HY3D_MV_BACK: path.join(IMGS, 'back.png') }],
    [2, { HY3D_MV_FRONT: path.join(IMGS, 'front.png'), HY3D_MV_BACK: path.join(IMGS, 'back.png') }],
  ]
  for (const [views, env] of cases) {
    const miss = path.join(TMP, `should-not-exist-${views}.json`)
    const g = await run(PY, [SCRIPT_MV], { ...env, HY3D_JSON: miss, HY3D_OUT: TMP }, 'guard')
    check(g.code === 3, `${views} 视图应被拒绝（退出码 3），实际 ${g.code}`)
    check(/拒绝执行/.test(g.out), `${views} 视图被拒时没有给出人类可读的说明`)
    check(!/load DiT/.test(g.out), `${views} 视图拒绝得太晚 —— 已经加载 DiT 了（护栏位置不对）`)
    check(!fs.existsSync(miss), `${views} 视图被拒却仍产出文件`)
    console.log(`  ✔ ${views} 视图被拒绝（exit=3），未加载模型、未产出文件`)
  }
}

// ---- 1. 多视图：在本机上限内跑真推理 ----
// 小显存机器上只有 1 个视角能跑 —— 那等价于单图，但**值得测**：
// 它证明"mv 权重能加载、条件构造正确、整条管线通"，换机器时不用从零排查。
const runViews = canMultiView ? ['front', 'back'] : ['front']
console.log(`\n=== Hunyuan3D-2mv（${runViews.join(' + ')}，${runViews.length} 视图）===`)
const mvJson = path.join(TMP, 'mv.json')
const mvEnv = { HY3D_JSON: mvJson, HY3D_OUT: TMP, HY3D_FREE_AFTER: '1' }
if (runViews.includes('front')) mvEnv.HY3D_MV_FRONT = path.join(IMGS, 'front.png')
if (runViews.includes('back')) mvEnv.HY3D_MV_BACK = path.join(IMGS, 'back.png')
const t0 = Date.now()
const mvRun = await run(PY, [SCRIPT_MV], mvEnv, 'mv')
if (mvRun.code !== 0) {
  console.error(mvRun.out.slice(-3000))
  check(false, `多视图脚本退出码 ${mvRun.code}`)
}
// 条件序列 = 视角数 × 1370 token（DINOv2 1370 = 1 + 37×37 patch）
// ⚠ 脚本打印的是 Python tuple 的圆括号形式 `条件序列 (1, 1370, 1536)`，
//   不是 JSON 的方括号 —— 第一版我按方括号写，断言永远匹配不上。
const expectTokens = runViews.length * 1370
check(new RegExp(`条件序列 \\(1, ${expectTokens}, 1536\\)`).test(mvRun.out),
  `条件序列不是 ${runViews.length} 路拼接（应为 (1, ${expectTokens}, 1536)）`)
// 位置编码下标 = 固定顺序 front(0) / left(1) / back(2) / right(3) —— 顺序即语义
check(/pos#0/.test(mvRun.out), 'front 没有拿到 pos#0')
if (runViews.includes('back')) check(/pos#2/.test(mvRun.out), 'back 没有拿到 pos#2（顺序即语义）')
check(fs.existsSync(mvJson), '多视图没有产出 mesh.json')
const mv = fs.existsSync(mvJson) ? summarize(mvJson, 'mv') : null
if (mv) {
  check(mv.vertexCount > 5000, `多视图顶点数偏少：${mv.vertexCount}`)
  check(mv.triangleCount > 10000, `多视图三角形数偏少：${mv.triangleCount}`)
  check(mv.extents.every((v) => v > 0.1), `多视图外框异常：${mv.extents}`)
  check(Array.isArray(mv.views) && mv.views.join(',') === runViews.join(','),
    `结果里记的视角不对：${JSON.stringify(mv.views)}（应为 ${runViews.join(',')}）`)
}
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

// ---- 2. 单图版对照 ----
let sv = null
if (!mvOnly) {
  console.log('\n=== Hunyuan3D-2（单图，同一张 front.png）===')
  const svJson = path.join(TMP, 'sv.json')
  const svRun = await run(PY, [SCRIPT_SV], {
    HY3D_IMG: path.join(IMGS, 'front.png'),
    HY3D_JSON: svJson,
    HY3D_OUT: TMP,
    HY3D_FREE_AFTER: '1',
  }, 'sv')
  if (svRun.code !== 0) {
    console.error(svRun.out.slice(-2000))
    check(false, `单图脚本退出码 ${svRun.code}`)
  }
  if (fs.existsSync(svJson)) sv = summarize(svJson, 'single')
}

if (mv && sv) {
  const ratio = (m) => {
    const [x, y, z] = m.extents
    return `x/y=${(x / y).toFixed(2)} z/y=${(z / y).toFixed(2)}`
  }
  console.log('\n=== 对照（夹具的理论外框比例 x/y=0.96 z/y=1.00）===')
  console.log(`  多视图(前+后) ${ratio(mv)}`)
  console.log(`  单图(仅前)    ${ratio(sv)}   ← 正面图看不出 +Z 那根鼻子的深度，这一段基本靠猜`)
  // 不断言谁"更好"（那是主观判断），但把数字摆出来；这里只断言多视图没跑偏
  check(mv.extents[2] > 0, '多视图 Z 外框为 0，明显不对')
}

console.log('')
if (failures.length) {
  console.error('多视图实测失败：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`多视图实测通过：条件序列按 ${runViews.length} 路拼接 + 位置编码正确 + 网格规模正常`)
console.log(`产物：${TMP}`)
