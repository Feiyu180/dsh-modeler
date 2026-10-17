/**
 * 把 TripoSR 输出的 GLB 渲染成四视角对照图（自包含 HTML + headless 截图）。
 *
 * 为什么要看四个视角：单图重建最容易在正面"看着还行"，一到侧面/背面就露馅
 * （背面完全是先验猜的）。只贴正面等于自欺欺人。
 *
 * 用法：node build/make-glb-preview.mjs <glb路径> [输出html路径]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const glbPath = process.argv[2]
const outHtml = process.argv[3] || 'D:/dsh-data/dsh-triposr/output/glb-preview.html'
if (!glbPath || !fs.existsSync(glbPath)) {
  console.error('用法：node make-glb-preview.mjs <glb路径> [输出html]')
  process.exit(1)
}

const b64 = fs.readFileSync(glbPath).toString('base64')
console.log(`GLB ${glbPath}  ${(fs.statSync(glbPath).size / 1024).toFixed(1)} KB -> base64 ${(b64.length / 1024).toFixed(0)} KB`)

const entry = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const VIEWS = [
  ['正面', 0],
  ['侧面', Math.PI / 2],
  ['3/4 视角', Math.PI * 0.22],
  ['背面', Math.PI],
]

const bin = atob(window.__GLB_B64__)
const bytes = new Uint8Array(bin.length)
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

const grid = document.getElementById('grid')

new GLTFLoader().parse(bytes.buffer, '', (gltf) => {
  const model = gltf.scene
  const box = new THREE.Box3().setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  model.position.sub(center)
  const radius = Math.max(size.x, size.y, size.z) || 1

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
    cam.position.set(Math.sin(angle) * radius * 1.85, radius * 0.30, Math.cos(angle) * radius * 1.85)
    cam.lookAt(0, 0, 0)

    const key = new THREE.DirectionalLight(0xffffff, 2.3)
    key.position.set(3, 4.5, 3.2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.0)
    fill.position.set(-3, 1.2, -2.6)
    scene.add(fill)
    scene.add(new THREE.HemisphereLight(0xc2d8ff, 0x1a2432, 1.0))

    scene.add(model.clone())
    r.render(scene, cam)
  }
  window.__READY__ = true
  document.title = 'glb-preview-ok'
})
`

const bundle = await esbuild.build({
  stdin: { contents: entry, resolveDir: here, loader: 'js', sourcefile: 'glb-entry.js' },
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'],
  write: false, nodePaths: [path.join(here, 'node_modules')], logLevel: 'warning',
})
const js = bundle.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>glb-preview</title>
<style>
  html,body{margin:0;background:#070a10;color:#dbe6f5;font:13px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
  h1{font-size:15px;margin:14px 16px 4px}
  .note{margin:0 16px 12px;opacity:.6;font-size:12px}
  #grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 16px 16px}
  .cell{background:#0d121b;border:1px solid rgba(120,150,200,.2);border-radius:10px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:4px}
  .title{font-size:12px;font-weight:600;color:#a9c8ff}
  canvas{border-radius:6px;display:block;width:340px;height:340px}
</style></head><body>
<h1>TripoSR 单图重建结果（四个视角）</h1>
<p class="note">输入：用户角色设定图的正面（背景已用 bgFlood 抠好、合成为 TripoSR 训练用的 0.5 灰底）。
单图重建看不到背面，背面完全靠先验猜 —— 所以四个视角一起看才算诚实。</p>
<div id="grid"></div>
<script>window.__GLB_B64__ = ${JSON.stringify(b64)};</script>
<script>${js}</script>
</body></html>`

fs.writeFileSync(outHtml, html, 'utf8')
console.log(`已写出 ${outHtml}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`)
