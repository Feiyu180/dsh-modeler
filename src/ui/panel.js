/**
 * dsh-modeler 面板：三视图建模 UI。
 *
 * 只用 React.createElement（不写 JSX），React 由构造函数注入 —— 这样同一份代码
 * 既能跑在独立页（importmap 加载 react/three），也能被 esbuild 打成 DSH 客户端插件。
 *
 * 数据流：
 *   拖入/选择/粘贴三张图 → canvas 读像素 → silhouette() 剪影
 *   → carve() 体素雕刻 → buildMesh() 等值面 → three.js 显示 → 导出 OBJ / STL / GLB
 */

import {
  silhouette, buildMesh, toOBJ, toSTLBinary, toSTLAscii, toGLB, toGLTF, toMeshJSON,
  // 三视图 → AI 的融合要用：三个 mesh 各自归一化 → 体素化 → 投票合并 → 等值面重建
  normalizeMesh, meshToVoxels, mergeVoxelVotes, meshFromVoxels,
} from '../core/geometry.js'
import { ThreeViewport } from './viewport.js'

const VIEW_META = [
  { key: 'front', label: '前视图', hint: '正对物体看：宽→左右(X)，高→上下(Y)' },
  { key: 'side', label: '侧视图', hint: '从物体右侧看：宽→前后(Z)，高→上下(Y)' },
  { key: 'top', label: '俯视图', hint: '从上往下看：宽→左右(X)，高→前后(Z)' },
]

const DEFAULTS = {
  resolution: 96,
  padding: 0.06,
  smooth: 1,
  threshold: 0.5,
  auto: true,
  invert: false,
  fillHoles: true,
  mirrorSide: false,
  enforceSymmetry: false,
  removeIslands: 0,
  wireframe: false,
  flat: false,
  autoRotate: false,
  // AI 任务跑完是否主动卸载模型 + 清显存缓存。
  // 默认开：8G 卡上常和别的任务（比如模型训练）抢显存，用完立刻还回去更省心。
  autoFree: true,
}

// ---------------------------------------------------------------------------
// 图片处理
// ---------------------------------------------------------------------------

async function toBitmap(source) {
  if (source instanceof HTMLImageElement) {
    if (!source.complete) await source.decode().catch(() => {})
    return source
  }
  return createImageBitmap(source, { imageOrientation: 'from-image' })
}

/** 任意图源 → { data, width, height } 像素缓冲 */
async function readImage(source) {
  const bmp = await toBitmap(source)
  const w = bmp.naturalWidth || bmp.width
  const h = bmp.naturalHeight || bmp.height
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, w, h)
  if (bmp.close && source !== bmp) bmp.close()
  return { data: px.data, width: w, height: h }
}

/** 剪影 → 可显示的预览（青色实体 + 红色内容框），顺便把这张图留作重新计算的底图 */
function makePreview(sil) {
  const cv = document.createElement('canvas')
  cv.width = sil.width
  cv.height = sil.height
  const ctx = cv.getContext('2d')
  const out = ctx.createImageData(sil.width, sil.height)
  for (let i = 0; i < sil.mask.length; i++) {
    const on = sil.mask[i] ? 1 : 0
    const p = i * 4
    out.data[p] = on ? 96 : 10
    out.data[p + 1] = on ? 205 : 14
    out.data[p + 2] = on ? 255 : 24
    out.data[p + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  if (sil.bbox) {
    ctx.strokeStyle = 'rgba(255,96,96,.95)'
    ctx.lineWidth = Math.max(1, Math.round(sil.width / 180))
    ctx.strokeRect(sil.bbox.x0 + 0.5, sil.bbox.y0 + 0.5, sil.bbox.width - 1, sil.bbox.height - 1)
  }
  return cv.toDataURL('image/png')
}

/** 用当前参数把一张底图重算成剪影 */
function recomputeSil(img, key, o) {
  const sil = silhouette(img, {
    auto: o.auto,
    threshold: o.threshold,
    invert: o.invert,
    fillHoles: o.fillHoles,
    mirror: key === 'side' ? o.mirrorSide : false,
    // bgFlood 默认关，不影响既有的"用户自己给剪影图"流程。
    // Zero123 那条路会显式打开：它生成的是**白底插画**，角色身上有大片白色
    // （裙子、袜子），纯亮度阈值会把它们判成背景、把人物挖空。
    bgFlood: !!o.bgFlood,
  })
  return { img, sil, preview: makePreview(sil) }
}

/** base64 → Uint8Array（host 那边把顶点/索引/颜色都以 base64 传回来） */
function b64ToU8(s) {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/**
 * Uint8Array → base64（导出给 host 落盘时用）。
 * 分块拼字符串：一次 apply 太多参数会爆栈，而一个 19 万顶点的 GLB 有 8 MB 左右。
 */
function bytesToBase64(u8) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/** 面板调 host 的入口（host 侧用 ctx.webServer.register 注册的前缀路由） */
const API = '/dsh-modeler/api'

/**
 * Hunyuan3D-2mv 的四个视角槽。
 * **顺序即语义**：模型按 front→left→back→right 给每个视角加位置编码（host 侧脚本照抄了
 * ComfyUI 官方实现），顺序错了不会报错，只会生成一个视角错位的模型。
 * ⚠ 没有 top：这是绕物体一圈的方位角视角，工程三视图里的俯视图没有对应槽。
 */
const MV_VIEWS = [
  { key: 'front', label: '前', hint: '从物体正面看（+Z 方向）' },
  { key: 'left', label: '左', hint: '从物体左侧看' },
  { key: 'back', label: '后', hint: '从物体背面看 —— 有它背面才不是猜的' },
  { key: 'right', label: '右', hint: '从物体右侧看（可选）' },
]

// ---------------------------------------------------------------------------
// 可选的建模 AI
// ---------------------------------------------------------------------------
//
// value 沿用既有的 aiInput 取值（single / zero123 / hunyuan / views），所以下面几段
// 输入区与执行逻辑一行都不用改；host 的 /providers 只用来**补充可用性信息**
// （哪些还没装、缺什么），拿不到清单就当作"未知"，不挡着用。
const AI_MODELS = [
  {
    v: 'single', provider: 'triposr', label: 'TripoSR（单图 · 最轻）',
    note: '一张图 → 直接出模型。最快最省资源，但细节偏糊、背面靠先验猜',
  },
  {
    v: 'zero123', provider: 'zero123', label: 'Zero123 多视角',
    note: '一张图 → 绕圈生成前/侧/俯 → 视觉外壳雕刻。约 40 秒，轮廓清楚但没有颜色',
  },
  {
    v: 'hunyuan', provider: 'hunyuan3d', label: 'Hunyuan3D-2（精细）',
    note: '一张图 → 三维原生生成精细网格。约 130 秒，几何最细、比例最准，但没有颜色',
  },
  {
    v: 'mv', provider: 'hunyuan3dmv', label: 'Hunyuan3D-2mv（多视图）',
    note: '前/左/后(/右) 一起推理 —— 背面不再靠猜。约 130 秒，没有颜色；'
      + '视角是绕物体一圈的方位角视角，没有俯视槽',
  },
  {
    v: 'views', provider: null, label: '三视图 AI 融合（实验）',
    note: '每个视图各跑一次 TripoSR 再体素投票 —— 实测三个幻觉投不出东西，仅留作对照',
  },
]


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 跨窗口共享状态
// ---------------------------------------------------------------------------
//
// 面板可能"活着"在两个地方：DSH 里的浮窗，或者弹出去的独立窗口。那是**两棵独立的
// React 树**（独立窗口用 react-dom/client 建自己的 root），所以面板状态不能留在组件
// 内部 —— 否则一换窗口就全丢（拖进去的三张图、生成的网格、参数…）。
//
// 这里把状态放到模块级 store：
//   · 值存在 store 里，组件卸载不丢；
//   · 任意一个 root 改了值，其它订阅者同步更新；
//   · setter 兼容 useState 的两种写法（直接给值 / 函数式更新）。
//
// 附带的好处：**任务跑到一半把面板弹到独立窗口也能接着显示进度** —— 轮询循环持有的是
// store 的 setter（引用稳定），它照常更新 store，并通知"当前挂载的那个 root"。

const sharedStore = new Map()
const sharedSubs = new Map()

/** useState 的跨窗口版本：值存在模块级 store，卸载不丢、多 root 同步 */
function useShared(React, key, initial) {
  const [v, setV] = React.useState(() => (sharedStore.has(key) ? sharedStore.get(key) : initial))
  React.useEffect(() => { sharedStore.set(key, v) }, [key, v])
  React.useEffect(() => {
    let subs = sharedSubs.get(key)
    if (!subs) { subs = new Set(); sharedSubs.set(key, subs) }
    subs.add(setV)
    // 订阅时先对齐一次：另一个 root 可能已经改过这个 key
    setV(sharedStore.has(key) ? sharedStore.get(key) : initial)
    return () => { subs.delete(setV) }
  }, [key])
  const set = React.useCallback((next) => {
    const prev = sharedStore.has(key) ? sharedStore.get(key) : initial
    const val = typeof next === 'function' ? next(prev) : next
    sharedStore.set(key, val)
    const subs = sharedSubs.get(key)
    if (subs) for (const f of subs) f(val)
  }, [key])
  return [v, set]
}

export function createModelerPanel(React, hooks = {}) {
  const { useState, useRef, useEffect, useCallback, useMemo } = React
  // onExport：导出按钮交给宿主处理；onMesh：网格一变就通知宿主（独立视口窗口靠它同步）
  // pickDirectory：DSH 原生目录选择器（导出到本地目录）；diag：写诊断给外部看
  // onViewportDead：视口建不起来时通知宿主（宿主会再探一次 WebGL，必要时重载页面）
  const {
    onExport = null, onMesh = null, pickDirectory = null, diag = null, onViewportDead = null,
  } = hooks

  // 所有子组件共享同一份 React 引用
  const el = React.createElement

  // -------------------------------------------------------------------------
  // 小组件
  // -------------------------------------------------------------------------

  const styles = {
    wrap: {
      display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
      height: '100%', boxSizing: 'border-box', minHeight: 0,
      font: '13px/1.65 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif',
    },
    row: { display: 'flex', gap: 8, alignItems: 'center' },
    card: {
      border: '1px solid var(--dsh-border, rgba(120,150,200,.22))',
      borderRadius: 10, padding: 9,
      background: 'var(--dsh-surface, rgba(255,255,255,.028))',
    },
    btn: {
      padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(130,150,190,.38)',
      background: 'rgba(120,150,200,.12)', color: 'inherit',
    },
    btnOn: {
      padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(110,190,255,.85)',
      background: 'rgba(90,160,255,.28)', color: 'inherit',
    },
    err: {
      color: '#ff9d9d', background: 'rgba(255,80,80,.1)',
      border: '1px solid rgba(255,120,120,.35)', borderRadius: 8,
      padding: '7px 10px', fontSize: 12,
    },
    warn: {
      color: '#ffd9a0', background: 'rgba(255,180,60,.1)',
      border: '1px solid rgba(255,190,90,.4)', borderRadius: 8,
      padding: '7px 10px', fontSize: 12,
    },
    mono: { font: '11px/1.55 ui-monospace,Consolas,"Cascadia Mono",monospace', whiteSpace: 'pre-wrap', opacity: 0.85 },
    viewportWrap: {
      position: 'relative', flex: '1 1 240px', minHeight: 200, borderRadius: 10,
      overflow: 'hidden', border: '1px solid var(--dsh-border, rgba(120,150,200,.22))',
      background: 'radial-gradient(130% 120% at 50% -10%, rgba(58,108,180,.4), rgba(9,14,24,.92))',
    },
    canvas: { width: '100%', height: '100%', display: 'block' },
    // 视口容器：canvas 由 ThreeViewport 自己塞进来（废了就换一块）
    canvasBox: { position: 'absolute', inset: 0 },
    hint: { fontSize: 11, opacity: 0.55, marginTop: 5 },
  }

  function Slider({ label, k, opt, setOpt, min, max, step, fmt }) {
    const v = opt[k]
    return el('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
      el('span', { style: { opacity: 0.72, minWidth: 54 } }, label),
      el('input', {
        type: 'range', min, max, step, value: v, style: { width: 92 },
        onChange: (e) => setOpt({ ...opt, [k]: Number(e.target.value) }),
      }),
      el('span', { style: { font: '11px ui-monospace,monospace', minWidth: 36 } }, fmt ? fmt(v) : String(v)),
    )
  }

  function Toggle({ label, k, opt, setOpt, title }) {
    const on = !!opt[k]
    return el('button', {
      style: on ? styles.btnOn : styles.btn,
      title: title || undefined,
      onClick: () => setOpt({ ...opt, [k]: !on }),
    }, (on ? '◉ ' : '○ ') + label)
  }

  function ViewSlot({ meta, view, onFile, onClear }) {
    const inputRef = useRef(null)
    const [over, setOver] = useState(false)
    return el('div', { style: styles.card },
      el('div', { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 6 } },
        el('span', { style: { fontSize: 12, fontWeight: 600 } }, meta.label),
        view ? el('button', {
          style: { ...styles.btn, padding: '1px 7px' }, title: '移除这张视图',
          onClick: onClear,
        }, '×') : null,
      ),
      el('div', {
        onClick: () => inputRef.current?.click(),
        onDragOver: (e) => { e.preventDefault(); setOver(true) },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          e.preventDefault(); setOver(false)
          const f = e.dataTransfer?.files?.[0]
          if (f) onFile(f)
        },
        style: {
          border: `1.5px dashed ${view ? 'rgba(110,190,255,.7)' : over ? 'rgba(110,190,255,.8)' : 'rgba(130,150,190,.42)'}`,
          borderRadius: 8, minHeight: 92, display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', overflow: 'hidden',
          background: view ? 'rgba(90,160,255,.07)' : over ? 'rgba(90,160,255,.06)' : 'transparent',
        },
        title: '点击选择图片，或把它拖进来',
      },
        view
          ? el('img', { src: view.preview, alt: meta.label, style: { width: '100%', display: 'block', imageRendering: 'pixelated' } })
          : el('div', { style: { fontSize: 12, opacity: 0.6, textAlign: 'center', padding: 8, pointerEvents: 'none' } },
              '拖入 / 点击选择',
              el('br'),
              el('span', { style: { fontSize: 11, opacity: 0.75 } }, 'PNG · JPG · 截图'),
            ),
      ),
      el('div', { style: styles.hint }, meta.hint),
      el('input', {
        ref: inputRef, type: 'file', accept: 'image/*', style: { display: 'none' },
        onChange: (e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' },
      }),
    )
  }

  /** 单图模式的槽：一张图 + 「生成」+ 实时进度 */
  function SingleSlot({ single, onFile, onClear, onRun, job }) {
    const inputRef = useRef(null)
    const [over, setOver] = useState(false)
    const running = !!(job && job.state === 'running')
    return el('div', { style: styles.card },
      el('div', { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 6 } },
        el('span', { style: { fontSize: 12, fontWeight: 600 } }, '输入图'),
        single ? el('button', {
          style: { ...styles.btn, padding: '1px 7px' }, title: '移除这张图', onClick: onClear,
        }, '×') : null,
      ),
      el('div', {
        onClick: () => inputRef.current?.click(),
        onDragOver: (e) => { e.preventDefault(); setOver(true) },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          e.preventDefault(); setOver(false)
          const f = e.dataTransfer?.files?.[0]
          if (f) onFile(f)
        },
        style: {
          border: `1.5px dashed ${single ? 'rgba(110,190,255,.7)' : over ? 'rgba(110,190,255,.8)' : 'rgba(130,150,190,.42)'}`,
          borderRadius: 8, minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', overflow: 'hidden',
          background: single ? 'rgba(90,160,255,.07)' : over ? 'rgba(90,160,255,.06)' : 'transparent',
        },
        title: '点击选择图片，或拖进来（也支持 Ctrl+V 粘贴）',
      },
        single
          ? el('img', { src: single.preview, alt: '输入图', style: { maxWidth: '100%', maxHeight: 220, display: 'block' } })
          : el('div', { style: { fontSize: 12, opacity: 0.6, textAlign: 'center', padding: 10, pointerEvents: 'none' } },
              '拖入 / 点击选择一张图',
              el('br'),
              el('span', { style: { fontSize: 11, opacity: 0.75 } }, '正面或 3/4 侧角效果最好 · 自动铺 0.5 灰底'),
            ),
      ),
      el('div', { style: { ...styles.row, marginTop: 8, gap: 8 } },
        el('button', {
          style: single && !running ? styles.btnOn : styles.btn,
          disabled: !single || running,
          onClick: onRun,
        }, running ? '重建中…' : '生成 3D 模型'),
        el('span', { style: { fontSize: 11, opacity: 0.6 } },
          running ? `${(job && job.step) || '处理中'}（约 1 分钟）` : '本机 TripoSR · 约 1 分钟'),
      ),
      job && job.lines && job.lines.length
        ? el('div', {
            style: { ...styles.mono, marginTop: 6, maxHeight: 88, overflow: 'auto', opacity: 0.7 },
          }, job.lines.slice(-8).join('\n'))
        : null,
      el('input', {
        ref: inputRef, type: 'file', accept: 'image/*', style: { display: 'none' },
        onChange: (e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' },
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 主组件
  // -------------------------------------------------------------------------

  return function ModelerPanel() {
    // 面板状态一律走跨窗口 store（useShared），这样"DSH 浮窗 ↔ 独立窗口"之间切换
    // 不会丢状态。key 就是持久标识，initial 只在首次用到时生效。
    const shared = (key, init) => useShared(React, key, init)
    const [views, setViews] = shared('views', { front: null, side: null, top: null })
    const [opt, setOpt] = shared('opt', { ...DEFAULTS })
    const [mesh, setMesh] = shared('mesh', null)
    const [stat, setStat] = shared('stat', null)

    // 网格一变就推给宿主（独立视口窗口靠它同步）。单向、无回传，
    // 所以不会和面板自己的状态形成环。onMesh 是模块级函数，引用稳定。
    useEffect(() => {
      if (onMesh) onMesh(mesh)
    }, [mesh, onMesh])
    const [error, setError] = shared('error', '')
    const [busy, setBusy] = shared('busy', false)
    const [status, setStatus] = shared('status', '')

    // ---- 单图 → 3D（调 host 的 TripoSR 通路）----
    const [mode, setMode] = shared('mode', 'views')   // 'views' | 'single'
    const [single, setSingle] = shared('single', null)  // { preview, base64 }
    const [job, setJob] = shared('job', null)        // { id, state, step, lines }
    const [snaps, setSnaps] = shared('snaps', null)    // 单图结果的四视角着色预览 { front, back, side, top }

    // ---- AI 模型清单 / 本地环境（都来自 host；拿不到也不影响正常使用）----
    const [providers, setProviders] = useState(null)
    const [env, setEnv] = useState(null)
    const [envBusy, setEnvBusy] = useState(false)
    const [showEnv, setShowEnv] = useState(false)

    // 启动时拉一次模型清单，用来在下拉里标注"未安装"
    useEffect(() => {
      let alive = true
      fetch(`${API}/providers`)
        .then((r) => r.json())
        .then((j) => { if (alive && j && j.ok) setProviders(j.providers) })
        .catch(() => { /* host 尚未重启时该端点不存在，静默回退到内置清单 */ })
      return () => { alive = false }
    }, [])

    /** 某模式对应的 provider 是否可用；null 表示"未知"（没有清单） */
    const availOf = (v) => {
      if (!providers) return null
      const meta = AI_MODELS.find((m) => m.v === v)
      if (!meta || !meta.provider) return null
      const p = providers.find((x) => x.id === meta.provider)
      return p ? p.available : null
    }

    /**
     * 本机显存够不够跑多视图（Hunyuan3D-2mv）。
     *
     * 门槛 11G 是**实测标定**的：本机 8G 上 1 视角正常、2 视角反复 OOM/崩溃、
     * 3 视角直接把显示驱动打崩。所以这里不足就禁用按钮 —— 用户点一下、桌面闪断，
     * 是最糟糕的交互。
     * env 还没探测过时返回 false（不拦），切到 mv 模式会自动触发一次探测。
     */
    const mvVramGb = env && env.environment && env.environment.gpu && env.environment.gpu[0]
      ? +(env.environment.gpu[0].totalMB / 1024).toFixed(1) : null
    const mvVramTooSmall = mvVramGb !== null && mvVramGb < 11

    /** 按需拉环境探测（只读：不装、不改、不下载） */
    const loadEnv = useCallback(async () => {
      setEnvBusy(true); setError('')
      try {
        const r = await fetch(`${API}/environment`)
        const j = await r.json()
        if (!j.ok) throw new Error(j.error || '探测失败')
        setEnv(j)
      } catch (e) {
        setError(`环境探测失败：${e.message || e}（host 是否还没重启？）`)
      } finally {
        setEnvBusy(false)
      }
    }, [])

    // 运行环境安装向导：清单已在 /environment 里，**命令点按钮才去要**（含绝对路径，不预取）。
    // 与"一键安装"的分工：这里解决运行时（Python / ComfyUI / 脚本），那边只下权重。
    const [setupInfo, setSetupInfo] = useState(null)
    const [setupBusy, setSetupBusy] = useState(false)
    const loadSetupInfo = useCallback(async () => {
      setSetupBusy(true)
      try {
        const r = await fetch(`${API}/setup-env`)
        const j = await r.json()
        if (!j.ok) throw new Error(j.error || '拿不到安装命令')
        setSetupInfo(j)
      } catch (e) {
        setError(`生成安装命令失败：${e.message || e}（host 是否还没重启？）`)
      } finally { setSetupBusy(false) }
    }, [])

    // 切到多视图模式时自动探一次环境：它的按钮要不要禁用，取决于本机显存（见 mvVramTooSmall）。
    // 不探的话用户第一次进这个模式会看到一个"可用"的按钮 —— 而它在这台机器上不该被点。
    // ⚠ 这个 effect 必须放在 `aiInput` 声明**之后**（我第一次写在前面，直接 TDZ 报错
    //   "Cannot access 'aiInput' before initialization"，整个面板都渲染不出来 ——
    //   verify-ui 当场抓到）。

    // ---- 一键装权重 ----
    // 走 shared：关掉面板再打开，正在跑的安装任务还在（host 里那个 job 本来就不会停）。
    const [installJob, setInstallJob] = shared('install', null)   // { id, provider, state, step, lines }
    const [installing, setInstalling] = useState('')              // 正在提交/轮询的 provider id

    /**
     * 轮询一个安装任务直到结束。抽出来是为了让"提交"和"手动刷新"共用一份逻辑。
     */
    const pollInstall = useCallback(async (jid, pid) => {
      for (;;) {
        await new Promise((res) => setTimeout(res, 2500))
        const jr = await fetch(`${API}/job?id=${encodeURIComponent(jid)}`)
        const j = await jr.json()
        if (!j.ok) throw new Error(j.error || '查询进度失败')
        setInstallJob({ id: j.id, provider: pid, state: j.state, step: j.step, lines: j.lines || [] })
        if (j.state === 'error') throw new Error(j.error || '安装失败')
        if (j.state === 'done') return
      }
    }, [])

    /** 装完之后重探一次环境与清单，让"缺 xxx"和"未安装"标记消失 */
    const refreshAfterInstall = useCallback(async () => {
      await loadEnv()
      const pr = await fetch(`${API}/providers`).then((x) => x.json()).catch(() => null)
      if (pr && pr.ok) setProviders(pr.providers)
      setStatus('权重已就位 —— 可以在下拉里选它了')
    }, [loadEnv])

    /**
     * 下载某个模型缺的权重。用的是现成的 32 线程分段下载器，
     * 已存在的文件（大小吻合）会跳过，所以中途断了再点一次不会重下几 GB。
     *
     * 注意：这个循环活在浏览器里，但**下载活在 host 里**。面板关掉（组件卸载）
     * 循环仍会跑完并写进 shared store；只有整页刷新才会断，那时用"刷新进度"按钮补看。
     */
    const runInstall = useCallback(async (pid) => {
      if (installing) return
      setError(''); setInstalling(pid)
      setInstallJob({ id: null, provider: pid, state: 'running', step: '提交安装任务…', lines: [] })
      try {
        const r = await fetch(`${API}/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: pid }),
        })
        const j0 = await r.json()
        if (!j0.ok) throw new Error(j0.error || '提交失败')
        await pollInstall(j0.jobId, pid)
        await refreshAfterInstall()
      } catch (e) {
        setError(`安装失败：${e.message || e}`)
        setInstallJob((p) => (p ? { ...p, state: 'error', step: String(e.message || e) } : p))
      } finally {
        setInstalling('')
      }
    }, [installing, pollInstall, refreshAfterInstall])

    /** 整页刷新后循环断了，用这个单次查询补看进度（不重启轮询，避免两份循环） */
    const peekInstall = useCallback(async () => {
      const jid = installJob && installJob.id
      if (!jid) return
      try {
        const j = await (await fetch(`${API}/job?id=${encodeURIComponent(jid)}`)).json()
        if (!j.ok) throw new Error(j.error || '查询失败')
        setInstallJob((p) => (p ? { ...p, state: j.state, step: j.step, lines: j.lines || [] } : p))
        if (j.state === 'done') await refreshAfterInstall()
      } catch (e) {
        setError(`查询安装进度失败：${e.message || e}`)
      }
    }, [installJob, refreshAfterInstall])

    // 三视图 → AI 那条路：独立的三个槽（与雕刻用的 views 分开，互不干扰），
    // 因为这条路的输入是"给 AI 看的图"，不是"给雕刻用的剪影"。
    const [aiInput, setAiInput] = shared('aiInput', 'single')  // 'single' | 'views'
    const [aiViews, setAiViews] = shared('aiViews', { front: null, side: null, top: null })
    // Hunyuan3D-2mv 专用的四个方位角视角槽（前/左/后/右），与雕刻槽、aiViews 都不共用：
    // 它们的语义不同（那边是"给雕刻用的剪影"和"给单图 AI 用的整图"）。
    const [mvViews, setMvViews] = shared('mvViews', { front: null, left: null, back: null, right: null })

    // 切到多视图模式时自动探一次环境：它的按钮要不要禁用取决于本机显存（见 mvVramTooSmall）。
    // 不探的话，用户第一次进这个模式会看到一个"看起来能用"的按钮 —— 而它在这台机器上不该被点。
    useEffect(() => {
      if (aiInput === 'mv' && !env && !envBusy) loadEnv()
    }, [aiInput, env, envBusy, loadEnv])

    // 视口容器（canvas 由 ThreeViewport 自己创建/替换，见下面 ref 回调处的注释）
    const stageRef = useRef(null)

    /**
     * 容器 ref 回调。**必须是稳定引用**（useCallback []）—— 这一条是血泪。
     *
     * React 对**内联箭头函数**形式的 ref：每次渲染都会把旧的以 null 调一次、再用新的
     * 调一次节点。如果回调里"收到 null 就 dispose"，那么每次重渲染都会把视口拆掉一次：
     *   - 拆掉 = forceContextLoss + 把 canvas 从容器里摘掉
     *   - 而这块 canvas 从此永久废掉（丢失的上下文救不回来，见 viewport.js 文件头）
     *   - 结果就是随机的"视口没了 / 报 precision 错"，取决于重渲染与后续 ensure 的先后
     * 实测：同一个真浏览器用例连跑 3 次，2 次 canvas 为 0（容器是空的），1 次正常 ——
     * 这种"有时好有时坏"的毛病最难查，所以这里写清楚。
     * 用稳定引用后，React 只在**真的挂载/卸载**时调用它。
     */
    const setStage = useCallback((node) => {
      const prev = stageRef.current
      if (prev && prev !== node) {
        try { vpRef.current?.dispose(prev) } catch { /* 忽略 */ }
      }
      stageRef.current = node
      // 挂上就立刻建一次：这样"容器换新节点"也能马上有画布，
      // 不依赖后面的 effect 有没有恰好重跑（ensure 命中缓存时是零成本的）
      if (node && vpRef.current) {
        try { vpRef.current.ensure(node) } catch { /* 失败由 effect 里的横幅兜底 */ }
      }
    }, [])
    const vpRef = useRef(null)
    if (!vpRef.current) vpRef.current = new ThreeViewport()
    // 视口重建的计数器：重试成功后 +1，让"装网格 / 装显示选项"两个 effect 重放一遍
    const [vpEpoch, setVpEpoch] = useState(0)
    const vpEpochRef = useRef(0)
    const optRef = useRef(opt)
    optRef.current = opt
    const viewsRef = useRef(views)
    viewsRef.current = views
    // 导出 JSON 时要报"AI 视图槽里有哪些图"。doExport 的 deps 里不放 aiViews，
    // 所以走 ref 拿最新的（与 optRef/viewsRef 同一个套路）。
    const aiViewsRef = useRef(aiViews)
    aiViewsRef.current = aiViews
    // mode / loadSingle 也走 ref：paste 的 effect 定义在它们前面（而且 loadSingle 是
    // const），直接闭包引用会撞上 TDZ。
    const modeRef = useRef(mode)
    modeRef.current = mode
    const loadSingleRef = useRef(null)
    /** 三视图模式里那个「AI 生成三视图」用的隐藏文件选择框 */
    const aiPickRef = useRef(null)

    // 导出卡：格式 / 文件名 / 目标目录。走 shared 存 —— 关掉面板再打开不用重填。
    const [expOpen, setExpOpen] = useState(false)
    const [expFmt, setExpFmt] = shared('expFmt', 'glb')
    const [expName, setExpName] = shared('expName', 'model')
    const [expDir, setExpDir] = shared('expDir', '')
    // doExport 的依赖里不放这三个，靠 ref 读最新值（否则每次敲字都要重建回调）
    const expNameRef = useRef(expName)
    expNameRef.current = expName
    const expDirRef = useRef(expDir)
    expDirRef.current = expDir

    // 建视口 + 卸载时释放
    useEffect(() => {
      const vp = vpRef.current
      const stage = stageRef.current
      if (!stage) return
      vp.ensure(stage)
      if (vp.ensureError) {
        const msg = String((vp.ensureError && vp.ensureError.message) || vp.ensureError)
        if (diag) diag('vp-fail', msg.slice(0, 160))
        // 交给宿主判断要不要重载页面（它才知道页面级的 WebGL 探测结果）
        if (onViewportDead) { try { onViewportDead(msg) } catch { /* 忽略 */ } }
      } else if (diag) {
        diag('vp-ok', `context created (attrs=${vp.attrsUsed || '?'})`)
      }
      vpEpochRef.current = 0
      return () => vp.dispose(stage)
    }, [])

    /**
     * 重试建视口。
     *
     * 为什么需要这个按钮：`ensure()` 失败后会在 canvas 上留下 `__r3Failed` 标记，
     * 而面板最小化只是 display:none —— canvas 元素从没被卸载，所以"重开面板"根本
     * 不会重新申请上下文，失败就成了永久状态（横幅上那句"重开面板即可恢复"因此是错的，
     * 实测就是这样把人卡住的：GPU 空着，横幅却一直挂着）。
     * 现在：按钮强制清标记重来一次，成功就把模型重新灌进视口、横幅自动消失。
     */
    const retryViewport = useCallback(() => {
      const vp = vpRef.current
      const stage = stageRef.current
      if (!vp || !stage) return
      const ok = vp.ensure(stage, { retry: true })
      if (ok) {
        if (diag) diag('vp-retry-ok', 'context created on retry')
        setStatus('3D 预览已恢复')
        setVpEpoch((e) => e + 1)     // 触发下面两个 effect 重新装载网格与显示选项
      } else {
        const msg = String((vp.ensureError && vp.ensureError.message) || vp.ensureError || '未知原因')
        if (diag) diag('vp-retry-fail', msg.slice(0, 160))
        setError(`3D 预览还是起不来：${msg}`)
        setVpEpoch((e) => e + 1)     // 让横幅上的错误信息刷新
      }
    }, [])

    // 模型变化 → 刷新视口（vpEpoch 让"重试成功"之后能立刻把当前模型重新装进去）
    useEffect(() => {
      const vp = vpRef.current
      const stage = stageRef.current
      if (!vp || !stage) return
      vp.show(stage, mesh)
    }, [mesh, vpEpoch])

    // 显示选项（同样跟着 vpEpoch 重放一次）
    useEffect(() => {
      const vp = vpRef.current
      const stage = stageRef.current
      if (!vp || !stage) return
      vp.setWireframe(stage, opt.wireframe)
      vp.setFlat(stage, opt.flat)
      vp.setAutoRotate(stage, opt.autoRotate)
    }, [opt.wireframe, opt.flat, opt.autoRotate, mesh, vpEpoch])

    // ---- 计算 ----
    const compute = useCallback((nextViews, nextOpt) => {
      const present = VIEW_META.map((m) => m.key).filter((k) => nextViews[k])
      if (!present.length) {
        setMesh(null); setStat(null); setError('')
        setStatus('先拖入至少一张视图')
        return
      }
      setBusy(true)
      setError('')
      setStatus('正在雕刻…')
      // 先让 React 把"计算中"渲染出来，再做同步重活
      setTimeout(() => {
        try {
          const sils = {}
          for (const k of present) sils[k] = nextViews[k].sil
          const t0 = performance.now()
          const built = buildMesh(sils, {
            resolution: nextOpt.resolution,
            padding: nextOpt.padding,
            smooth: nextOpt.smooth,
            removeIslands: nextOpt.removeIslands,
            enforceSymmetry: nextOpt.enforceSymmetry,
          })
          const ms = Math.round(performance.now() - t0)
          setMesh({ positions: built.positions, indices: built.indices })
          setStat({
            ...built.meta,
            ms,
            missing: VIEW_META.map((m) => m.key).filter((k) => !nextViews[k]),
          })
          setStatus(statLine(built.meta, ms))
        } catch (e) {
          setError(e.message || String(e))
          setMesh(null); setStat(null); setStatus('')
        } finally {
          setBusy(false)
        }
      }, 0)
    }, [])

    const statLine = (m, ms) => `${m.vertexCount} 顶点 / ${m.triangleCount} 三角形 · ${ms} ms`

    // ---- 载入视图 ----
    const load = useCallback(async (k, source) => {
      setBusy(true); setError(''); setStatus('读取图片…')
      try {
        const img = await readImage(source)
        const entry = recomputeSil(img, k, optRef.current)
        const next = { ...viewsRef.current, [k]: entry }
        setViews(next)
        compute(next, optRef.current)
      } catch (e) {
        setError(`载入${k}视图失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [compute])

    const clear = useCallback((k) => {
      const next = { ...viewsRef.current, [k]: null }
      setViews(next)
      compute(next, optRef.current)
    }, [compute])

    /** 参数变化后，需要重算剪影（阈值/反相/填洞/镜像影响剪影） */
    const applyOpt = useCallback((nextOpt) => {
      setOpt(nextOpt)
      const vs = viewsRef.current
      let changed = false
      const next = { ...vs }
      for (const { key } of VIEW_META) {
        if (!vs[key]) continue
        next[key] = recomputeSil(vs[key].img, key, nextOpt)
        changed = true
      }
      compute(changed ? next : vs, nextOpt)
      if (changed) setViews(next)
    }, [compute])

    // ---- 剪贴板粘贴（自动填入第一个空槽）----
    useEffect(() => {
      const onPaste = (e) => {
        const items = e.clipboardData?.items
        if (!items) return
        for (const it of items) {
          if (it.type?.startsWith('image/')) {
            const file = it.getAsFile()
            if (!file) continue
            e.preventDefault()
            // 单图模式下去填那个唯一的槽，三视图模式才找空槽
            if (modeRef.current === 'single') {
              if (loadSingleRef.current) loadSingleRef.current(file)
              return
            }
            const vs = viewsRef.current
            const slot = VIEW_META.find((m) => !vs[m.key])
            if (!slot) { setStatus('三个槽都满了，先移除一个再粘贴'); return }
            load(slot.key, file)
            return
          }
        }
      }
      // ⚠ 必须用 **capture 阶段**（第三个参数 true）。
      //
      // 踩过的坑（2026-10-15 在真实 DSH 里实测）：原来注册在冒泡阶段，结果
      // 往面板里 Ctrl+V 时图片**进了聊天输入框**，不是视图槽。
      // 原因：React 17+ 把事件委托挂在 root 容器上，冒泡顺序是
      //     target（输入框） → … → root（React 委托） → … → window
      // 所以 DSH 的输入框先拿到 paste、把图片当附件吃掉，等事件冒泡到 window
      // 时我已经没机会 preventDefault 了。
      // capture 阶段是**从 window 往下**走，window 最先拿到 ⇒ 能抢先拦下。
      window.addEventListener('paste', onPaste, true)
      return () => window.removeEventListener('paste', onPaste, true)
    }, [load])

    // 单图结果出来后，渲染四视角着色图。
    // 后视图不是给雕刻用的（视觉外壳沿同一轴只认一个轮廓，后视图不增加约束），
    // 它是给**人**看的：单图重建的背面全靠先验猜，能不能接受得亲眼看一眼。
    useEffect(() => {
      if (!mesh || !stat || (!stat.fromSingle && !stat.fromHunyuan)) { setSnaps(null); return }
      const vp = vpRef.current
      if (!vp || !vp.snapshot) return
      const out = {}
      let failed = 0
      for (const d of ['front', 'back', 'side', 'top']) {
        try { out[d] = vp.snapshot(mesh, { dir: d, silhouette: false, size: 300 }) } catch { out[d] = null }
        if (!out[d]) failed++
      }
      // 快照失败也要留痕：它不影响主视口（横幅只认 ensureError），但"四视角图拍不出来"
      // 需要能被外部看见，否则又是一次"只有用户看到坏了"的排查
      if (failed && diag) {
        diag('vp-snap-fail', `${failed}/4 张快照拍不出来：${String((vp.snapshotError && vp.snapshotError.message) || vp.snapshotError).slice(0, 140)}`)
      }
      setSnaps(out)
    }, [mesh, stat])

    // ---- 单图 → 3D ----
    //
    // 与三视图那条路的区别：这边**不在浏览器里算**，而是把图丢给 host，由 host 起
    // 本机的 TripoSR（独立 Python 环境）跑推理。跑一张约 1 分钟，所以是"提交任务 →
    // 轮询进度"，不是一次请求等到底（那样 HTTP 会超时）。
    const loadSingle = useCallback(async (source) => {
      setError(''); setBusy(false); setJob(null); setStatus('读取图片…')
      try {
        // ⚠ 这里必须用 toBitmap，不能用 readImage。
        // readImage 返回的是 { data, width, height }（已经抽好的像素缓冲），不是画布
        // 能 drawImage 的图源 —— 用错会直接抛
        // "The provided value is not of type '(CSSImageValue or HTMLCanvasElement or
        //  HTMLImageElement ...)'"。
        const bmp = await toBitmap(source)
        const w = bmp.naturalWidth || bmp.width
        const h = bmp.naturalHeight || bmp.height
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const g = c.getContext('2d')
        // 统一铺一层 0.5 灰底：TripoSR 训练时用的就是灰底（它的 --no-remove-bg 路径
        // 只做 convert("RGB")，会直接丢掉 alpha，透明区会变成黑），所以底色得在这里备好。
        g.fillStyle = '#808080'
        g.fillRect(0, 0, w, h)
        g.drawImage(bmp, 0, 0)
        if (bmp.close && bmp !== source) bmp.close()
        const dataUrl = c.toDataURL('image/png')
        setSingle({ preview: dataUrl, base64: dataUrl.split(',')[1] })
        setStatus('已载入 —— 点「生成 3D 模型」')
      } catch (e) {
        setError(`载入图片失败：${e.message || e}`)
        setStatus('')
      }
    }, [])
    // 交给上面那个 paste effect（它定义得更早，不能直接闭包引用 loadSingle）
    loadSingleRef.current = loadSingle

    /**
     * 把一张图交给 host 跑 TripoSR，轮询到结束，返回 mesh（顺便回报进度）。
     *
     * 抽成 Promise 是因为有两个调用方：单图 AI 模式（出模型直接看），以及三视图模式的
     * 「AI 生成三视图」（出模型后还要投影成剪影再走雕刻）。回调式的话两边各要写一遍轮询。
     */
    const runTripoSR = useCallback(async (imageBase64, onStep) => {
      const r = await fetch(`${API}/single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mcResolution: 192, chunkSize: 200 }),
      })
      const j0 = await r.json()
      if (!j0.ok) throw new Error(j0.error || '提交失败')
      const id = j0.jobId
      if (onStep) onStep({ state: 'running', step: '排队', lines: [] })
      for (;;) {
        await new Promise((res) => setTimeout(res, 1500))
        const r2 = await fetch(`${API}/job?id=${encodeURIComponent(id)}`)
        const j = await r2.json()
        if (!j.ok) throw new Error(j.error || '查询进度失败')
        if (onStep) onStep(j)
        if (j.state === 'error') throw new Error(j.error || '重建失败')
        if (j.state === 'done' && j.result) {
          return {
            positions: new Float32Array(b64ToU8(j.result.positions).buffer),
            indices: new Uint32Array(b64ToU8(j.result.indices).buffer),
            colors: j.result.colors ? b64ToU8(j.result.colors) : null,
            meta: j.result,
          }
        }
      }
    }, [])

    /**
     * 把"单图 AI"类结果（TripoSR / Hunyuan3D）的 meta 转成统计卡要的形状。
     * ⚠ source 参数不能省：统计卡和四视角快照都靠 fromSingle / fromHunyuan 分支，
     * 这里曾经写死 fromSingle: true，导致 Hunyuan3D 的结果被标成"来源 TripoSR"。
     */
    const meshStat = (meta, source = 'triposr') => ({
      vertexCount: meta.vertexCount,
      triangleCount: meta.triangleCount,
      watertight: meta.watertight,
      extent: meta.extents,
      fromSingle: source === 'triposr',
      fromHunyuan: source === 'hunyuan',
    })

    /**
     * 装载 Hunyuan3D-2mv 的一个方位角视角（前/左/后/右）。
     *
     * 与 loadAiView 的区别：**不做灰底处理、不抠图**。mv 要的是"朝向一致、背景干净的
     * 实拍/渲染图"，我们不替用户改像素 —— 改坏了反而更难查（模型看到的和我们存的不一样）。
     * 方形 padding 由 host 侧脚本做（DINOv2 会 resize 到 518²，非方图会被拉伸）。
     */
    const loadMvView = useCallback(async (key, source) => {
      setError('')
      try {
        const bmp = await toBitmap(source)
        const w = bmp.naturalWidth || bmp.width
        const h = bmp.naturalHeight || bmp.height
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const g = c.getContext('2d')
        g.drawImage(bmp, 0, 0)
        if (bmp.close && bmp !== source) bmp.close()
        const dataUrl = c.toDataURL('image/png')
        setMvViews((p) => ({ ...p, [key]: { preview: dataUrl, base64: dataUrl.split(',')[1] } }))
      } catch (e) {
        setError(`载入${key}视角失败：${e.message || e}`)
      }
    }, [])

    /** 装载一张"给 AI 看"的视图（与雕刻槽分开存，带灰底处理） */
    const loadAiView = useCallback(async (key, source) => {
      setError('')
      try {
        const bmp = await toBitmap(source)
        const w = bmp.naturalWidth || bmp.width
        const h = bmp.naturalHeight || bmp.height
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const g = c.getContext('2d')
        g.fillStyle = '#808080'
        g.fillRect(0, 0, w, h)
        g.drawImage(bmp, 0, 0)
        if (bmp.close && bmp !== source) bmp.close()
        const dataUrl = c.toDataURL('image/png')
        setAiViews((p) => ({ ...p, [key]: { preview: dataUrl, base64: dataUrl.split(',')[1] } }))
      } catch (e) {
        setError(`载入${key}视图失败：${e.message || e}`)
      }
    }, [])

    /**
     * 三视图 → AI：每张图各跑一次 TripoSR，再在**体素域里投票融合**。
     *
     * 为什么是"各跑一次再融合"，而不是"把三张图一起喂给模型"：
     *   TripoSR 是单图模型。它接受多图只是"每张独立跑一遍"，不做联合推理 —— 没有任何
     *   现成的多图先验可借。所以只能退一步：让三个视图各自给出一个完整猜测，再用
     *   多数票挑出"至少两个视图都认可"的体积。
     *
     * 为什么不是严格取交集：三个视图里只要有一个 AI 猜歪（单图重建很常见），
     * 严格 AND 会把正确部分也一起削掉。多数票（3 个视图时是 2/3）更抗单点错误。
     */
    const runAiFusion = useCallback(async () => {
      const imgs = VIEW_META.map((m) => aiViews[m.key]).filter(Boolean)
      if (imgs.length < 2) {
        setError('至少要两张视图（只有一张的话，直接用「单图 AI」更省时间）')
        return
      }
      setError(''); setBusy(true); setStatus('提交多视图任务…'); setJob(null)
      try {
        // 1) host 逐张跑 TripoSR
        const r = await fetch(`${API}/multi`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images: imgs.map((v) => v.base64), mcResolution: 160, chunkSize: 200,
          }),
        })
        const j0 = await r.json()
        if (!j0.ok) throw new Error(j0.error || '提交失败')
        const id = j0.jobId
        let meshes = null
        for (;;) {
          await new Promise((res) => setTimeout(res, 1500))
          const r2 = await fetch(`${API}/job?id=${encodeURIComponent(id)}`)
          const j = await r2.json()
          if (!j.ok) throw new Error(j.error || '查询进度失败')
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(`AI：${j.step || '处理中'}`)
          if (j.state === 'error') throw new Error(j.error || '重建失败')
          if (j.state === 'done' && j.result) { meshes = j.result.meshes; break }
        }

        // 2) 融合。三个网格必须先归一化到同一空间，否则是拿三个不同坐标系的东西硬比。
        setStatus('正在融合多个 AI 结果…')
        const RES = 72
        const grids = meshes.map((m) => {
          const pos = normalizeMesh(new Float32Array(b64ToU8(m.positions).buffer))
          const idx = new Uint32Array(b64ToU8(m.indices).buffer)
          return meshToVoxels(pos, idx, RES)
        })
        const merged = mergeVoxelVotes(grids)
        const vm = meshFromVoxels(merged.occupied, merged.nx, merged.ny, merged.nz, { smooth: 1 })
        if (!vm.positions || !vm.positions.length) {
          throw new Error('融合后没有剩下任何体积 —— 说明这几个视图彼此矛盾得太厉害（先试两张图看看）')
        }

        // 按包围盒居中并归一到单位尺寸 —— 照抄 buildMesh 的做法。
        // 这一步顺带消掉了体素坐标的绝对偏移（distanceField 的 pad 会让坐标整体平移），
        // 所以不必去追那个偏移量。
        const positions = vm.positions
        const lo = [Infinity, Infinity, Infinity]
        const hi = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < positions.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            const v = positions[i + k]
            if (v < lo[k]) lo[k] = v
            if (v > hi[k]) hi[k] = v
          }
        }
        const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2
        const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] = (positions[i] - cx) / ext
          positions[i + 1] = (positions[i + 1] - cy) / ext
          positions[i + 2] = (positions[i + 2] - cz) / ext
        }

        setMesh({ positions, indices: vm.indices, colors: null })
        setStat({
          vertexCount: Math.round(positions.length / 3),
          triangleCount: Math.round(vm.indices.length / 3),
          watertight: true,   // surfaceNets 的输出按构造就是闭合流形
          extent: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
          fromFusion: true,
          fusion: merged.stats,
        })
        setBusy(false)
        const s = merged.stats
        setStatus(`融合完成 · ${s.views} 个视图投票，保留 ${s.kept} 体素（一致 ${s.unanimous}，分歧度 ${(s.disagreement * 100).toFixed(1)}%）`)
      } catch (e) {
        setError(`多视图融合失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [aiViews])

    /**
     * Zero123 多视角：一张图 → 三个正交视角 → 填进雕刻槽 → 切到三视图模式。
     *
     * 与「AI 融合」那条路的关键区别：这里**不拿 AI 的 3D 猜测去投票**，
     * 而是只要它生成的**剪影**，再走成熟的视觉外壳。Zero123 的视角定位精度
     * 远高于它各视角之间的像素级一致性，而外壳恰好只需要前者。
     */
    const runZero123 = useCallback(async () => {
      if (!single) return
      setError(''); setJob(null); setBusy(true); setStatus('Zero123 生成中…')
      try {
        const r = await fetch(`${API}/zero123`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: single.base64, freeAfter: opt.autoFree !== false }),
        })
        const j0 = await r.json()
        if (!j0.ok) throw new Error(j0.error || '提交失败')

        let views = null
        for (;;) {
          await new Promise((res) => setTimeout(res, 1500))
          const jr = await fetch(`${API}/job?id=${encodeURIComponent(j0.jobId)}`)
          const j = await jr.json()
          if (!j.ok) throw new Error(j.error || '查询进度失败')
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(`Zero123：${j.step || '处理中'}`)
          if (j.state === 'error') throw new Error(j.error || '生成失败')
          if (j.state === 'done' && j.result) { views = j.result.views; break }
        }

        const next = { ...viewsRef.current }
        for (const k of ['front', 'side', 'top']) {
          // ⚠ recomputeSil 要的是 { data, width, height } 像素缓冲（readImage 的产物），
          // 直接塞 HTMLImageElement 会报 "silhouette: 图像数据无效"。
          // 这个错我在 loadSingle 里已经犯过一次，这次是同一个坑。
          const im = new Image()
          im.src = `data:image/png;base64,${views[k]}`
          await im.decode().catch(() => {})
          // bgFlood 必须开：Zero123 出的是白底插画，白裙子会被亮度阈值挖空
          next[k] = recomputeSil(await readImage(im), k, { ...optRef.current, bgFlood: true })
        }
        setViews(next)
        setMode('views')
        compute(next, optRef.current)
        setStatus('Zero123 三视角已填入雕刻槽 —— 可调参数重新雕刻')
      } catch (e) {
        setError(`Zero123 失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [single, compute, opt])

    /**
     * Hunyuan3D-2：一张图 → 精细 3D 网格，直接放进视口。
     *
     * 与 Zero123 那条路的区别：这个模型在三维空间里直接生成，不存在"各视角互相矛盾"，
     * 几何也细得多（实测 19 万顶点 / 52 万三角形 vs Zero123+外壳的 5 万顶点）。
     * 代价：约 130 秒，而且没有颜色（要上色得另跑 ComfyUI 的 PaintMesh）。
     */
    const runHunyuan = useCallback(async () => {
      if (!single) return
      setError(''); setJob(null); setBusy(true)
      setStatus('Hunyuan3D 生成中…（约 130 秒）')
      try {
        const r = await fetch(`${API}/hunyuan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: single.base64, freeAfter: opt.autoFree !== false }),
        })
        const j0 = await r.json()
        if (!j0.ok) throw new Error(j0.error || '提交失败')

        let mesh = null
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000))
          const jr = await fetch(`${API}/job?id=${encodeURIComponent(j0.jobId)}`)
          const j = await jr.json()
          if (!j.ok) throw new Error(j.error || '查询进度失败')
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(`Hunyuan3D：${j.step || '处理中'}`)
          if (j.state === 'error') throw new Error(j.error || '生成失败')
          if (j.state === 'done' && j.result) { mesh = j.result.mesh; break }
        }

        setMesh({
          positions: new Float32Array(b64ToU8(mesh.positions).buffer),
          indices: new Uint32Array(b64ToU8(mesh.indices).buffer),
          colors: null,
        })
        setStat(meshStat(mesh, 'hunyuan'))
        setJob((p) => (p ? { ...p, state: 'done' } : p))
        setBusy(false)
        setStatus(`Hunyuan3D 完成 · ${mesh.vertexCount} 顶点 / ${mesh.triangleCount} 三角形`)
      } catch (e) {
        setError(`Hunyuan3D 失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [single, opt])

    /**
     * Hunyuan3D-2mv：**多视角一起推理** → 精细 3D 网格。
     *
     * 与单图版的唯一实质差别是条件构造：模型把每个视角的 DINOv2 特征加上"第几个视角"
     * 的位置编码后拼成一条条件序列（顺序固定 front→left→back→right，见 host 侧脚本注释）。
     * 所以视角**顺序和命名**是有语义的，不能乱给：给错不会报错，只会生成一个视角错位的模型。
     *
     * ⚠ mv 没有"俯视"槽 —— 它的四个视角是绕物体一圈的方位角视角。面板上那三个雕刻槽
     *   （前/侧/俯）不能用，所以这里有一套独立的四个槽（mvViews）。
     */
    const runHunyuanMv = useCallback(async () => {
      const given = MV_VIEWS.filter((v) => mvViews[v.key] && mvViews[v.key].base64)
      if (!given.length) { setError('至少要给一个视角（前/左/后/右）'); return }
      setError(''); setJob(null); setBusy(true)
      setStatus(`Hunyuan3D-2mv 生成中…（${given.length} 个视角，约 130 秒）`)
      try {
        const images = {}
        for (const v of given) images[v.key] = mvViews[v.key].base64
        const r = await fetch(`${API}/hunyuan-mv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images, freeAfter: opt.autoFree !== false }),
        })
        const j0 = await r.json()
        if (!j0.ok) throw new Error(j0.error || '提交失败')

        let mesh = null
        for (;;) {
          await new Promise((res) => setTimeout(res, 2000))
          const jr = await fetch(`${API}/job?id=${encodeURIComponent(j0.jobId)}`)
          const j = await jr.json()
          if (!j.ok) throw new Error(j.error || '查询进度失败')
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(`Hunyuan3D-2mv：${j.step || '处理中'}`)
          if (j.state === 'error') throw new Error(j.error || '生成失败')
          if (j.state === 'done' && j.result) { mesh = j.result.mesh; break }
        }

        setMesh({
          positions: new Float32Array(b64ToU8(mesh.positions).buffer),
          indices: new Uint32Array(b64ToU8(mesh.indices).buffer),
          colors: null,
        })
        setStat(meshStat(mesh, 'hunyuan'))
        setJob((p) => (p ? { ...p, state: 'done' } : p))
        setBusy(false)
        setStatus(`Hunyuan3D-2mv 完成 · ${mesh.vertexCount} 顶点 / ${mesh.triangleCount} 三角形`
          + `（视角 ${(mesh.views || given.map((v) => v.key)).join('/')}）`)
      } catch (e) {
        setError(`Hunyuan3D-2mv 失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [mvViews, opt])

    /** 单图 AI 模式：出模型直接看 */
    const runSingle = useCallback(async () => {
      if (!single) return
      setError(''); setJob(null); setBusy(true); setStatus('提交任务…')
      try {
        const out = await runTripoSR(single.base64, (j) => {
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(j.step || '推理中…')
        })
        setMesh({ positions: out.positions, indices: out.indices, colors: out.colors })
        setStat(meshStat(out.meta))
        setJob((p) => (p ? { ...p, state: 'done' } : p))
        setBusy(false)
        setStatus(`单图重建完成 · ${out.meta.vertexCount} 顶点 / ${out.meta.triangleCount} 三角形`)
      } catch (e) {
        setError(`重建失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [single, runTripoSR])

    /**
     * 把模型投影成前/侧/俯三张**剪影**，填进三个雕刻槽。
     *
     * 为什么绕这一步而不是直接把 mesh 当结果：视觉外壳要的是剪影。而且这三张图**来自
     * 同一个 3D 模型**，比例与特征必然自洽 —— 这正好绕开"AI 分别生成三张图、彼此对不上、
     * 雕出来是歪的"那个坑（插件里那句 viewConsistency 检查就是为此而加）。
     */
    const projectToViews = useCallback(async (srcMesh, { silent = false } = {}) => {
      const m = srcMesh || mesh
      if (!m) return false
      const vp = vpRef.current
      if (!vp || !vp.snapshot) return false
      setBusy(true)
      try {
        const next = { ...viewsRef.current }
        for (const [key, dir] of [['front', 'front'], ['side', 'side'], ['top', 'top']]) {
          const url = vp.snapshot(m, { dir, silhouette: true, size: 512 })
          if (!url) continue
          const img = new Image()
          img.src = url
          await img.decode().catch(() => {})
          next[key] = recomputeSil(img, key, optRef.current)
        }
        setViews(next)
        if (!silent) setStatus('已按模型投影出前/侧/俯三视图 —— 可调参数重新雕刻')
        compute(next, optRef.current)
        return true
      } catch (e) {
        setError(`投影三视图失败：${e.message || e}`)
        setBusy(false)
        return false
      }
    }, [mesh, compute])

    /** 三视图模式的「AI 生成三视图」：一张图 → TripoSR → 投影 → 填满三个槽 */
    const runAiToViews = useCallback(async () => {
      if (!single) return
      setError(''); setBusy(true); setStatus('AI 生成中…'); setJob(null)
      try {
        const out = await runTripoSR(single.base64, (j) => {
          setJob({ id: j.id, state: j.state, step: j.step, lines: j.lines || [] })
          setStatus(`AI：${j.step || '推理中'}`)
        })
        const m = { positions: out.positions, indices: out.indices, colors: out.colors }
        setMesh(m)
        setStat(meshStat(out.meta))
        setJob((p) => (p ? { ...p, state: 'done' } : p))
        await projectToViews(m, { silent: true })
        setStatus('AI 已生成前/侧/俯三视图（同一模型投影，天然自洽）—— 可调参数重新雕刻')
      } catch (e) {
        setError(`AI 生成失败：${e.message || e}`)
        setBusy(false); setStatus('')
      }
    }, [single, runTripoSR, projectToViews])

    // ---- 导出 ----
    /**
     * 来源标签：按**实际产出这个网格的那条路**判断（stat 上的标记是各条路自己打的），
     * 而不是按当前 UI 模式 —— 生成完 Hunyuan 再把下拉切回"三视图"时，网格并没有变。
     */
    const sourceLabel = () => (
      stat && stat.fromFusion ? 'views-ai-fusion'
        : stat && stat.fromHunyuan ? 'hunyuan3d-2'
          : stat && stat.fromSingle ? 'triposr'
            : 'views-carve'
    )

    /** 导出 JSON 时要带上的雕刻参数（wireframe/flat/autoRotate 是显示选项，与几何无关，剔掉） */
    const geomParams = () => {
      const o = optRef.current || {}
      const keys = ['resolution', 'padding', 'smooth', 'threshold', 'auto', 'invert',
        'fillHoles', 'mirrorSide', 'enforceSymmetry', 'removeIslands']
      const out = {}
      for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
      return out
    }

    /** 触发浏览器下载（没有任何本地目标时用这条） */
    const downloadBlob = (name, blob) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }

    /** 导出格式表（顺序 = 下拉里的顺序；mime 给 showSaveFilePicker 和 Blob 用） */
    const EXPORT_FORMATS = [
      { v: 'gltf', label: 'glTF (.gltf，文本、单文件内嵌）', ext: 'gltf', mime: 'model/gltf+json' },
      { v: 'glb', label: 'GLB (.glb，二进制，体积最小）', ext: 'glb', mime: 'model/gltf-binary' },
      { v: 'json', label: 'JSON (.json，数据转储＋参数统计）', ext: 'json', mime: 'application/json' },
      { v: 'obj', label: 'OBJ (.obj，通用交换）', ext: 'obj', mime: 'text/plain' },
      { v: 'stl', label: 'STL 二进制 (.stl，3D 打印）', ext: 'stl', mime: 'model/stl' },
      { v: 'stl-ascii', label: 'STL ASCII (.stl，可读）', ext: 'stl', mime: 'model/stl' },
    ]

    /**
     * 文件名净化。host 落盘时也会再净化一次，这里做是**为了系统对话框**：
     * `showSaveFilePicker({suggestedName})` 里带 `/` 或 `\` 会直接抛 TypeError，
     * 而不是给出一个友好的错误 —— 用户只会看到"导出失败"。
     */
    const safeName = () => (
      String(expNameRef.current || 'model').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'model'
    )

    /**
     * 按当前格式生成要写出去的数据。
     *
     * 返回 `{ blob, bytes }`：bytes 是原始字节（host 落盘时按 base64 传），
     * blob 是给浏览器/File System Access 用的。
     */
    const buildExport = useCallback(async (fmt) => {
      const base = safeName()
      if (fmt === 'json') {
        const v = viewsRef.current || {}
        const json = toMeshJSON(mesh.positions, mesh.indices, {
          name: base,
          source: sourceLabel(),
          stats: stat || null,
          params: geomParams(),
          // 只记"哪些槽有图"，不塞图片本身（base64 一进去文件就废了）
          inputs: {
            carvingViews: { front: !!v.front, side: !!v.side, top: !!v.top },
            aiViews: Object.keys(aiViewsRef.current || {}).filter((k) => aiViewsRef.current[k]),
          },
        })
        return { blob: new Blob([json], { type: 'application/json' }), bytes: new TextEncoder().encode(json) }
      }
      if (fmt === 'gltf') {
        const s = toGLTF(mesh.positions, mesh.indices, base)
        return { blob: new Blob([s], { type: 'model/gltf+json' }), bytes: new TextEncoder().encode(s) }
      }
      if (fmt === 'glb') {
        const u8 = toGLB(mesh.positions, mesh.indices, base)
        return { blob: new Blob([u8], { type: 'model/gltf-binary' }), bytes: u8 }
      }
      if (fmt === 'obj') {
        const s = toOBJ(mesh.positions, mesh.indices, base)
        return { blob: new Blob([s], { type: 'text/plain' }), bytes: new TextEncoder().encode(s) }
      }
      if (fmt === 'stl') {
        const u8 = toSTLBinary(mesh.positions, mesh.indices, base)
        return { blob: new Blob([u8], { type: 'model/stl' }), bytes: u8 }
      }
      const s = toSTLAscii(mesh.positions, mesh.indices, base)
      return { blob: new Blob([s], { type: 'model/stl' }), bytes: new TextEncoder().encode(s) }
    }, [mesh, stat])

    /** 写进"已选的本地目录"（host 落盘；重名不覆盖，host 会自己编号） */
    const exportToDir = useCallback(async (fmt, bytes) => {
      setStatus('写入本地目录…')
      const r = await fetch(`${API}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: expDirRef.current, name: safeName(), format: fmt,
          dataBase64: bytesToBase64(bytes),
        }),
      })
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
      if (!j.ok) throw new Error(j.error || '写入失败')
      if (diag) diag('export-dir', `${fmt} → ${j.file} (${j.bytes}B)`)
      setStatus(`已保存：${j.file}（${(j.bytes / 1024).toFixed(0)} KB）`)
      return j.file
    }, [])

    /**
     * 另存为：走浏览器的 File System Access API（真正的系统保存对话框，能选文件夹也能改文件名）。
     * 探测过这台机器上 `showSaveFilePicker` 是有的（diag 的 save-targets 记录）；
     * 没有的环境就退化成浏览器下载 —— 用户至少还能拿到文件。
     */
    const exportSaveAs = useCallback(async (fmt, meta, blob) => {
      const fname = `${safeName()}.${meta.ext}`
      if (typeof window.showSaveFilePicker !== 'function') {
        downloadBlob(fname, blob)
        setStatus(`已下载 ${fname}（本环境没有系统保存对话框）`)
        return 'download'
      }
      const handle = await window.showSaveFilePicker({
        suggestedName: fname,
        types: [{ description: meta.label, accept: { [meta.mime]: ['.' + meta.ext] } }],
      })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      if (diag) diag('export-saveas', `${fmt} → ${handle.name}`)
      setStatus(`已保存：${handle.name}`)
      return 'saved'
    }, [])

    /**
     * 导出主入口。
     *
     * 目标优先级（都是"用户明确给过的位置"才用）：
     *   1. 已选本地目录 → host 落盘（可重复导出，不再弹窗）
     *   2. 系统保存对话框（另存为）
     *   3. 浏览器下载（兜底，任何环境都能拿到文件）
     * `saveAs=true` 时跳过第 1 步，强制走对话框。
     */
    const doExport = useCallback(async (fmt, saveAs = false) => {
      if (!mesh) return
      const meta = EXPORT_FORMATS.find((f) => f.v === fmt) || EXPORT_FORMATS[1]
      setError('')
      try {
        setStatus('正在生成…')
        const { blob, bytes } = await buildExport(fmt)
        if (!saveAs && expDirRef.current) {
          try {
            await exportToDir(fmt, bytes)
            return
          } catch (e) {
            // 目录不可用（被删了/没权限）不能就这么算了：清掉它，退到对话框
            setError(`写入目录失败（已改为另存为）：${e.message || e}`)
            setExpDir('')
          }
        }
        if (onExport && !saveAs) {
          const r = await onExport(fmt, mesh, stat)
          setStatus(r || `已保存 ${fmt.toUpperCase()}`)
          return
        }
        try {
          await exportSaveAs(fmt, meta, blob)
        } catch (e) {
          if (e && e.name === 'AbortError') { setStatus('已取消'); return }
          // 对话框本身失败（比如被外壳拦住）：退回下载，别让用户白点一次
          if (diag) diag('export-saveas-fail', String((e && e.message) || e).slice(0, 120))
          const fname = `${safeName()}.${meta.ext}`
          downloadBlob(fname, blob)
          setStatus(`已下载 ${fname}（系统保存对话框不可用：${(e && e.message) || e}）`)
        }
      } catch (e) {
        setError(`导出失败：${e.message || e}`)
      }
    }, [mesh, stat, buildExport, exportToDir, exportSaveAs, onExport])

    /** 选择本地目录：优先 DSH 原生选择器；没有就让用户手填绝对路径 */
    const pickExportDir = useCallback(async () => {
      if (!pickDirectory) {
        setError('这个环境没有原生目录选择器，请在下面的输入框里直接填绝对路径')
        return
      }
      try {
        const p = await pickDirectory()
        if (p) { setExpDir(p); setStatus(`导出目录：${p}`) }
      } catch (e) {
        setError(`选择目录失败：${e.message || e}（也可以直接填绝对路径）`)
      }
    }, [pickDirectory])

    const fitted = useMemo(() => !!(mesh && mesh.indices.length), [mesh])

    return el('div', { style: styles.wrap },
      // 顶栏压成一行：标题 · 当前模式说明 · 状态。
      // （原来是 strong + 说明两个块，行高叠起来白占十来像素；说明也不再写死 TripoSR ——
      //   现在模型是可选的。）
      el('div', { style: { ...styles.row, justifyContent: 'space-between', gap: 10 } },
        el('span', { style: { fontSize: 12.5, fontWeight: 600, flex: '0 0 auto' } },
          mode === 'views' ? '三视图建模' : '单图 AI 建模'),
        el('span', {
          style: {
            fontSize: 11.5, opacity: 0.5, flex: '1 1 auto', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, mode === 'views' ? '拖入前 / 侧 / 俯三张图 → 自动雕刻' : '拖入一张图 → 由所选模型重建'),
        el('span', { style: { fontSize: 11, opacity: 0.6, flex: '0 0 auto' } },
          busy ? '● 处理中' : status),
      ),

      // 模式切换。两条路各有取舍，所以都留着而不是替换掉：
      //   三视图 = 纯几何、可控、精确，但要求你手上有正交三视图；
      //   单图   = 门槛低，一张立绘就行，但看不到的背面全靠先验猜，细节会糊。
      el('div', { style: { ...styles.row, gap: 6 } },
        el('button', {
          style: mode === 'views' ? styles.btnOn : styles.btn,
          onClick: () => { setMode('views'); setError(''); setStatus('') },
        }, '三视图（前/侧/俯）'),
        el('button', {
          style: mode === 'single' ? styles.btnOn : styles.btn,
          title: '单张图交给本机 TripoSR 重建 —— 背面靠先验猜，细节不如三视图路',
          onClick: () => { setMode('single'); setError(''); setStatus('') },
        }, '单图 AI（TripoSR）'),
      ),

      error ? el('div', { style: styles.err }, error) : null,

      // 三视图尺寸不自洽 ⇒ 模型被非等比拉伸。以前这种情况是**静默**的：
      // 用户看到形状不对，却不知道是自己三张图的尺寸不匹配。
      // （由独立审查指出，连仓库自带夹具都踩了这条）
      mode === 'views' && stat && stat.viewConsistency && stat.viewConsistency.stretched
        ? el('div', { style: styles.warn },
            el('strong', null, '⚠ 三视图尺寸不自洽，模型已被拉伸。'),
            el('div', { style: { marginTop: 4, fontSize: 11.5, opacity: 0.9 } }, stat.viewConsistency.warning),
          )
        : null,

      mode === 'views'
        ? el(React.Fragment, null,
            el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 } },
              VIEW_META.map((meta) => el(ViewSlot, {
                key: meta.key, meta,
                view: views[meta.key],
                onFile: (f) => load(meta.key, f),
                onClear: () => clear(meta.key),
              })),
            ),

            // AI 辅助：不想手画三视图的话，丢一张图给本机 TripoSR，再把它投影成三视图。
            // 投影出来三张图来自同一个 3D 模型，所以比例/特征天然自洽 —— 这正是
            // "AI 分别画三张图"做不到的地方。
            el('div', { style: styles.card },
              el('div', { style: { ...styles.row, justifyContent: 'space-between', marginBottom: 6 } },
                el('span', { style: { fontSize: 12, fontWeight: 600 } }, 'AI 生成三视图'),
                el('span', { style: { fontSize: 11, opacity: 0.55 } }, '不想手画三视图？给一张图，AI 出模型后投影成三视图'),
              ),
              el('div', { style: { ...styles.row, gap: 8, flexWrap: 'wrap' } },
                single
                  ? el('img', {
                      src: single.preview, alt: '参考图',
                      style: { height: 48, borderRadius: 6, border: '1px solid rgba(130,150,190,.35)' },
                    })
                  : null,
                el('button', {
                  style: styles.btn,
                  onClick: () => aiPickRef.current?.click(),
                }, single ? '换一张图' : '选择参考图'),
                el('button', {
                  style: single && !busy ? styles.btnOn : styles.btn,
                  disabled: !single || busy,
                  onClick: runAiToViews,
                }, busy ? '生成中…' : 'AI 生成三视图'),
                el('span', { style: { flex: 1 } }),
                el('span', { style: { fontSize: 11, opacity: 0.55 } }, '约 1 分钟'),
              ),
              job && job.lines && job.lines.length
                ? el('div', {
                    style: { ...styles.mono, marginTop: 6, maxHeight: 66, overflow: 'auto', opacity: 0.7 },
                  }, job.lines.slice(-6).join('\n'))
                : null,
              el('input', {
                ref: aiPickRef, type: 'file', accept: 'image/*', style: { display: 'none' },
                onChange: (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  // 只装载，不切模式 —— 这是三视图模式里的 AI 区，切走就南辕北辙了
                  if (f) loadSingle(f)
                },
              }),
            ),
          )
        : el(React.Fragment, null,
            // 模型选择：一个下拉代替原先那一排按钮 —— 省纵向空间，以后加模型也不用再动 UI。
            // option 的 value 沿用既有的 aiInput 取值（single / zero123 / hunyuan / views），
            // 所以下面几段输入区逻辑完全不用改。
            el('div', { style: { ...styles.row, gap: 8 } },
              el('span', { style: { fontSize: 12, opacity: 0.7, flex: '0 0 auto' } }, '模型'),
              el('select', {
                value: aiInput,
                onChange: (e) => setAiInput(e.target.value),
                title: '换一个建模 AI —— 各自需要的输入、耗时和擅长的东西都不一样',
                style: {
                  flex: '1 1 auto', minWidth: 0, padding: '4px 8px', borderRadius: 7,
                  border: '1px solid rgba(130,150,190,.38)',
                  background: 'rgba(120,150,200,.10)', color: 'inherit',
                  font: 'inherit', fontSize: 12, cursor: 'pointer',
                },
              },
                AI_MODELS.map((m) => el('option', {
                  key: m.v, value: m.v,
                  // 深色主题下原生下拉列表通常用系统配色，显式给个深色底免得白底白字
                  style: { color: '#e6edf7', background: '#161c26' },
                }, m.label + (availOf(m.v) === false ? '  ·  未安装' : ''))),
              ),
              el(Toggle, {
                label: '自动卸载模型', k: 'autoFree', opt, setOpt,
                title: 'AI 任务跑完就卸载模型并清空显存缓存。8G 卡上常和别的任务（比如模型训练）'
                  + '抢显存，用完立刻还回去更省心；关掉则只靠进程退出时自然释放。',
              }),
              el('button', {
                style: styles.btn,
                title: '看看这台机器能跑哪些模型、已经装了什么、还缺什么（只读探测，不装不改）',
                onClick: () => { setShowEnv((v) => !v); if (!env && !envBusy) loadEnv() },
              }, showEnv ? '收起环境' : '环境与模型'),
            ),
            // 当前模型的一句话说明（替代原来挤在按钮行右边的小字）
            el('div', { style: { fontSize: 11.5, opacity: 0.6, marginTop: 4 } },
              (AI_MODELS.find((m) => m.v === aiInput) || AI_MODELS[0]).note),

            // 下载要跑十几分钟，面板收起来也得看得见 —— 一行就够，不占地方
            installJob && installJob.state === 'running' && installJob.id
              ? el('div', { style: { fontSize: 11, color: '#ffd479', marginTop: 3 } },
                  `⬇ 正在下载权重：${installJob.step || '…'}`)
              : null,

            // ---- 环境与模型适配（按需展开；纯只读探测：不装、不改、不下载）----
            showEnv
              ? el('div', { style: { ...styles.card, marginTop: 8 } },
                  envBusy
                    ? el('div', { style: { fontSize: 12, opacity: 0.7 } }, '正在探测本机环境…')
                    : env
                    ? el(React.Fragment, null,
                        el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                          '本机环境',
                          el('span', { style: { fontWeight: 400, opacity: 0.55, marginLeft: 6 } }, '只读探测'),
                        ),
                        el('div', { style: { ...styles.mono, fontSize: 11.5, lineHeight: 1.75 } },
                          `GPU   ${env.environment.gpu[0]
                            ? `${env.environment.gpu[0].name} · ${Math.round(env.environment.gpu[0].totalMB / 1024)}G（空闲 ${Math.round(env.environment.gpu[0].freeMB / 1024)}G）`
                            : '未检测到独显'}\n`
                          + `内存  ${Math.round(env.environment.memory.totalMB / 1024)}G（空闲 ${Math.round(env.environment.memory.freeMB / 1024)}G）\n`
                          + `磁盘  ${env.environment.disks.map((d) => `${d.drive}: ${d.freeGB}G`).join(' · ')}\n`
                          + `ComfyUI  ${env.environment.comfyui.exists ? `${env.environment.comfyui.capabilities.length} 项 3D 能力` : '未找到'}`,
                        ),
                        // ---- 运行环境（非权重前置）：缺这些的话，权重装好了也跑不了 ----
                        env.checklist
                          ? el('div', { style: { marginTop: 10 } },
                              el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } },
                                '运行环境',
                                el('span', { style: { fontWeight: 400, opacity: 0.55, marginLeft: 6 } },
                                  env.checklist.ok ? '就绪' : '缺前置条件'),
                              ),
                              el('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                                env.checklist.items.map((it) => el('div', {
                                  key: it.id, style: { fontSize: 11.5, lineHeight: 1.6 },
                                },
                                  el('span', { style: { color: it.ok ? '#8ee6a8' : '#ff9c9c', marginRight: 6 } },
                                    it.ok ? '✓' : '✗'),
                                  el('strong', null, it.label),
                                  it.ok ? null : el('span', { style: { opacity: 0.75 } }, ` — ${it.detail}`),
                                  el('span', {
                                    title: it.why, style: { opacity: 0.45, cursor: 'help', marginLeft: 4 },
                                  }, '?'),
                                )),
                              ),
                              // 缺项时**直接把"要下什么"摊出来**：名称 + 体积 + 下载源，
                              // 不用点开命令、也不用去翻 README 才知道该准备什么。
                              env.checklist.items.some((it) => !it.ok)
                                ? el('div', { style: { marginTop: 6, fontSize: 11, opacity: 0.85 } },
                                    el('div', { style: { fontWeight: 600, marginBottom: 3 } }, '缺什么 / 要下什么：'),
                                    env.checklist.items.filter((it) => !it.ok).map((it) => el('div', {
                                      key: it.id, style: { marginBottom: 4 },
                                    },
                                      el('div', null, `· ${it.label} —— ${it.detail}`),
                                      it.note
                                        ? el('div', { style: { paddingLeft: 10, opacity: 0.8 } }, it.note)
                                        : null,
                                      (it.need || []).map((n, i) => el('div', {
                                        key: i, style: { paddingLeft: 10, opacity: 0.8 },
                                      }, `↳ 需下载 ${n.name}（${n.from}）`)),
                                    )),
                                  )
                                : null,
                              el('div', { style: { marginTop: 5, fontSize: 11, opacity: 0.65 } },
                                env.checklist.ok
                                  ? '运行环境齐了；权重在下面按模型安装即可。'
                                  : '一键安装只下载权重，不含上面这些运行时 —— 先备环境，再装权重。'),
                              !env.checklist.ok
                                ? el('button', {
                                    style: { ...styles.btn, marginTop: 6, padding: '2px 10px', fontSize: 11 },
                                    disabled: setupBusy,
                                    title: '生成一条可直接粘到终端的检查命令；加 -Apply 只做脚本/源码/权重这些安全步骤',
                                    onClick: loadSetupInfo,
                                  }, setupBusy ? '获取中…' : '生成安装命令')
                                : null,
                              setupInfo
                                ? el('div', {
                                    style: { marginTop: 6, padding: 6, background: '#0c1118', borderRadius: 4 },
                                  },
                                    el('div', { style: { fontSize: 11, opacity: 0.7, marginBottom: 4 } },
                                      `粘到终端里跑（脚本 ${setupInfo.scriptExists ? '已随包提供' : '缺失！'}）：`),
                                    el('div', {
                                      style: {
                                        ...styles.mono, fontSize: 10.5,
                                        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                      },
                                    }, setupInfo.check),
                                    el('button', {
                                      style: { ...styles.btn, marginTop: 4, padding: '1px 8px', fontSize: 10.5 },
                                      onClick: () => {
                                        try { navigator.clipboard.writeText(setupInfo.check) } catch { /* 忽略 */ }
                                      },
                                    }, '复制命令'),
                                    el('div', { style: { fontSize: 10.5, opacity: 0.6, marginTop: 3 } },
                                      '默认只检查；加 -Apply 才会动手，而且只做脚本 / TripoSR 源码 / 权重。'),
                                  )
                                : null,
                            )
                          : null,
                        el('div', { style: { fontSize: 12, fontWeight: 600, margin: '10px 0 6px' } }, '建模 AI 适配情况'),
                        el('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                          env.recommendations.map((r) => {
                            const plan = (env.plans || []).find((p) => p.id === r.id)
                            const jb = installJob && installJob.provider === r.id ? installJob : null
                            const busyThis = installing === r.id
                            return el('div', { key: r.id, style: { fontSize: 11.5, lineHeight: 1.6 } },
                              el('span', {
                                style: {
                                  display: 'inline-block', minWidth: 52, marginRight: 6,
                                  color: r.verdict === 'ready' ? '#8ee6a8'
                                    : r.verdict === 'installable' ? '#ffd479' : '#ff9c9c',
                                },
                              }, r.verdict === 'ready' ? '已就绪' : r.verdict === 'installable' ? '可安装' : '跑不动'),
                              el('strong', null, r.label),
                              r.blockers.length ? el('span', { style: { opacity: 0.75 } }, ` — ${r.blockers.join('；')}`) : null,
                              r.missing.length ? el('span', { style: { opacity: 0.6 } }, ` — 缺 ${r.missing.join(' / ')}`) : null,
                              // 只给"能跑"的模型装（plan 由 host 给，客户端不硬编码体积/路径）。
                              // 已就绪的也给一个「校验/重装」—— 逐个核对精确字节数，只有缺的或
                              // 大小不符的才会真下载，健康的安装点一下就是几百毫秒的空转。
                              plan && (r.verdict === 'installable' || r.verdict === 'ready')
                                ? (() => {
                                    // ⚠ 一键安装**只下载权重文件**，不含 Python 环境 / ComfyUI / 推理脚本。
                                    //   所以缺运行时（python、推理脚本）时不给下载按钮 —— 否则用户会先下
                                    //   9~14 GiB 才发现根本跑不了，这是最糟的体验。判据来自 host 的 missing 标签。
                                    const rt = (Array.isArray(r.missing) ? r.missing : [])
                                      .filter((m) => /python|脚本|comfyui/i.test(m)
                                        && !/权重|ckpt|safetensors/i.test(m))
                                    if (rt.length) {
                                      return el('span', {
                                        style: { marginLeft: 8, fontSize: 11, color: '#ffd479', cursor: 'help' },
                                        title: `缺运行时：${rt.join('；')}。一键安装只下载权重文件，`
                                          + '不含 Python 环境与推理脚本；请先按 README 第 2 节备好运行环境。',
                                      }, '先备运行环境')
                                    }
                                    return el('button', {
                                      style: {
                                        ...styles.btn, marginLeft: 8, padding: '1px 8px', fontSize: 11,
                                        ...(busyThis ? styles.btnOn : null),
                                      },
                                      disabled: !!installing,
                                      title: (r.verdict === 'ready'
                                        ? `核对 ${plan.dir} 里的文件字节数，缺的/大小不符的才会下载（共 ${plan.totalGB} GiB，`
                                          + '支持断点续传）'
                                        : `下载到 ${plan.dir}（${plan.totalGB} GiB，`
                                          + `${plan.steps.length} 个文件，支持断点续传；已下好的会跳过）`)
                                        + '；仅下载权重文件，不含 Python 环境 / 推理脚本。',
                                      onClick: () => runInstall(r.id),
                                    }, busyThis ? '下载中…'
                                      : r.verdict === 'ready' ? '校验/重装' : `一键安装 ${plan.totalGB}G`)
                                  })()
                                : null,
                              jb
                                ? el('div', { style: { marginTop: 3 } },
                                    el('div', {
                                      style: {
                                        ...styles.mono, fontSize: 11, opacity: 0.72,
                                        maxHeight: 52, overflow: 'auto', whiteSpace: 'pre-wrap',
                                      },
                                    }, `${jb.step || ''}\n${(jb.lines || []).slice(-4).join('\n')}`),
                                    jb.state === 'running' && jb.id
                                      ? el('button', {
                                          style: { ...styles.btn, padding: '0 6px', fontSize: 10.5, marginTop: 2 },
                                          onClick: peekInstall,
                                        }, '刷新进度')
                                      : null,
                                    jb.state === 'done'
                                      ? el('div', { style: { fontSize: 11, color: '#8ee6a8' } }, '✓ 下载完成')
                                      : null,
                                    jb.state === 'error'
                                      ? el('div', { style: { fontSize: 11, color: '#ff9c9c' } }, '下载中断 —— 再点一次安装可续传')
                                      : null,
                                  )
                                : null,
                            )
                          }),
                        ),
                      )
                    : el('div', { style: { fontSize: 12, opacity: 0.7 } }, '正在准备…'),
                )
              : null,

            aiInput === 'single'
              ? el(SingleSlot, {
                  single, job,
                  onFile: loadSingle,
                  onClear: () => { setSingle(null); setJob(null); setStatus('') },
                  onRun: runSingle,
                })
              : aiInput === 'zero123'
              ? el('div', { style: styles.card },
                  el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                    'Zero123 的输入（一张图）',
                    el('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 6 } },
                      '绕着生成前/侧/俯，再走视觉外壳'),
                  ),
                  el('div', { style: { ...styles.row, gap: 8, flexWrap: 'wrap' } },
                    single
                      ? el('img', {
                          src: single.preview, alt: '输入图',
                          style: { height: 56, borderRadius: 6, border: '1px solid rgba(130,150,190,.35)' },
                        })
                      : null,
                    el('button', { style: styles.btn, onClick: () => aiPickRef.current?.click() },
                      single ? '换一张图' : '选择参考图'),
                    el('button', {
                      style: single && !busy ? styles.btnOn : styles.btn,
                      disabled: !single || busy,
                      onClick: runZero123,
                    }, busy ? '生成中…' : '生成三视角并雕刻'),
                    el('span', { style: { fontSize: 11, opacity: 0.6 } }, '约 40 秒'),
                  ),
                  job && job.lines && job.lines.length
                    ? el('div', {
                        style: { ...styles.mono, marginTop: 6, maxHeight: 66, overflow: 'auto', opacity: 0.7 },
                      }, job.lines.slice(-6).join('\n'))
                    : null,
                  // ⚠ 这个 input 必须跟着本分支一起渲染。
                  // 之前这里复用了 aiPickRef，而那个 input 只挂在「三视图（AI 融合）」分支上；
                  // 切到 Zero123 模式时它不在 DOM 里 → aiPickRef.current 为 null →
                  // 按钮的 ?.click() 静默失效（用户看到的就是"这个点不了"）。
                  el('input', {
                    ref: aiPickRef, type: 'file', accept: 'image/*', style: { display: 'none' },
                    onChange: (e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) loadSingle(f)
                    },
                  }),
                )
              : aiInput === 'hunyuan'
              ? el('div', { style: styles.card },
                  el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                    'Hunyuan3D 的输入（一张图）',
                    el('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 6 } },
                      '三维原生生成 —— 几何最细，但没有颜色'),
                  ),
                  el('div', { style: { ...styles.row, gap: 8, flexWrap: 'wrap' } },
                    single
                      ? el('img', {
                          src: single.preview, alt: '输入图',
                          style: { height: 56, borderRadius: 6, border: '1px solid rgba(130,150,190,.35)' },
                        })
                      : null,
                    el('button', { style: styles.btn, onClick: () => aiPickRef.current?.click() },
                      single ? '换一张图' : '选择参考图'),
                    el('button', {
                      style: single && !busy ? styles.btnOn : styles.btn,
                      disabled: !single || busy,
                      onClick: runHunyuan,
                    }, busy ? '生成中…' : '生成精细模型'),
                    el('span', { style: { fontSize: 11, opacity: 0.6 } }, '约 130 秒 · 建议用竖直单人立绘'),
                  ),
                  job && job.lines && job.lines.length
                    ? el('div', {
                        style: { ...styles.mono, marginTop: 6, maxHeight: 66, overflow: 'auto', opacity: 0.7 },
                      }, job.lines.slice(-6).join('\n'))
                    : null,
                  // 同上：这个 input 必须挂在本分支上，否则 aiPickRef.current 是 null
                  el('input', {
                    ref: aiPickRef, type: 'file', accept: 'image/*', style: { display: 'none' },
                    onChange: (e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) loadSingle(f)
                    },
                  }),
                )
              : aiInput === 'mv'
              ? el('div', { style: styles.card },
                  el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                    'Hunyuan3D-2mv 的输入（前 / 左 / 后 / 右，可只给一部分）',
                    el('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 6 } },
                      '多视角一起推理 —— 给得越全，背面越不像猜的'),
                  ),
                  el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 } },
                    MV_VIEWS.map((v) => {
                      const slot = mvViews[v.key]
                      // 用 <label> 包住隐藏的 file input：点整块就能选图，不用手动 click()
                      // （之前别处靠 ref.click()，还得保证 input 跟分支一起渲染，容易踩坑）
                      return el('label', {
                        key: v.key,
                        style: {
                          position: 'relative', borderRadius: 8, padding: 4, textAlign: 'center',
                          border: `1px dashed ${slot ? 'rgba(110,190,255,.55)' : 'rgba(130,150,190,.35)'}`,
                          background: slot ? 'rgba(90,160,255,.10)' : 'transparent',
                          minHeight: 76, display: 'flex', flexDirection: 'column',
                          alignItems: 'center', justifyContent: 'center', gap: 2, cursor: 'pointer',
                        },
                        title: v.hint,
                      },
                        el('input', {
                          type: 'file', accept: 'image/*', style: { display: 'none' },
                          onChange: (e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ''
                            if (f) loadMvView(v.key, f)
                          },
                        }),
                        slot
                          ? el('img', {
                              src: slot.preview, alt: v.label,
                              style: { width: '100%', height: 46, objectFit: 'contain', borderRadius: 4 },
                            })
                          : el('span', { style: { fontSize: 16, opacity: 0.5 } }, '＋'),
                        el('span', { style: { fontSize: 11, opacity: 0.8 } }, `${v.label}${slot ? '' : '（可选）'}`),
                        slot
                          ? el('span', {
                              style: {
                                position: 'absolute', right: 2, top: 2, color: '#ffb1b1', fontSize: 12,
                                lineHeight: 1, cursor: 'pointer',
                              },
                              title: '清空这个视角',
                              onClick: (e) => {
                                // label 会把点击转成"打开选图"，这里必须拦住
                                e.preventDefault(); e.stopPropagation()
                                setMvViews((p) => ({ ...p, [v.key]: null }))
                              },
                            }, '×')
                          : null,
                      )
                    }),
                  ),
                  el('div', { style: { ...styles.row, gap: 8, flexWrap: 'wrap', marginTop: 6 } },
                    el('button', {
                      style: MV_VIEWS.some((v) => mvViews[v.key]) && !busy && !mvVramTooSmall ? styles.btnOn : styles.btn,
                      // ⚠ 显存不够时**禁用**：多视图在这台机器上会 OOM/崩溃，
                      //   3 个视角甚至会把显示驱动打崩（桌面闪断）。让用户点得下去才是 bug。
                      disabled: !MV_VIEWS.some((v) => mvViews[v.key]) || busy || mvVramTooSmall,
                      title: mvVramTooSmall
                        ? `本机显存 ${mvVramGb}G，多视图实测跑不动（需要 ≥11G）；见上方说明`
                        : '前/左/后(右) 一起推理',
                      onClick: runHunyuanMv,
                    }, busy ? '生成中…' : '多视图生成'),
                    el('span', { style: { fontSize: 11, opacity: 0.6 } },
                      mvVramTooSmall ? '本机不可用（显存不足）' : '约 130 秒'),
                    el('button', {
                      style: styles.btn,
                      title: '把四个视角都清空',
                      onClick: () => setMvViews({ front: null, left: null, back: null, right: null }),
                    }, '清空'),
                  ),
                  mvVramTooSmall
                    ? el('div', { style: { ...styles.warn, marginTop: 6 } },
                        el('strong', null, `⚠ 本机显存 ${mvVramGb}G，跑不动多视图 —— 已禁用。`),
                        el('div', { style: { marginTop: 4, fontSize: 11.5, opacity: 0.9 } },
                          '条件序列 = 视角数 × 1370 token，显存随视角数陡增。实测：'
                          + '1 个视角正常；2 个视角在采样/解码阶段反复 OOM 或崩溃（c10.dll 访问冲突）；'
                          + '3 个视角会把显示驱动打崩（nvlddmkm TDR，整个桌面闪断）。'
                          + '权重已装好，换 ≥11G 显存的卡即可用（≥16G 可放开到 4 个视角）。'),
                      )
                    : null,
                  el('div', { style: { ...styles.hint, marginTop: 4 } },
                    '视角是按“绕物体一圈”定义的（前 → 左 → 后 → 右），没有俯视槽 —— '
                    + '俯视图喂不进这个模型。最好是同一物体的实拍或渲染图（背景干净、朝向一致），'
                    + '手绘剪影属于分布外输入，效果不保证。'),
                  job && job.lines && job.lines.length
                    ? el('div', {
                        style: { ...styles.mono, marginTop: 6, maxHeight: 66, overflow: 'auto', opacity: 0.7 },
                      }, job.lines.slice(-6).join('\n'))
                    : null,
                )
              : el('div', { style: styles.card },
                  el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                    'AI 融合的输入（2–3 张）',
                    el('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 6 } },
                      '三张图各跑一次 TripoSR，再按多数票取体积'),
                  ),
                  el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 } },
                    VIEW_META.map((meta) => el(ViewSlot, {
                      key: meta.key, meta,
                      view: aiViews[meta.key],
                      onFile: (f) => loadAiView(meta.key, f),
                      onClear: () => setAiViews((p) => ({ ...p, [meta.key]: null })),
                    })),
                  ),
                  el('div', { style: { ...styles.row, marginTop: 8, gap: 8, flexWrap: 'wrap' } },
                    el('button', {
                      style: (Object.values(aiViews).filter(Boolean).length >= 2 && !busy) ? styles.btnOn : styles.btn,
                      disabled: Object.values(aiViews).filter(Boolean).length < 2 || busy,
                      onClick: runAiFusion,
                    }, busy ? '融合中…' : 'AI 融合生成'),
                    el('span', { style: { fontSize: 11, opacity: 0.6 } },
                      `已选 ${Object.values(aiViews).filter(Boolean).length} 张 · 约 1 分钟/张`),
                  ),
                  job && job.lines && job.lines.length
                    ? el('div', {
                        style: { ...styles.mono, marginTop: 6, maxHeight: 66, overflow: 'auto', opacity: 0.7 },
                      }, job.lines.slice(-6).join('\n'))
                    : null,
                ),

            // 四视角：后视图专门是给人看背面的 —— 单图重建的背面全是先验猜的，
            // 而它对雕刻没有约束价值（视觉外壳沿同一轴只认一个轮廓）。
            snaps
              ? el('div', { style: styles.card },
                  el('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } },
                    'AI 重建的四视角',
                    el('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 6 } },
                      '后视图是模型猜的，看一眼能不能接受'),
                  ),
                  el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 } },
                    [['front', '前'], ['back', '后'], ['side', '侧'], ['top', '俯']].map(([k, label]) =>
                      el('div', { key: k, style: { textAlign: 'center' } },
                        snaps[k]
                          ? el('img', { src: snaps[k], alt: label, style: { width: '100%', borderRadius: 6, display: 'block' } })
                          : null,
                        el('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 2 } }, label),
                      )),
                  ),
                  el('div', { style: { ...styles.row, marginTop: 8 } },
                    el('button', {
                      style: styles.btn, disabled: busy || !mesh,
                      onClick: () => projectToViews(null),
                      title: '把当前模型投影成前/侧/俯剪影，填进三视图的槽，之后可以调参数重新雕刻',
                    }, '投影为三视图 → 填入雕刻槽'),
                  ),
                )
              : null,
          ),

      // 参数行 / 阈值开关只对三视图那条路有意义；下面的导出与显示选项两种模式共用。
      mode === 'views'
        ? el('div', { style: styles.card },
            el('div', { style: { ...styles.row, flexWrap: 'wrap', gap: 14 } },
              el(Slider, { label: '分辨率', k: 'resolution', opt, setOpt: applyOpt, min: 24, max: 192, step: 8 }),
              el(Slider, { label: '留白', k: 'padding', opt, setOpt: applyOpt, min: 0, max: 0.3, step: 0.01, fmt: (v) => v.toFixed(2) }),
              el(Slider, { label: '平滑', k: 'smooth', opt, setOpt: applyOpt, min: 0, max: 4, step: 1 }),
              el(Slider, { label: '去碎块', k: 'removeIslands', opt, setOpt: applyOpt, min: 0, max: 4000, step: 100 }),
            ),
            el('div', { style: { ...styles.row, flexWrap: 'wrap', gap: 6, marginTop: 7 } },
              el(Toggle, { label: '自动阈值', k: 'auto', opt, setOpt: applyOpt, title: '用 Otsu 自动找二值化阈值；关掉后按亮度阈值切' }),
              el(Toggle, { label: '反相', k: 'invert', opt, setOpt: applyOpt, title: '主体比背景亮时打开' }),
              el(Toggle, { label: '填空洞', k: 'fillHoles', opt, setOpt: applyOpt }),
              el(Toggle, { label: '侧视图镜像', k: 'mirrorSide', opt, setOpt: applyOpt, title: '侧视图左右对不上时打开' }),
              el(Toggle, { label: '左右对称', k: 'enforceSymmetry', opt, setOpt: applyOpt }),
            ),
          )
        : null,

      el('div', { style: styles.card },
        el('div', { style: { ...styles.row, flexWrap: 'wrap', gap: 6 } },
          mode === 'views'
            ? el('button', {
                style: styles.btn, disabled: busy,
                onClick: () => compute(viewsRef.current, optRef.current),
              }, busy ? '计算中…' : '重新生成')
            : null,
          // 导出合成一个「导出…」按钮：点开是一张卡（格式 + 文件名 + 目标位置）。
          // 原来四个格式各占一个按钮，一是挤，二是加 gltf/json 之后没法再加了；
          // 而且"存到哪"本来就需要一个地方放，合并成一卡更清楚。
          el('button', {
            style: expOpen ? styles.btnOn : styles.btn,
            disabled: !fitted,
            title: fitted ? '选格式并导出（gltf / glb / json / obj / stl）' : '先做出模型才能导出',
            onClick: () => setExpOpen((v) => !v),
          }, `导出 ${(EXPORT_FORMATS.find((f) => f.v === expFmt) || EXPORT_FORMATS[1]).ext.toUpperCase()} ▾`),
          el('span', { style: { flex: 1 } }),
          el(Toggle, { label: '线框', k: 'wireframe', opt, setOpt: applyOpt }),
          el(Toggle, { label: '平面着色', k: 'flat', opt, setOpt: applyOpt, title: '去掉法线插值，看清面片' }),
          el(Toggle, { label: '自转', k: 'autoRotate', opt, setOpt: applyOpt }),
          el('button', {
            style: styles.btn, disabled: !fitted,
            onClick: () => { const c = stageRef.current; if (c) vpRef.current.fit(c, mesh) },
          }, '复位视角'),
        ),

        // ---- 导出卡（点「导出 ▾」展开）----
        expOpen
          ? el('div', {
              style: {
                marginTop: 7, paddingTop: 7, display: 'flex', flexDirection: 'column', gap: 5,
                borderTop: '1px solid rgba(130,150,190,.22)',
              },
            },
              el('div', { style: { ...styles.row, gap: 6, flexWrap: 'wrap' } },
                el('span', { style: { fontSize: 12, opacity: 0.72, minWidth: 44 } }, '格式'),
                el('select', {
                  value: expFmt,
                  onChange: (e) => setExpFmt(e.target.value),
                  style: {
                    flex: '1 1 260px', minWidth: 200, fontSize: 12, padding: '3px 6px',
                    borderRadius: 6, color: '#e6edf7', background: '#161c26',
                    border: '1px solid rgba(130,150,190,.38)',
                  },
                }, ...EXPORT_FORMATS.map((f) => el('option', { key: f.v, value: f.v }, f.label))),
              ),
              el('div', { style: { ...styles.row, gap: 6 } },
                el('span', { style: { fontSize: 12, opacity: 0.72, minWidth: 44 } }, '文件名'),
                el('input', {
                  type: 'text', value: expName, spellCheck: false,
                  onChange: (e) => setExpName(e.target.value.slice(0, 80)),
                  style: {
                    flex: 1, minWidth: 120, fontSize: 12, padding: '3px 6px',
                    borderRadius: 6, color: '#e6edf7', background: '#161c26',
                    border: '1px solid rgba(130,150,190,.38)',
                  },
                }),
                el('span', { style: { fontSize: 11.5, opacity: 0.55 } },
                  `.${(EXPORT_FORMATS.find((f) => f.v === expFmt) || EXPORT_FORMATS[1]).ext}`),
              ),
              // 目标位置：填了就由 host 直接写盘（可反复导出、不弹窗）；
              // 留空则走系统"另存为"对话框，再不行就浏览器下载。
              el('div', { style: { ...styles.row, gap: 6, flexWrap: 'wrap' } },
                el('span', { style: { fontSize: 12, opacity: 0.72, minWidth: 44 } }, '位置'),
                el('input', {
                  type: 'text', value: expDir, spellCheck: false,
                  placeholder: '留空 = 每次弹「另存为」／浏览器下载',
                  onChange: (e) => setExpDir(e.target.value.trim()),
                  style: {
                    flex: '1 1 240px', minWidth: 180, fontSize: 11.5, padding: '3px 6px',
                    borderRadius: 6, color: '#e6edf7', background: '#161c26',
                    border: '1px solid rgba(130,150,190,.38)',
                  },
                }),
                el('button', {
                  style: styles.btn, disabled: !pickDirectory,
                  title: pickDirectory
                    ? '用 DSH 的目录选择器选一个本地目录'
                    : '这个环境没有原生目录选择器 —— 直接把绝对路径填在左边输入框里',
                  onClick: pickExportDir,
                }, '选择…'),
              ),
              el('div', { style: { ...styles.row, gap: 6, flexWrap: 'wrap' } },
                el('button', {
                  style: fitted ? styles.btnOn : styles.btn, disabled: !fitted,
                  title: expDir ? `写入 ${expDir}（重名会自动编号，不覆盖已有文件）` : '弹出系统保存对话框',
                  onClick: () => doExport(expFmt, false),
                }, expDir ? '导出到该目录' : '另存为…'),
                el('button', {
                  style: styles.btn, disabled: !fitted,
                  title: '不管上面填了什么，强制弹出系统保存对话框（自己挑文件夹和文件名）',
                  onClick: () => doExport(expFmt, true),
                }, '另存为…'),
                el('span', { style: { fontSize: 11, opacity: 0.6 } },
                  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
                    ? '系统对话框可用' : '本环境无系统对话框，退化为浏览器下载'),
              ),
              el('div', { style: { ...styles.hint, marginTop: 0 } },
                '全部格式都只含几何（无材质/UV）。GLB 体积最小、glTF 是文本可读、'
                + 'JSON 带来源与雕刻参数（能被 modeler_load 读回）、STL 给 3D 打印。'),
            )
          : null,
      ),

      el('div', { style: styles.viewportWrap },
        // 这里渲染的是**容器 div**，canvas 由 ThreeViewport 自己创建/替换。
        //
        // 为什么不直接渲染 canvas：释放过一次上下文的 canvas 就永久废了 ——
        // 再 getContext 会把那个已丢失的上下文原样还回来，three.js 读 .precision 直接抛
        // "Cannot read properties of null (reading 'precision')"，重试多少次都是同一个错
        // （现场日志：连点 12 次重试，12 次同样报错）。canvas 交给 React 渲染就换不掉，
        // 所以改成"容器归 React、画布归视口"：画布废了视口自己换一块新的。
        el('div', {
          // ⚠ 用**稳定**的 ref 回调（setStage），不要写成内联箭头 ——
          // 内联的话 React 每次重渲染都会"null 一次、节点一次"地调它，
          // 而"收到 null 就 dispose"会把视口连带 canvas 一起拆掉（详见 setStage 的注释）。
          ref: setStage,
          style: styles.canvasBox,
        }),
        // 3D 预览降级提示：拿不到 WebGL 上下文时（最常见的原因是 GPU 显存被别的任务占满，
          // 比如同时在跑模型训练）视口会创建失败。这时只提示预览不可用 —— 面板的拖图、
          // 雕刻、导出都跑在 CPU 上，不受影响，必须让用户知道还能继续用。
          //
          // ⚠ 这里只认 ensureError（主视口自己的失败）。原来读的是 lastError，而 snapshot()
          // 也往同一个字段写 —— 一次"缩略图拍不出来"就会永久点亮这条横幅，GPU 空着也消不掉。
        vpRef.current && vpRef.current.ensureError
          ? el('div', {
              style: {
                position: 'absolute', left: 12, right: 12, top: 10, padding: '8px 11px',
                borderRadius: 8, fontSize: 12, lineHeight: 1.6,
                border: '1px solid rgba(255,190,120,.45)', background: 'rgba(60,42,20,.86)',
                color: '#ffe1bd',
              },
            },
            '3D 预览不可用：拿不到 WebGL 上下文（常见原因是 GPU 显存被别的任务占满了，比如正在训练模型）。',
            el('br'),
            '拖图、雕刻、导出这些都在 CPU 上跑，不受影响，可以照常用。',
            // 真正的原因必须打出来 —— 只写"通常是显存被占满"会把人带偏：
            // GPU 明明空着、横幅却挂着的时候，没有这一行就完全没法查。
            el('div', {
              style: {
                marginTop: 4, font: '11px/1.5 ui-monospace,Consolas,monospace',
                opacity: 0.75, wordBreak: 'break-all',
              },
            }, `实际原因：${String((vpRef.current.ensureError && vpRef.current.ensureError.message) || vpRef.current.ensureError)}`),
            el('div', { style: { marginTop: 5, display: 'flex', gap: 6, alignItems: 'center' } },
              el('button', {
                style: { ...styles.btn, padding: '2px 10px', fontSize: 11.5 },
                onClick: retryViewport,
              }, '重试'),
              el('span', { style: { fontSize: 11, opacity: 0.8 } },
                '（GPU 腾出来了就点它；重开面板不会重新申请上下文）'),
            ),
          )
          : null,
        !fitted && !busy
          ? el('div', {
              style: {
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', opacity: 0.45, fontSize: 12, pointerEvents: 'none',
              },
            }, '模型会显示在这里（可拖动旋转 / 滚轮缩放）')
          : null,
      ),

      // 适用范围的提示。这条不是客套话：视觉外壳是"三张剪影求交"，
      // 任何从侧面看不见的凹陷/镂空都会被算成实心 —— 拿复杂角色或带孔零件来试，
      // 得到的必然是"糊成一坨"。与其让人试错，不如在视口下面直接写清楚。
      el('div', { style: { ...styles.hint, lineHeight: 1.6 } },
        'ⓘ 只推荐简单／规整的模型：三视图雕刻按三张剪影求交，凹陷、镂空、复杂曲面会被填实。',
        el('br'),
        '方块、器皿、角色剪影这类效果最好；复杂物件请改用 AI 模式（Zero123 / Hunyuan3D-2）。'),

      stat
        ? el('div', { style: styles.card },
            el('div', { style: styles.mono },
              // 单图路来的统计没有体素网格/耗时/填充率这些字段（那不是它的产物），
              // 所以单独一趟，别硬套三视图那行 —— 否则 stat.grid.join 会直接抛错。
              stat.fromFusion
                ? `顶点 ${stat.vertexCount} · 三角形 ${stat.triangleCount} · 来源：${stat.fusion.views} 个视图的 AI 体素投票\n` +
                  `水密 ${stat.watertight ? '✓ 是' : '✗ 否'} · 包围盒 ${stat.extent.map((v) => v.toFixed(3)).join(' × ')}\n` +
                  `保留体素 ${stat.fusion.kept} · 全体一致 ${stat.fusion.unanimous} · 分歧度 ${(stat.fusion.disagreement * 100).toFixed(1)}%\n` +
                  '（分歧度高 = 几个视图对不上；多数票已把少数派的猜测压掉）'
                : stat.fromHunyuan
                ? `顶点 ${stat.vertexCount} · 三角形 ${stat.triangleCount} · 来源 Hunyuan3D-2（单图精细重建）\n` +
                  `水密 ${stat.watertight ? '✓ 是' : '✗ 否'} · 包围盒 ${stat.extent.map((v) => v.toFixed(3)).join(' × ')}\n` +
                  '几何最细、三维自洽；但没有颜色，且网格不水密（3D 打印前需 remesh）'
                : stat.fromSingle
                ? `顶点 ${stat.vertexCount} · 三角形 ${stat.triangleCount} · 来源 TripoSR（单图重建）\n` +
                  `水密 ${stat.watertight ? '✓ 是' : '✗ 否'} · 包围盒 ${stat.extent.map((v) => v.toFixed(3)).join(' × ')}\n` +
                  '背面与内部由模型先验推断，细节不如三视图路径'
                : `顶点 ${stat.vertexCount} · 三角形 ${stat.triangleCount} · 体素网格 ${stat.grid.join('×')} · 耗时 ${stat.ms} ms\n` +
                  `水密 ${stat.watertight ? '✓ 是' : '✗ 否'} · 有符号体积 ${stat.volume.toFixed(4)} · 包围盒 ${stat.extent.map((v) => v.toFixed(3)).join(' × ')}\n` +
                  `填充体素 ${stat.filledVoxels}（${(stat.fillRatio * 100).toFixed(1)}%）` +
                  (stat.missing.length ? ` · 缺 ${stat.missing.map((k) => ({ front: '前', side: '侧', top: '俯' }[k])).join('/')}视图（该轴用默认厚度）` : ''),
            ),
          )
        : null,
    )
  }
}

export { DEFAULTS as MODELER_DEFAULTS, VIEW_META }
