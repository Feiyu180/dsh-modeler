/**
 * 预览页的渲染入口（会被 esbuild 打成 IIFE，内联进 preview.html）。
 *
 * 目的：**用真实 three.js 把重建出来的网格画出来**，用来回答两个自动化测试答不了的问题：
 *   1. three.js 能不能直接吃我导出的 { positions, indices }（法线、绕序、光照是否正常）
 *   2. 形状到底像不像那三张视图 —— 这个只能靠眼睛
 *
 * 页面通过 window.__MODELS__ 拿到网格数据（base64 的 Float32/Uint32）。
 */

import * as THREE from 'three'

const b64ToF32 = (s) => {
  const bin = atob(s)
  const buf = new ArrayBuffer(bin.length)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Float32Array(buf, 0, bin.length / 4)
}
const b64ToU32 = (s) => {
  const bin = atob(s)
  const buf = new ArrayBuffer(bin.length)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Uint32Array(buf, 0, bin.length / 4)
}

const models = window.__MODELS__ || []
const grid = document.getElementById('grid')

for (const m of models) {
  const cell = document.createElement('div')
  cell.className = 'cell'
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = m.name
  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = `${m.triangles} 三角形 · ${m.watertight ? '水密' : '不水密'}`
  const canvas = document.createElement('canvas')
  cell.appendChild(title)
  cell.appendChild(canvas)
  cell.appendChild(sub)
  grid.appendChild(cell)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(320, 320, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0e14)

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100)
  camera.position.set(1.35, 1.0, 1.6)
  camera.lookAt(0, 0, 0)

  const key = new THREE.DirectionalLight(0xffffff, 2.6)
  key.position.set(3, 4.5, 3.5)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x8fb6ff, 1.0)
  fill.position.set(-3, 1.5, -2.4)
  scene.add(fill)
  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x1b2635, 1.1))

  const geo = new THREE.BufferGeometry()
  const positions = b64ToF32(m.positions)
  const indices = b64ToU32(m.indices)
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const mat = new THREE.MeshStandardMaterial({
    color: 0x86c6ff, metalness: 0.18, roughness: 0.38, side: THREE.DoubleSide,
  })
  scene.add(new THREE.Mesh(geo, mat))

  // 关键：正交三视图小角落 —— 用平行投影直接从 +Z / -X / +Y 看，验证"模型投影 = 输入剪影"
  const orthoSize = geo.boundingSphere ? geo.boundingSphere.radius : 1
  const axes = [
    ['front', new THREE.Vector3(0, 0, 1)],
    ['side', new THREE.Vector3(-1, 0, 0)],
    ['top', new THREE.Vector3(0, 1, 0)],
  ]
  // 只在页面上留一个视角即可（主视角），三视图方向由 OrbitControls 手工转

  renderer.render(scene, camera)
  m.__done = true
}

// 标记渲染完成，供截图脚本等待
window.__READY__ = true
document.title = `preview-ready-${models.length}`
