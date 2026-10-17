/**
 * 一个精简的 three.js 视口封装。
 *
 * 只做三件事：把 canvas 变成能转的场景、把 { positions, indices } 换成可看的实体、
 * 跟随容器尺寸。所有状态都挂在 canvas 元素上（canvas.__r3），所以不会因为宿主
 * 重新渲染而重建 WebGL 上下文 —— 这一点很关键：React 每次渲染都新建闭包对象的话，
 * 依赖它的 useEffect 会每帧重跑，模型会闪。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/**
 * 视口状态挂在**容器 div** 上（container.__r3canvas = 当前那块 canvas），
 * 而不是挂在 React 渲染出来的 canvas 元素上。
 *
 * 为什么必须这样（这是踩了很久、最后由现场日志定位出来的）：
 *   `renderer.forceContextLoss()` 之后，那块 canvas 就**永远废了** —— 再调
 *   `getContext('webgl2', ...)` 时浏览器会把**那个已丢失的上下文原样还回来**
 *   （非空，但 `getShaderPrecisionFormat()` 返回 null），three.js 随后读 `.precision`
 *   就抛 "Cannot read properties of null (reading 'precision')"。
 *   canvas 是 React 渲染的、元素被复用，于是"dispose 过一次"就等于给这块 canvas 判了死刑：
 *   重试多少次都是同一个错（现场日志里连点 12 次重试，12 次同样的报错）。
 *
 * 现在改由视口自己创建/替换 canvas：容器里那块一旦被释放过（或被标记失败），
 * 下一次 ensure 就**换一块新的**。丢弃的上下文救不回来，但画布可以换。
 */
const CURRENT = '__r3canvas'
const USED = '__r3used'

function currentCanvas(container) {
  const c = container && container[CURRENT]
  return c && c.parentNode === container ? c : null
}

/** 造一块新 canvas 放进容器（先摘掉旧的，避免残留在 DOM 里） */
function attachCanvas(container) {
  const old = currentCanvas(container)
  if (old) { try { container.removeChild(old) } catch { /* 忽略 */ } }
  const c = document.createElement('canvas')
  c.style.width = '100%'
  c.style.height = '100%'
  c.style.display = 'block'
  container.appendChild(c)
  container[CURRENT] = c
  return c
}

export class ThreeViewport {
  constructor() {
    this.info = null
    this._mesh = null
    /**
     * 主视口（那块 canvas）创建失败的原因；成功时**必须清空**。
     *
     * 这里踩过一个很难受的坑：原来只有一个 lastError，ensure() 和 snapshot() 都往里写，
     * 而且**任何时候都不清**。于是"某一次快照失败"（那是另一块一次性 canvas）会永久点亮
     * 面板顶部那条"3D 预览不可用"的横幅 —— GPU 明明空着、视口其实好好的，横幅却再也
     * 消不掉，连"重开面板"都没用（面板最小化只是 display:none，canvas 从没被卸载，
     * 而 __r3Failed 会一直挂在那块元素上）。
     * 现在分成两个字段：横幅只认 ensureError，snapshot 的失败单独记。
     */
    this.ensureError = null
    this.snapshotError = null
    /** 实际用上的那档上下文属性（'aa' / 'no-aa' / 'no-aa+plain'）——诊断用 */
    this.attrsUsed = null
  }

  /** 兼容旧调用点：主视口失败信息（快照失败不算） */
  get lastError() { return this.ensureError }

  /**
   * 建（或复用）视口。参数是**容器元素**，不是 canvas。
   *
   * 复用规则：
   *   - 容器里那块 canvas 上还挂着活的 info → 直接复用
   *   - 那块 canvas 已经被用过（建过上下文，后来被 dispose 或丢了）→ **换一块新的**
   *   - 从没用过 → 就用它
   * `retry=true` 表示用户明确要求重来（清掉失败标记）。
   */
  ensure(container, { retry = false } = {}) {
    if (!container) return null
    let canvas = currentCanvas(container)
    if (canvas && canvas.__r3) { this.info = canvas.__r3; return canvas.__r3 }
    // 已经失败过就不再反复申请：每次都是一次 WebGL 上下文请求。
    // retry=true 是唯一的例外（用户点"重试"或重开面板时）—— 没有这条，失败就是永久性的。
    if (canvas && canvas.__r3Failed && !retry) return null
    // 关键：用过就丢掉。丢失的上下文救不回来（见文件头注释），只能换画布。
    if (canvas && canvas[USED]) canvas = attachCanvas(container)
    if (!canvas) canvas = attachCanvas(container)
    if (retry) {
      canvas.__r3Failed = false
      canvas.__r3Error = null
      this.ensureError = null
    }

    // ⚠ 必须接住构造异常。GPU 显存被别的进程占满时（例如同时跑着模型训练），
    // WebGL 上下文会创建失败 —— three.js 内部拿到 null context 后会抛
    // "Cannot read properties of null (reading 'precision')"。
    // 如果让它冒出去，React 渲染层会**把整个面板打挂**，可面板里还有拖图、雕刻、
    // 导出这些完全不依赖 GPU 的功能。所以这里降级：视口不可用，面板照常。
    //
    // 三档属性依次退让：MSAA(antialias) 在部分驱动/GPU 状态下正是失败的那一项 ——
    // 实测遇到过"裸探针能建、面板这组建不出来"，所以不能一试就放弃。
    // ⚠ 但换属性**只在同一块新画布上有意义**：画布上若已存在（丢失的）上下文，
    //   getContext 会把那个废对象原样还回来，换属性也救不回来。
    const attempts = [
      ['aa', { canvas, antialias: true, alpha: true }],
      ['no-aa', { canvas, antialias: false, alpha: true }],
      ['no-aa+plain', { canvas, antialias: false, alpha: false, powerPreference: 'low-power' }],
    ]
    let renderer
    let lastErr = null
    for (const [tag, params] of attempts) {
      try {
        renderer = new THREE.WebGLRenderer(params)
        this.attrsUsed = tag
        break
      } catch (e) {
        lastErr = e
      }
    }
    if (!renderer) {
      canvas.__r3Failed = true
      canvas.__r3Error = lastErr
      this.ensureError = lastErr
      return null
    }
    // 成功即清空：历史失败不能继续挂横幅
    this.ensureError = null
    canvas.__r3Error = null
    // 标记"这块画布上建过上下文了"：以后一旦 info 没了（dispose 或丢了），
    // 这块画布就不能再复用，必须换新的
    canvas[USED] = true
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200)
    camera.position.set(1.6, 1.15, 1.85)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.09
    controls.minDistance = 0.35
    controls.maxDistance = 40
    controls.autoRotateSpeed = 1.4

    // 灯光：主光投影 + 冷色补光 + 半球环境
    const key = new THREE.DirectionalLight(0xffffff, 2.4)
    key.position.set(3.2, 4.6, 3.4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 24
    key.shadow.camera.left = -1.6
    key.shadow.camera.right = 1.6
    key.shadow.camera.top = 1.6
    key.shadow.camera.bottom = -1.6
    key.shadow.bias = -0.0008
    scene.add(key)

    const fill = new THREE.DirectionalLight(0x8fb6ff, 1.0)
    fill.position.set(-3.2, 1.6, -2.4)
    scene.add(fill)

    scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x1b2635, 1.15))

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.62
    ground.receiveShadow = true
    scene.add(ground)

    const grid = new THREE.GridHelper(12, 48, 0x4a6a96, 0x263a55)
    grid.position.y = -0.6205
    grid.material.transparent = true
    grid.material.opacity = 0.5
    scene.add(grid)

    const axes = new THREE.AxesHelper(0.75)
    axes.position.set(-0.78, -0.615, -0.78)
    axes.material.depthTest = false
    axes.renderOrder = 3
    scene.add(axes)

    const group = new THREE.Group()
    scene.add(group)

    const material = new THREE.MeshStandardMaterial({
      color: 0x86c6ff,
      metalness: 0.18,
      roughness: 0.38,
      side: THREE.DoubleSide,
      flatShading: false,
    })
    const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x9fe0ff, wireframe: true, transparent: true, opacity: 0.85 })

    // 顶点色材质 —— 给 TripoSR 这类自带颜色的模型用。
    // 单独建一份、而不是直接给上面那个 material 开 vertexColors：three 要求开了
    // vertexColors 的几何体必须真的有 color 属性，而三视图雕刻出的网格只有位置和索引，
    // 共用一份材质会直接渲染报错。
    const vcolMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.06,
      roughness: 0.66,
      side: THREE.DoubleSide,
      flatShading: false,
    })

    const info = {
      renderer, scene, camera, controls, group, material, vcolMaterial, wireMaterial,
      ground, grid, axes, key,
      mesh: null, wire: null, wireOn: false, autoRotate: false,
      /** 当前实际挂在网格上的材质（顶点色模式会切到 vcolMaterial） */
      active: material,
    }

    const resize = () => {
      const parent = canvas.parentElement || canvas
      const w = Math.max(1, Math.floor(parent.clientWidth || canvas.clientWidth || 300))
      const h = Math.max(1, Math.floor(parent.clientHeight || canvas.clientHeight || 200))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    info.resize = resize

    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize)
      ro.observe(canvas.parentElement || canvas)
    }
    window.addEventListener('resize', resize)

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (controls.autoRotate) controls.update()
      else controls.update()
      renderer.render(scene, camera)
    }
    tick()

    info.dispose = () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', resize)
      controls.dispose()
      renderer.dispose()
      // ⚠ renderer.dispose() 只回收 GPU 资源与内部缓存，**不会**释放 WebGL 上下文本身。
      // 上下文有硬上限（Chrome 约 16 个），不主动丢掉的话，反复开关面板 / 插件热重载
      // 就会把它耗尽，之后再新建视口就报
      // "THREE.WebGLRenderer: Error creating WebGL context."（实测面板打不开就是这个）。
      // forceContextLoss 内部走 WEBGL_lose_context，才是真正把上下文交还。
      try { renderer.forceContextLoss() } catch { /* 忽略 */ }
      delete canvas.__r3
    }
    info.stop = () => cancelAnimationFrame(raf)

    resize()
    canvas.__r3 = info
    this.info = info
    return info
  }

  /** 用网格数据替换场景里的模型；传 null 清空 */
  show(container, mesh) {
    const info = this.ensure(container)
    if (!info) return null
    const { group } = info

    while (group.children.length) {
      const c = group.children.pop()
      if (c.geometry) c.geometry.dispose()
    }
    info.mesh = null
    info.wire = null
    this._mesh = mesh || null

    if (!mesh || !mesh.positions || !mesh.indices || mesh.indices.length === 0) return info

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    // 顶点色：TripoSR 输出的是 uint8 RGB，所以 normalized 必须为 true（否则 0-255 会被当成
    // 0-255 的浮点颜色，直接过曝成一片白）。
    const hasVcol = !!(mesh.colors && mesh.colors.length)
    if (hasVcol) geo.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3, true))
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    geo.computeBoundingBox()

    info.active = hasVcol ? info.vcolMaterial : info.material
    const m = new THREE.Mesh(geo, info.active)
    m.castShadow = true
    m.receiveShadow = true
    group.add(m)
    info.mesh = m

    if (info.wireOn) this.setWireframe(container, true)
    this.fit(container, mesh)
    return info
  }

  setWireframe(container, on) {
    const info = this.ensure(container)
    if (!info) return
    info.wireOn = !!on
    if (!info.mesh) return
    const geo = info.mesh.geometry
    if (on) {
      if (!info.wire) {
        info.wire = new THREE.Mesh(geo, info.wireMaterial)
        info.wire.renderOrder = 1
        info.group.add(info.wire)
      }
      // 用 info.active 而不是 info.material —— 顶点色模型挂的是 vcolMaterial
      info.active.transparent = true
      info.active.opacity = 0.42
      info.active.needsUpdate = true
    } else {
      if (info.wire) {
        info.group.remove(info.wire)
        info.wire = null
      }
      info.active.transparent = false
      info.active.opacity = 1
      info.active.needsUpdate = true
    }
  }

  setFlat(container, on) {
    const info = this.ensure(container)
    if (!info) return
    info.active.flatShading = !!on
    info.active.needsUpdate = true
  }

  setColor(container, hex) {
    const info = this.ensure(container)
    if (!info) return
    // 顶点色材质下 color 是乘数，改成非白会把模型整体染色 —— 所以只在非顶点色模式生效
    if (info.active && info.active.vertexColors) return
    info.active.color.setHex(hex)
  }

  setAutoRotate(container, on) {
    const info = this.ensure(container)
    if (!info) return
    info.controls.autoRotate = !!on
  }

  setHelpers(container, { grid, axes } = {}) {
    const info = this.ensure(container)
    if (!info) return
    if (grid !== undefined) info.grid.visible = !!grid
    if (axes !== undefined) info.axes.visible = !!axes
  }

  /** 相机自动框住模型 */
  fit(container, mesh) {
    const info = this.ensure(container)
    if (!info || !mesh) return
    let R = 1
    if (mesh.positions && mesh.positions.length) {
      let max = 0
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const d = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2])
        if (d > max) max = d
      }
      R = max || 1
    }
    const dist = R * 2.55
    const dir = info.camera.position.clone().normalize()
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.72, 1.15).normalize()
    info.camera.position.copy(dir.multiplyScalar(dist))
    info.controls.target.set(0, 0, 0)
    info.controls.update()

    // 地面/网格跟着模型尺度走
    const scale = Math.max(1, R * 2)
    info.grid.scale.setScalar(scale / 4)
    info.axes.scale.setScalar(Math.max(0.2, R * 0.9))
    info.axes.position.set(-scale * 0.5, -0.615 * (R / 0.62), -scale * 0.5)
    info.ground.position.y = -R * 1.02
    info.grid.position.y = -R * 1.02
  }

  /**
   * 把网格从某个正交方向渲染成 dataURL。
   *
   *   silhouette=true ：纯白、无光照、黑底 → 干净剪影，可以直接喂给三视图雕刻
   *   silhouette=false：带顶点色 + 光照     → 给人看重建效果（后视图靠它看背面）
   *
   * 用临时渲染器而不是复用主视口的：复用会把用户正在看的画面清掉。
   *
   * ⚠ 方向约定：TripoSR 输出的模型**正面朝 +X**，而三视图雕刻的约定是前视图沿 Z 压平、
   * 侧视图沿 X 压平。所以这里先把模型绕 Y 转 -90°（正面从 +X 转到 -Z），两边才对齐。
   * 不转的话，"前视图"拍到的其实是它的侧面 —— 这个坑在 TripoSR 那边已经踩过一次。
   */
  snapshot(mesh, { dir = 'front', silhouette = false, size = 512 } = {}) {
    if (!mesh || !mesh.positions || !mesh.indices || !mesh.indices.length) return null

    const canvas = document.createElement('canvas')
    // 同理必须接住：GPU 显存被占满时这里也拿不到上下文。返回 null 让调用方按
    // "这次快照拍不出来"处理，而不是抛出去把面板打挂。
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas, antialias: !silhouette, preserveDrawingBuffer: true, alpha: false,
      })
    } catch (e) {
      // 快照用的是另一块一次性 canvas，失败只意味着"这次快照拍不出来"，
      // **不能**据此说主视口坏了（面板横幅只认 ensureError）
      this.snapshotError = e
      return null
    }
    renderer.setSize(size, size, false)
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 1)

    const scene = new THREE.Scene()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    const hasVcol = !silhouette && !!(mesh.colors && mesh.colors.length)
    if (hasVcol) geo.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3, true))
    geo.computeVertexNormals()

    const mat = silhouette
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({
        vertexColors: hasVcol,
        color: hasVcol ? 0xffffff : 0x86c6ff,
        roughness: 0.62, metalness: 0.06, side: THREE.DoubleSide,
      })

    const holder = new THREE.Group()
    holder.rotation.y = -Math.PI / 2
    holder.add(new THREE.Mesh(geo, mat))
    scene.add(holder)

    if (!silhouette) {
      const key = new THREE.DirectionalLight(0xffffff, 2.2)
      key.position.set(3, 4.5, 3.2)
      const fill = new THREE.DirectionalLight(0x9fc4ff, 0.9)
      fill.position.set(-3, 1.2, -2.6)
      scene.add(key, fill, new THREE.HemisphereLight(0xc2d8ff, 0x1a2432, 0.9))
    }

    let R = 0
    const pos = mesh.positions
    for (let i = 0; i < pos.length; i += 3) {
      const d = Math.hypot(pos[i], pos[i + 1], pos[i + 2])
      if (d > R) R = d
    }
    R = R || 1

    const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.001, R * 40)
    const D = R * 10
    const DIRS = {
      front: [0, 0, -1],  // 相机在 -Z（模型的正面已经被转过来）
      back: [0, 0, 1],
      side: [1, 0, 0],
      top: [0, 1, 0],
    }
    const d = DIRS[dir] || DIRS.front
    cam.position.set(d[0] * D, d[1] * D, d[2] * D)
    // 俯视时 up 不能还是 +Y（会与视线平行导致退化），改用 -Z
    if (dir === 'top') cam.up.set(0, 0, -1)
    else cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()

    renderer.render(scene, cam)
    const url = canvas.toDataURL('image/png')

    geo.dispose()
    mat.dispose()
    renderer.dispose()
    // ⚠ snapshot 每次都会新建一个 WebGLRenderer，所以这里是**最大的上下文泄漏源**：
    // renderer.dispose() 不释放 WebGL 上下文本身，必须 forceContextLoss。
    // 这条路径被调得很频繁（每生成一次模型就投影三视图 = 3 次，四视角预览 = 4 次），
    // 泄漏十几个就顶到浏览器上限（Chrome 约 16 个），之后再建视口就报
    // "Error creating WebGL context." —— 面板打不开就是这个原因。
    try { renderer.forceContextLoss() } catch { /* 忽略 */ }
    return url
  }

  /**
   * 释放视口。参数是**容器**。
   *
   * 除了关掉渲染循环、丢掉上下文，还会把这块 canvas **从 DOM 里摘掉** ——
   * 因为释放过的上下文再也建不回来（getContext 会把废对象还给你），留着它只会
   * 让下一次 ensure 撞上 "Cannot read properties of null (reading 'precision')"。
   * 摘掉之后容器里是空的，下一次 ensure 自然造一块新画布。
   */
  dispose(container) {
    const canvas = currentCanvas(container)
    const info = canvas?.__r3
    if (info?.dispose) info.dispose()
    if (canvas) {
      try { container.removeChild(canvas) } catch { /* 忽略 */ }
      if (container[CURRENT] === canvas) delete container[CURRENT]
    }
    this.info = null
  }
}
