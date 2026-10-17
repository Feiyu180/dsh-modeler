/**
 * 三路结果并排渲染：TripoSR 单图 / Zero123+外壳(el075) / Zero123+外壳(el090)
 *
 * 目的：作最终判断 —— 多花的那 19 分钟下载和一路排错，到底换来了什么。
 * 用同一个相机、同一套光照，避免"拍法不同"造成的假象。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const PY = 'D:\\dsh-data\\dsh-triposr\\python311\\python.exe'
const OUT = 'D:/dsh-data/dsh-triposr/compare'

const MODELS = [
  { label: 'TripoSR（单图 AI）', obj: 'D:/dsh-data/dsh-triposr/output_hi/0/mesh.glb' },
  { label: 'Zero123 + 外壳（top=el075）', obj: 'D:/dsh-data/dsh-triposr/zero123-views/_shell.obj' },
  { label: 'Zero123 + 外壳（top=el090）', obj: 'D:/dsh-data/dsh-triposr/zero123-views/_shell90.obj' },
]

// 用 Python 统一转成 positions/indices JSON（它已经有 trimesh）
console.log('转网格数据…')
const jsonPaths = []
for (let i = 0; i < MODELS.length; i++) {
  const m = MODELS[i]
  const jp = path.join(OUT, `m${i}.json`)
  fs.mkdirSync(OUT, { recursive: true })
  try {
    execFileSync(PY, ['D:/dsh-data/dsh-triposr/glb-to-json.py', m.obj, jp], { stdio: 'pipe' })
    jsonPaths.push(jp)
    const d = JSON.parse(fs.readFileSync(jp, 'utf8'))
    console.log(`  ${m.label}: ${d.vertexCount} 顶点 / ${d.triangleCount} 三角形`)
  } catch (e) {
    console.log(`  ${m.label}: 转换失败 ${e.message}`)
    jsonPaths.push(null)
  }
}

// 生成渲染页
const entry = `
import * as THREE from 'three'
const MODELS = window.__MODELS__
const VIEWS = [['正面', 0], ['侧面', Math.PI/2], ['3/4', Math.PI*0.25]]
const grid = document.getElementById('grid')

function b64u8(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u }

for (let mi = 0; mi < MODELS.length; mi++) {
  const M = MODELS[mi]
  const row = document.createElement('div')
  row.className = 'row'
  const h = document.createElement('div'); h.className = 'rowlabel'; h.textContent = M.label
  row.appendChild(h)
  const cells = document.createElement('div'); cells.className = 'cells'
  row.appendChild(cells)
  grid.appendChild(row)
  if (!M.data) { cells.textContent = '（缺失）'; continue }

  const pos = new Float32Array(b64u8(M.data.positions).buffer)
  const idx = new Uint32Array(b64u8(M.data.indices).buffer)
  const col = M.data.colors ? b64u8(M.data.colors) : null
  let mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9]
  for (let i=0;i<pos.length;i+=3) for (let k=0;k<3;k++){ if(pos[i+k]<mn[k])mn[k]=pos[i+k]; if(pos[i+k]>mx[k])mx[k]=pos[i+k] }
  const c=[0,1,2].map(k=>(mn[k]+mx[k])/2)
  const span=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2])||1
  const ctr=new Float32Array(pos.length)
  for (let i=0;i<pos.length;i+=3){ ctr[i]=(pos[i]-c[0])/span; ctr[i+1]=(pos[i+1]-c[1])/span; ctr[i+2]=(pos[i+2]-c[2])/span }

  for (const [label, angle] of VIEWS) {
    const cell = document.createElement('div'); cell.className='cell'
    const t=document.createElement('div'); t.className='title'; t.textContent=label
    const canvas=document.createElement('canvas'); cell.append(t,canvas); cells.appendChild(cell)
    const r=new THREE.WebGLRenderer({canvas,antialias:true}); r.setSize(300,300,false); r.setPixelRatio(1)
    const scene=new THREE.Scene(); scene.background=new THREE.Color(0x0b0e14)
    const cam=new THREE.PerspectiveCamera(36,1,0.01,100)
    cam.position.set(Math.sin(angle)*3.6, 0.5, Math.cos(angle)*3.6); cam.lookAt(0,0,0)
    const k1=new THREE.DirectionalLight(0xffffff,2.2); k1.position.set(3,4.5,3.2)
    const f1=new THREE.DirectionalLight(0x9fc4ff,0.9); f1.position.set(-3,1.2,-2.6)
    scene.add(k1,f1,new THREE.HemisphereLight(0xc2d8ff,0x1a2432,0.9))
    const geo=new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(ctr,3))
    geo.setIndex(new THREE.BufferAttribute(idx,1))
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col,3,true)); else geo.computeVertexNormals()
    const mat=new THREE.MeshStandardMaterial({vertexColors:!!col,color:col?0xffffff:0x86c6ff,roughness:0.62,metalness:0.06,side:THREE.DoubleSide})
    scene.add(new THREE.Mesh(geo,mat)); r.render(scene,cam)
  }
}
window.__READY__=true; document.title='compare-ok'
`

const bundle = await esbuild.build({
  stdin: { contents: entry, resolveDir: here, loader: 'js', sourcefile: 'cmp.js' },
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome110'],
  write: false, nodePaths: [path.join(here, 'node_modules')], logLevel: 'warning',
})

const payload = MODELS.map((m, i) => ({
  label: m.label,
  data: jsonPaths[i] && fs.existsSync(jsonPaths[i]) ? JSON.parse(fs.readFileSync(jsonPaths[i], 'utf8')) : null,
}))

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>compare</title>
<style>
 body{margin:0;background:#070a10;color:#dbe6f5;font:13px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
 h1{font-size:15px;margin:14px 16px 4px}
 .note{margin:0 16px 12px;opacity:.6;font-size:12px}
 #grid{padding:0 16px 16px}
 .row{margin-bottom:12px}
 .rowlabel{font-size:13px;font-weight:600;color:#a9c8ff;margin-bottom:5px}
 .cells{display:flex;gap:10px}
 .cell{background:#0d121b;border:1px solid rgba(120,150,200,.2);border-radius:10px;padding:7px;display:flex;flex-direction:column;align-items:center;gap:3px}
 .title{font-size:11px;color:#8fb4e8}
 canvas{border-radius:6px;display:block;width:300px;height:300px}
</style></head><body>
<h1>三路结果对比（同一相机、同一光照）</h1>
<p class="note">TripoSR 是单图直接重建；Zero123 两行是先绕着生成多视角、再用视觉外壳雕，区别只在俯视图选 el075 还是 el090。</p>
<div id="grid"></div>
<script>window.__MODELS__ = ${JSON.stringify(payload)};</script>
<script>${bundle.outputFiles[0].text}</script>
</body></html>`

fs.writeFileSync(path.join(OUT, 'compare.html'), html, 'utf8')
console.log(`\n已写出 ${path.join(OUT, 'compare.html')}`)
