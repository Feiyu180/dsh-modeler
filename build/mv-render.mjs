/**
 * mv-render.mjs —— 把内联进来的一个网格，渲染成"绕物体一圈"的几张着色图。
 *
 * 为什么要专门做这一步：Hunyuan3D-2mv 是在**渲染图**上训练的（官方示例还先跑
 * BackgroundRemover 抠图），拿手绘剪影去测它等于测了个分布外输入，结论不可信。
 * 所以先用真 three.js 渲出前/左/后三张干净底色的着色图，再去跑模型 —— 这样得到的
 * 结论才是"这个模型在我们这条链路上值不值得用"。
 *
 * 相机约定（和插件的视口一致）：front = 从 +Z 看，left = 从 −X 看，back = 从 −Z 看，
 * right = 从 +X 看；全部水平看向物体中心、模型朝上。
 */
import * as THREE from 'three'

const B64 = window.__MESH__ || {}
const VIEWS = [
  ['front', [0, 0, 1]],
  ['left', [-1, 0, 0]],
  ['back', [0, 0, -1]],
  ['right', [1, 0, 0]],
]
const SIZE = 512

function decode(b64, Type) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Type(u8.buffer)
}

const positions = decode(B64.positions, Float32Array)
const indices = decode(B64.indices, Uint32Array)

const geo = new THREE.BufferGeometry()
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
geo.setIndex(new THREE.BufferAttribute(indices, 1))
geo.computeVertexNormals()
geo.computeBoundingBox()
geo.computeBoundingSphere()

const bb = geo.boundingBox
const center = bb.getCenter(new THREE.Vector3())
const radius = geo.boundingSphere.radius || 1

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
renderer.setSize(SIZE, SIZE, false)
renderer.setPixelRatio(1)
renderer.setClearColor(0xf2f2f2, 1)          // 干净浅底：和训练数据的"抠完图"接近

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xf2f2f2)
// 灰白材质 + 三向光：给模型一点明暗，让它能判断朝向（纯剪影没有明暗线索）
const mat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 0.05, roughness: 0.75, side: THREE.DoubleSide })
const mesh = new THREE.Mesh(geo, mat)
mesh.position.sub(center)                     // 把物体挪到原点，四视角才对齐
scene.add(mesh)

const key = new THREE.DirectionalLight(0xffffff, 2.0)
key.position.set(2.5, 4, 3)
scene.add(key)
const fill = new THREE.DirectionalLight(0x9fc4ff, 0.7)
fill.position.set(-3, 1, -2)
scene.add(fill)
const rim = new THREE.DirectionalLight(0xffffff, 0.5)
rim.position.set(0, -3, 0)
scene.add(rim)
scene.add(new THREE.HemisphereLight(0xffffff, 0x999999, 0.55))

const cam = new THREE.PerspectiveCamera(35, 1, radius * 0.01, radius * 40)
const out = {}
for (const [name, dir] of VIEWS) {
  const d = radius * 3.2
  cam.position.set(dir[0] * d, dir[1] * d, dir[2] * d)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  renderer.render(scene, cam)
  out[name] = renderer.domElement.toDataURL('image/png')
}

// 把结果放进 DOM（外层用 --dump-dom 抓，不依赖截图）
const pre = document.getElementById('out')
pre.textContent = JSON.stringify(out)
document.getElementById('verdict').textContent =
  `已渲染 ${Object.keys(out).length} 个视角：${Object.keys(out).join(' / ')}`
document.title = 'mv-render-OK'
