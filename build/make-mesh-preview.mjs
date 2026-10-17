/**
 * 把 mesh.json（trimesh 从 GLB 导出的原始数组）渲染成四视角对照页。
 *
 * 为什么不直接用 GLTFLoader：本项目 vendored 的 three 是精简版（只有 OrbitControls），
 * 没有 examples/jsm/loaders/GLTFLoader.js。与其去网上拉一个回来（这台机器 GitHub 不稳），
 * 不如用 trimesh 把 GLB 拆成原始数组 —— 数据链路更短，也不引入新依赖。
 *
 * 用法：node build/make-mesh-preview.mjs <mesh.json> [输出html]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const jsonPath = process.argv[2]
const outHtml = process.argv[3] || 'D:/dsh-data/dsh-triposr/output/mesh-preview.html'
if (!jsonPath || !fs.existsSync(jsonPath)) {
  console.error('用法：node make-mesh-preview.mjs <mesh.json> [输出html]')
  process.exit(1)
}
const M = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
console.log(`mesh ${M.vertexCount} 顶点 / ${M.triangleCount} 三角形 / 颜色 ${M.colors ? '有' : '无'} / 水密 ${M.watertight}`)

const entry = `
import * as THREE from 'three'

// ⚠ 机位要绕 Y 转 90°。
// TripoSR 写出的 GLB 里，模型的"正面"朝 +X（不是 three/glTF 习惯的 +Z），
// 所以直接把相机放在 +Z 会拍到它的**侧面** —— 我一开始看到"横躺的一坨"就是这个原因，
// 白折腾了一轮。这里按 +X = 正面 来排机位。
const VIEWS = [
  ['正面', Math.PI / 2],
  ['侧面', 0],
  ['3/4 视角', Math.PI * 0.72],
  ['背面', -Math.PI / 2],
]
const M = window.__MESH__

function b64u8(s) {
  const b = atob(s)
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}

const pos = new Float32Array(b64u8(M.positions).buffer)
const idx = new Uint32Array(b64u8(M.indices).buffer)
const col = M.colors ? b64u8(M.colors) : null

// 居中 + 归一到半径 1，四个视角用同一套变换，方便横向对比
let minx = Infinity, miny = Infinity, minz = Infinity
let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
for (let i = 0; i < pos.length; i += 3) {
  if (pos[i] < minx) minx = pos[i]; if (pos[i] > maxx) maxx = pos[i]
  if (pos[i + 1] < miny) miny = pos[i + 1]; if (pos[i + 1] > maxy) maxy = pos[i + 1]
  if (pos[i + 2] < minz) minz = pos[i + 2]; if (pos[i + 2] > maxz) maxz = pos[i + 2]
}
const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2
const radius = Math.max(maxx - minx, maxy - miny, maxz - minz) / 2 || 1
const centered = new Float32Array(pos.length)
for (let i = 0; i < pos.length; i += 3) {
  centered[i] = (pos[i] - cx) / radius
  centered[i + 1] = (pos[i + 1] - cy) / radius
  centered[i + 2] = (pos[i + 2] - cz) / radius
}

const grid = document.getElementById('grid')
for (const [label, angle] of VIEWS) {
  const cell = document.createElement('div')
  cell.className = 'cell'
  const t = document.createElement('div')
  t.className = 'title'
  t.textContent = label
  const canvas = document.createElement('canvas')
  cell.append(t, canvas)
  grid.appendChild(cell)

  const r = new THREE.WebGLRenderer({ canvas, antialias: true })
  r.setSize(340, 340, false)
  r.setPixelRatio(1)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0e14)

  const cam = new THREE.PerspectiveCamera(36, 1, 0.01, 100)
  // 归一化后模型跨度是 2（半径 1）。FOV 36° ⇒ 半角 tan(18°)=0.325，
  // 要装下跨度 2 至少需要距离 1/0.325≈3.08；取 3.8 留余量。
  // 之前用 2.0，模型直接溢出画面被裁掉，害我一度以为"模型就是个大方块"。
  cam.position.set(Math.sin(angle) * 3.8, 0.55, Math.cos(angle) * 3.8)
  cam.lookAt(0, 0, 0)

  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(3, 4.5, 3.2)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.9)
  fill.position.set(-3, 1.2, -2.6)
  scene.add(fill)
  scene.add(new THREE.HemisphereLight(0xc2d8ff, 0x1a2432, 0.9))

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(centered, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true))
  else geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: !!col,
    color: col ? 0xffffff : 0x86c6ff,
    metalness: 0.08, roughness: 0.62, side: THREE.DoubleSide,
  })
  scene.add(new THREE.Mesh(geo, mat))
  r.render(scene, cam)
}

window.__READY__ = true
document.title = 'mesh-preview-ok'
`

const bundle = await esbuild.build({
  stdin: { contents: entry, resolveDir: here, loader: 'js', sourcefile: 'mesh-entry.js' },
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'],
  write: false, nodePaths: [path.join(here, 'node_modules')], logLevel: 'warning',
})
const js = bundle.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>mesh-preview</title>
<style>
  html,body{margin:0;background:#070a10;color:#dbe6f5;font:13px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
  h1{font-size:15px;margin:14px 16px 4px}
  .note{margin:0 16px 12px;opacity:.62;font-size:12px;line-height:1.7}
  #grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 16px 16px}
  .cell{background:#0d121b;border:1px solid rgba(120,150,200,.2);border-radius:10px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:4px}
  .title{font-size:12px;font-weight:600;color:#a9c8ff}
  canvas{border-radius:6px;display:block;width:340px;height:340px}
</style></head><body>
<h1>TripoSR 单图重建结果</h1>
<p class="note">
  输入 = 你那张角色设定图的<b>正面</b>（背景已用 bgFlood 抠好 + 合成 TripoSR 训练用的 0.5 灰底）<br>
  顶点 ${M.vertexCount} · 三角形 ${M.triangleCount} · 水密 ${M.watertight ? '是' : '否'} · 包围盒 ${M.extents.map((x) => x.toFixed(3)).join(' × ')}
  &nbsp;·&nbsp; <b>单图重建看不到背面，背面完全靠先验猜 —— 四个视角一起看才算诚实</b>
</p>
<div id="grid"></div>
<script>window.__MESH__ = ${JSON.stringify(M)};</script>
<script>${js}</script>
</body></html>`

fs.writeFileSync(outHtml, html, 'utf8')
console.log(`已写出 ${outHtml}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`)
