/**
 * 用 Stable Zero123 生成的三个正交视角跑视觉外壳，得到 3D 网格。
 *
 * 链路：
 *   front.png / side.png / top.png（Zero123 环绕生成）
 *     → Python 转成 .raw RGBA（Node 没 PNG 解码器）
 *     → silhouette()（bgFlood：靠连通性分背景，白裙子不会被当背景）
 *     → carve() 体素雕刻 + meshFromVoxels() 等值面
 *     → OBJ
 *
 * 与之前"三个 mesh 体素投票"那条失败路线的关键区别：
 *   视觉外壳**只取剪影**，对"Zero123 各视角之间是否像素级一致"要求低得多 ——
 *   只要轮廓对得上就够。而 mesh 投票要求三份神经网络幻觉互相吻合，那做不到。
 *
 * 用法：node tools/try-shell.mjs <views.json 所在目录> [输出前缀]
 */

import fs from 'node:fs'
import path from 'node:path'

import { silhouette, buildMesh, meshStats, toOBJ } from '../src/core/geometry.js'

const dir = process.argv[2] || 'D:/dsh-data/dsh-triposr/zero123-views/_raw'
const outPrefix = process.argv[3] || 'D:/dsh-data/dsh-triposr/zero123-views/_shell'

const meta = JSON.parse(fs.readFileSync(path.join(dir, 'views.json'), 'utf8'))
console.log('输入视角：')
const views = {}
for (const key of ['front', 'side', 'top']) {
  const m = meta[key]
  if (!m) continue
  const buf = fs.readFileSync(m.raw)
  const img = { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), width: m.width, height: m.height }
  // bgFlood 是关键：这些图是白底插画，主体里有大片白色（裙子、袜子），
  // 纯亮度阈值会把白裙子判成背景、把人物挖空。
  // ⚠ bgTol 是 **0-255 量纲**（源码里默认 26），不是 0-1 的比例 —— 传 0.08 等于容差为零，
  // 背景泛滥、整张图都被判成前景（实测前景占比 97~99%，雕刻出一个立方体）。
  const sil = silhouette(img, { bgFlood: true, fillHoles: true })
  views[key] = sil
  const bb = sil.bbox || {}
  console.log(`  ${key.padEnd(6)} ${m.width}x${m.height}  前景 ${(sil.coverage * 100).toFixed(1)}%` +
    `  内容框 ${bb.w || '?'}x${bb.h || '?'}  @${bb.x ?? '?'},${bb.y ?? '?'}`)
}

console.log('\n雕刻中…')
const t0 = Date.now()
const built = buildMesh(views, { resolution: 128, smooth: 1, removeIslands: 200 })
const ms = Date.now() - t0

const st = built.meta
console.log(`  顶点 ${st.vertexCount} · 三角形 ${st.triangleCount} · 耗时 ${ms} ms`)
console.log(`  水密 ${st.watertight ? '是' : '否'} · 包围盒 ${st.extent.map((v) => v.toFixed(3)).join(' × ')}`)
if (st.viewConsistency && st.viewConsistency.stretched) {
  console.log(`  ⚠ 三视图尺寸不自洽：${st.viewConsistency.warning}`)
}
if (st.missing && st.missing.length) console.log(`  缺视图：${st.missing.join('/')}`)

if (!built.positions.length) {
  console.error('\n✘ 结果是空网格 —— 剪影没提取出来或三张图对不上')
  process.exit(1)
}

fs.mkdirSync(path.dirname(outPrefix), { recursive: true })
const obj = toOBJ(built.positions, built.indices, path.basename(outPrefix))
fs.writeFileSync(`${outPrefix}.obj`, obj)
console.log(`\n已写出 ${outPrefix}.obj  ${(obj.length / 1024).toFixed(0)} KB`)
