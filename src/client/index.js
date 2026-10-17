/**
 * dsh-modeler —— client 半边（浏览器）。
 *
 * 面板挂在哪里、为什么不挂在右侧栏：
 *   右侧栏一个 tab 只有 ~300px 宽，放不下 3D 视口和三张视图卡；
 *   所以按 dsh-context 的成熟做法：
 *     - `sidebar.footer.action` 放一个入口按钮（在「设置」上面）
 *     - `shell.overlay` 放真正的工作面板（frame 级浮层，可以很大，并支持拖动/缩放）
 *
 * 为什么计算放在浏览器里：雕刻 + 等值面是纯 CPU 的，算法就是 src/core/geometry.js
 * 那一份，打包进这个 bundle。放浏览器意味着拖参数是即时的，不经过 host 往返；
 * host 只负责落盘（modeler_save / modeler_views）。
 */

import React from 'react'
import { createModelerPanel } from '../ui/panel.js'

export const name = 'modeler'

/**
 * ⚠ 必须是**数组**，不能写成 `{ required: ['slots'], optional: [] }`。
 *
 * 踩过的坑（2026-10-15 实测）：写成对象形式时，DSH 的 web boot 会把
 * `required` / `optional` 当成两个**服务名**去等，于是插件永远卡在
 *     `dsh-modeler: pending (waiting for services: required, optional)`
 * 这条信息**只在 web-boot 崩溃日志里**（
 *   %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log
 * ），界面上只表现为"左栏没有那个按钮"、没有任何可见报错。
 * 改成数组后立刻激活。host 半边（`export const inject = ['tools']`）本来就是数组，
 * 所以只有 client 侧踩了这个坑。
 *
 * `uiWorkspace` 是为了「导出到本地目录」里的**原生目录选择器**（`pickDirectory()`）。
 * 实测（diag 的 save-targets 记录）：不写进 inject 时 `ctx.uiWorkspace` 会直接抛
 *     cannot get property "uiWorkspace" without inject
 * 这是 cordis 的硬约束，不是"取不到就算了"，所以必须声明。
 */
export const inject = ['slots', 'uiWorkspace']

/**
 * 探测当前还能不能拿到 WebGL 上下文。
 *
 * 为什么需要：浏览器对同时存在的 WebGL context 有硬上限（Chrome 约 16 个）。一旦泄漏
 * 到耗尽，面板就会在渲染时抛 "Error creating WebGL context." 而打不开 —— 而我在外面
 * 看不到页面，只能靠这条探测判断"现状是否还需要刷新页面"。
 *
 * 探测本身会立即用 WEBGL_lose_context 归还上下文，不会再变成新的泄漏源。
 */
/**
 * 判断一个 WebGL 上下文是不是**真的能用**（不只是"拿到了对象"）。
 *
 * ⚠ 这一条是被现场教训出来的：面板报 "Cannot read properties of null (reading 'precision')"，
 * 而我的探针全报 ok。原因是三件事叠在一起：
 *   - 这个报错来自 three.js 内部的 `gl.getShaderPrecisionFormat(...).precision`；
 *   - 上下文**丢失**时 `getShaderPrecisionFormat` 返回 null，于是读 .precision 就炸；
 *   - 而 `getContext()` 对一块**已经有上下文**的 canvas 会把那个（已丢失的）上下文
 *     原样还回来 —— 非空，但废的。
 * 所以"拿到对象"完全不代表能用，必须查 isContextLost + 一次真实调用。
 */
function ctxUsable(gl) {
  if (!gl) return 'null'
  try {
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) return 'lost'
    const pf = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT)
    if (!pf || !(pf.precision > 0)) return 'no-precision'
    return 'ok'
  } catch (e) {
    return `throw:${String((e && e.message) || e).slice(0, 30)}`
  }
}

function probeWebGL() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    const st = ctxUsable(gl)
    if (st !== 'ok') { diag('webgl-probe', `FAILED: ${st}`); return false }
    const lose = gl.getExtension('WEBGL_lose_context')
    if (lose) { try { lose.loseContext() } catch { /* 忽略 */ } }
    diag('webgl-probe', 'ok')
    return true
  } catch (e) {
    diag('webgl-probe', `throw ${(e && e.message) || e}`)
    return false
  }
}

/**
 * 逐组属性探测：**面板用的那组属性**到底能不能建出**可用**的上下文？
 *
 * 为什么需要这条：实测遇到过"裸探针 ok、面板却报拿不到上下文"的矛盾 —— 说明问题不在
 * "有没有 WebGL"，而在别处（属性组合，或者上下文一建出来就是丢失状态）。
 * 所以每组都要查到"能用"为止，并把真实状态写进 diag（ok / lost / no-precision）。
 */
function probeWebGLAttrs() {
  const sets = [
    ['bare', {}],
    ['three', { antialias: true, alpha: true }],                 // 面板视口用的就是这组
    ['noaa', { antialias: false, alpha: true }],                 // 去掉 MSAA
    ['noalpha', { antialias: true, alpha: false }],
    ['plain', { antialias: false, alpha: false, depth: true, stencil: false }],
    ['power', { antialias: true, alpha: true, powerPreference: 'high-performance' }],
  ]
  const out = []
  for (const [name, attrs] of sets) {
    let st = 'null'
    try {
      const c = document.createElement('canvas')
      c.width = 32; c.height = 32
      const gl = c.getContext('webgl2', attrs) || c.getContext('webgl', attrs)
      st = ctxUsable(gl)
      if (st === 'ok') {
        const lose = gl.getExtension('WEBGL_lose_context')
        if (lose) { try { lose.loseContext() } catch { /* 忽略 */ } }
      }
    } catch (e) {
      st = `throw:${String((e && e.message) || e).slice(0, 30)}`
    }
    out.push(`${name}=${st}`)
  }
  diag('webgl-attrs', out.join(' '))
  return out.join(' ')
}

/**
 * 受控的自动重载：**只有**在"WebGL 真的用不了"时才用，且一个会话最多两次。
 *
 * 为什么要有次数上限：一旦出现"重载后仍然拿不到上下文"的环境问题，无上限的重载
 * 就变成死循环 —— 用户会看到一个反复刷新、永远打不开的面板，比坏掉的视口更糟。
 */
function guardedReload(reason) {
  let n = 0
  try {
    n = Number(window.sessionStorage.getItem('dsh-modeler-auto-reloaded') || '0') || 0
  } catch { return false }
  if (n >= 2) {
    diag('auto-reload-skip', `已经不 ${n} 次，不再重载：${reason}`)
    return false
  }
  try { window.sessionStorage.setItem('dsh-modeler-auto-reloaded', String(n + 1)) } catch { /* 忽略 */ }
  diag('auto-reload', `${reason}（第 ${n + 1} 次）`)
  // 留一点时间让诊断落盘，再重载
  setTimeout(() => { try { window.location.reload() } catch { /* 忽略 */ } }, 1200)
  return true
}

/**
 * WebGL 已被泄漏耗尽时，自动重载一次页面把它清干净。
 *
 * 为什么必须由插件自己动手：上下文到上限之后**只有刷新页面能恢复** —— 那些泄漏的
 * canvas 早就不在 DOM 里了，但 Chromium 并没有回收它们的上下文（实测：探测直接拿不到
 * context）。而用户可能正远程操作、连按 F5 都不方便。与其让人去折腾，不如插件自己重载。
 *
 * sessionStorage 里存的是**次数**（不是布尔），超过上限就绝不再动 —— 见 guardedReload。
 */
function autoRecoverIfWebGLExhausted() {
  let n = 0
  try {
    n = Number(window.sessionStorage.getItem('dsh-modeler-auto-reloaded') || '0') || 0
  } catch { return }
  if (n >= 2) return
  if (probeWebGL()) return
  guardedReload('client 加载时探测不到 WebGL 上下文')
}

const NS = 'dsh-modeler'

/**
 * 「导出到本地路径」的能力探测。
 *
 * 有两条路可以把文件写到用户指定的本地位置，但**它们在桌面外壳里不一定都在**：
 *   1. `uiWorkspace.pickDirectory()`（DSH 自己的原生目录选择器）→ 拿到绝对路径后
 *      由 host 落盘。这条路取决于 client 侧能不能取到这个 Service。
 *   2. 浏览器 File System Access API（`showSaveFilePicker` / `showDirectoryPicker`）
 *      → 浏览器自己写盘，不经过 host。Electron 里可能没实现。
 * 猜没用（这个插件已经因为"以为有、其实没有"栽过好几次），所以把探测结果写进
 * localStorage，外部读得到，按事实选路、剩下的当降级。
 */
function probeSaveTargets(ctx) {
  const out = []
  try {
    const viaGet = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
    const viaProp = ctx && ctx.uiWorkspace
    const svc = viaGet || viaProp
    out.push(`uiWorkspace=${svc ? 'yes' : 'no'}${svc ? `(${typeof svc.pickDirectory === 'function' ? 'pickDirectory' : 'no-pick'})` : ''}${viaGet ? '' : '/viaProp'}`)
  } catch (e) {
    out.push(`uiWorkspace=throw:${e && e.message}`)
  }
  try {
    out.push(`fsApi=${typeof window.showSaveFilePicker === 'function' ? 'save' : '-'}`
      + `${typeof window.showDirectoryPicker === 'function' ? '+dir' : ''}`)
  } catch { out.push('fsApi=throw') }
  try {
    out.push(`anchor=${'download' in document.createElement('a') ? 'yes' : 'no'}`)
  } catch { out.push('anchor=?') }
  return out.join(' ')
}

// ---------------------------------------------------------------------------
// 自诊断
// ---------------------------------------------------------------------------
//
// "点了入口没反应"这类问题最难查：渲染异常会被 React 吞掉、控制台在外面看不到、
// 而页面又要 token 才能从外部访问。所以这里留一条**外部可读的痕迹** ——
// 把关键节点写进 localStorage（值全用 ASCII，方便直接在 LevelDB 文件里搜到）：
//   apply          插件 client 半边每次加载/热重载都会写
//   click-entry    入口按钮被点击
//   render-overlay 浮层真的渲染了
//   render-error   浮层渲染抛异常（连同 ErrorBoundary 一起显示到界面上）
function diag(tag, extra) {
  try {
    const line = `${tag}|${extra == null ? '' : String(extra).slice(0, 200)}|${Date.now()}`
    window.localStorage.setItem('dsh-modeler-diag-last', line)
    const hist = window.localStorage.getItem('dsh-modeler-diag-hist') || ''
    window.localStorage.setItem('dsh-modeler-diag-hist', `${hist}\n${line}`.slice(-4000))
  } catch { /* localStorage 不可用就算了，绝不能因为它影响插件本身 */ }
}


// ---------------------------------------------------------------------------
// 面板开关（模块级：入口按钮与浮层各注册在一个槽位，需要共享状态）
// ---------------------------------------------------------------------------

const listeners = new Set()
let open = false

function setOpen(v) {
  diag('setOpen', v ? 'open' : 'close')
  open = !!v
  for (const l of listeners) l(open)
}
function useOpenState() {
  const [v, setV] = React.useState(open)
  React.useEffect(() => {
    const l = (next) => setV(next)
    listeners.add(l)
    setV(open)
    return () => listeners.delete(l)
  }, [])
  return v
}

// ---------------------------------------------------------------------------
// 浮窗几何（模块级：收起再打开保持原来的位置 / 尺寸 / 最小化状态）
// ---------------------------------------------------------------------------

const geomListeners = new Set()
let winGeom = { w: 940, h: 740, left: null, top: null, min: false }

function setGeom(patch) {
  winGeom = { ...winGeom, ...patch }
  for (const l of geomListeners) l(winGeom)
}
function useGeom() {
  const [v, setV] = React.useState(winGeom)
  React.useEffect(() => {
    const l = (next) => setV(next)
    geomListeners.add(l)
    setV(winGeom)
    return () => geomListeners.delete(l)
  }, [])
  return v
}

const HEADER_BTN = {
  border: '1px solid rgba(130,150,190,.4)', background: 'transparent',
  color: 'inherit', borderRadius: 7, cursor: 'pointer', fontSize: 12,
  padding: '2px 8px', lineHeight: 1.5, font: 'inherit',
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 面板组件
// ---------------------------------------------------------------------------
//
// 曾经这里还有一套"把面板弹成独立浏览器窗口"的实现（window.open + 在 popup 里另建
// React root）。已删除，原因：DSH 桌面版两头都堵 —— Electron 外壳拒绝 window.open，
// Document Picture-in-Picture 在 Electron 里报 "Internal error: no window"。
// 面板现在就是 DSH 内的非模态浮窗（可拖动 / 缩放 / 最小化 / 记忆位置）。

let panelComp = null

/**
 * client 侧的 cordis 上下文。apply 时存下来 —— 槽位里注册的组件函数拿不到 ctx
 * （它们是被 DSH 直接调用的），而面板需要 ctx.uiWorkspace 来做原生目录选择，
 * 所以走这个模块级引用。热重载会用新的 ctx 覆盖，不会留旧的。
 */
let clientCtx = null

/**
 * 面板组件类型（保持单例；状态在 panel.js 的模块级 store 里，关掉再开不丢）
 *
 * hooks 里给的是面板够不着、只有 client 半边才知道的东西：
 *   pickDirectory —— DSH 原生目录选择器（返回绝对路径），导出到本地目录用
 *   diag          —— 把关键节点写进 localStorage，外部（也就是我）读得到
 * 这两个都是"可选"：缺了面板照常能用，只是导出退化成浏览器下载。
 */
function getPanelComponent() {
  if (!panelComp) {
    panelComp = createModelerPanel(React, {
      pickDirectory: async () => {
        const svc = clientCtx && clientCtx.uiWorkspace
        if (!svc || typeof svc.pickDirectory !== 'function') {
          diag('export-pickdir', 'no uiWorkspace.pickDirectory')
          return null
        }
        const p = await svc.pickDirectory()
        diag('export-pickdir', p ? `picked ${p}` : 'cancelled')
        return p || null
      },
      /**
       * 面板建视口失败时叫我们一声。这里做的是"面板不该做的事"：
       * 再探一次 WebGL —— 如果连一次全新的探测都拿不到上下文，说明是**页面/进程级**
       * 的问题（不是那块 canvas 的问题），此时只有重载能救；若探测正常，就什么都不做，
       * 让用户点面板上的「重试」即可（避免为了一个可恢复的小故障把整个页面刷掉）。
       */
      onViewportDead: (msg) => {
        if (probeWebGL()) return
        guardedReload(`视口创建失败且探测也无上下文：${msg}`)
      },
      diag,
    })
  }
  return panelComp
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 入口按钮
// ---------------------------------------------------------------------------

function ModelerButton() {
  const isOpen = useOpenState()
  return React.createElement('button', {
    type: 'button',
    title: isOpen ? '收起三视图建模' : '打开三视图建模（用前/侧/俯三张图雕刻三维模型）',
    'aria-pressed': isOpen,
    onClick: () => { diag('click-entry', 'sidebar'); setOpen(!isOpen) },
    style: {
      display: 'flex', alignItems: 'center', gap: 7, width: '100%',
      padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
      border: isOpen ? '1px solid rgba(110,190,255,.6)' : '1px solid transparent',
      background: isOpen ? 'rgba(90,160,255,.2)' : 'transparent',
      color: 'inherit', font: 'inherit', textAlign: 'left',
    },
  },
    React.createElement('span', {
      style: { fontSize: 14, lineHeight: 1, width: 18, textAlign: 'center' },
      'aria-hidden': 'true',
    }, '◧'),
    React.createElement('span', { style: { fontSize: 12.5 } }, '三视图建模'),
  )
}

// ---------------------------------------------------------------------------
// 输入框下方的常驻入口条（第二入口）
// ---------------------------------------------------------------------------

/**
 * 为什么要有第二个入口：
 *   本来只注册了 `sidebar.footer.action`（"侧栏底部、设置旁边"）。但实测这台机器上
 *   **整个侧栏 footer 区没有渲染** —— 同一槽位里 DSH 自带的 `cordis-panel`、
 *   `cost-meter` 系列也都不显示（用 client inspect 能看到它们全在 occupants 里且
 *   `active: true`，但界面上那块区域是空白）。
 *
 *   查证过程：UI Automation 枚举不到（Chromium 默认不暴露 a11y 树）；把
 *   `dsh-web-frontend/dist/assets/index-*.js` 从 app.asar 里抠出来看，那只是外壳
 *   （"sidebar" 出现 0 次），sidebar 组件在懒加载的另一个 chunk 里。
 *
 *   所以不再赌一个我控制不了的渲染位置，改到 `conversation.composer.dock`
 *   —— "Ambient entries below the composer card"，聊天输入框正下方的常驻条，
 *   这个区域一定是渲染的（输入框本身可见）。**原入口保留**，两个都能开面板。
 */
function ModelerDock() {
  const isOpen = useOpenState()
  return React.createElement('button', {
    type: 'button',
    title: isOpen ? '收起三视图建模' : '打开三视图建模（用前/侧/俯三张图雕刻三维模型）',
    onClick: () => { diag('click-entry', 'dock'); setOpen(!isOpen) },
    style: {
      display: 'flex', alignItems: 'center', gap: 6,
      margin: '2px auto 0', padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
      border: isOpen ? '1px solid rgba(110,190,255,.6)' : '1px solid rgba(130,150,190,.3)',
      background: isOpen ? 'rgba(90,160,255,.2)' : 'transparent',
      color: 'inherit', font: 'inherit', fontSize: 11.5, opacity: isOpen ? 1 : 0.75,
    },
  },
    React.createElement('span', { 'aria-hidden': 'true' }, '◧'),
    React.createElement('span', null, '三视图建模'),
  )
}

// ---------------------------------------------------------------------------
// 浮层面板
// ---------------------------------------------------------------------------

function Overlay() {
  const isOpen = useOpenState()
  const geom = useGeom()
  // 组件类型保持单例（状态在 panel.js 的模块级 store 里，关掉面板再打开不丢）
  const ModelerPanel = React.useMemo(() => getPanelComponent(), [])
  const boxRef = React.useRef(null)
  const slotRef = React.useRef(null)
  const hostRef = React.useRef(null)
  const dragRef = React.useRef(null)
  // 本次按下累计移动的像素：悬浮球上"拖动"和"点击展开"共用一套鼠标手势，靠它区分
  const dragMovedRef = React.useRef(0)

  // 记录"浮层真的渲染了"（诊断用；放在所有 hook 之后、提前 return 之前不合法，
  // 所以放在 hook 区里，靠依赖数组控制）
  React.useEffect(() => { if (isOpen) diag('render-overlay') }, [isOpen])

  // 用户拖右下角 resize 手柄后，把实际尺寸同步回模块级状态，下次打开保持
  React.useEffect(() => {
    const el = boxRef.current
    if (!isOpen || !el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      if (winGeom.min) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (Math.abs(w - winGeom.w) > 1 || Math.abs(h - winGeom.h) > 1) setGeom({ w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isOpen])

  if (!isOpen) return null

  const startDrag = (e) => {
    if (e.button !== 0) return
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const d = { dx: e.clientX - r.left, dy: e.clientY - r.top, left: r.left, top: r.top }
    dragRef.current = d
    dragMovedRef.current = 0
    const sx = e.clientX
    const sy = e.clientY
    e.preventDefault()
    const onMove = (ev) => {
      if (!dragRef.current || !boxRef.current) return
      // 累计位移：抬起时用它判断"这是拖动还是点击"（悬浮球两种手势共用）
      dragMovedRef.current = Math.max(
        dragMovedRef.current,
        Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy),
      )
      d.left = Math.max(0, Math.min(window.innerWidth - 180, ev.clientX - d.dx))
      d.top = Math.max(0, Math.min(window.innerHeight - 46, ev.clientY - d.dy))
      // 拖动期间直接改 DOM 样式：走 setState 会每帧重渲染整个面板（内含 three.js 视口）
      boxRef.current.style.left = d.left + 'px'
      boxRef.current.style.top = d.top + 'px'
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragRef.current = null
      setGeom({ left: d.left, top: d.top })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 默认落在**左侧**（不是右侧）：右侧经常被 DSH 自己的面板占着（文件预览、费用明细…），
  // 浮窗放右边会正好被它们盖住 —— 实测就是这个问题（点了入口，按钮有 hover 反馈，
  // 但浮窗被 AGENTS.md 预览面板挡住，看起来像"没打开"）。用户可以再自己拖到任意位置。
  const left = geom.left != null ? geom.left : 24
  const top = geom.top != null ? geom.top : 64

  return React.createElement('div', {
    // 非模态：整层不吃鼠标事件（pointerEvents:none），所以 DSH 界面照常可点可用。
    // （原来是 inset:0 + 半透明模糊遮罩，把整个 DSH 盖住了 —— 那正是"占用界面"的来源。）
    // zIndex 给得比 DSH 自带面板高：否则浮窗会被文件预览/费用明细那类面板压住。
    style: { position: 'fixed', inset: 0, zIndex: 240, pointerEvents: 'none' },
  },
    React.createElement('div', {
      ref: boxRef,
      // 最小化时它就是一颗悬浮球。两种形态样式差别大，所以分支 —— 但**只分支样式，
      // 不分支子节点**：面板主体必须一直挂载，否则每次展开都要重建 three.js 视口，
      // 白白消耗一个 WebGL 上下文（那正是之前"面板打不开"的坑）。
      style: geom.min
        ? {
            position: 'absolute', left, top,
            width: 46, height: 46, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'auto', cursor: 'grab', userSelect: 'none',
            border: '1px solid rgba(110,190,255,.55)',
            background: 'var(--dsh-surface-solid, #141a24)',
            boxShadow: '0 10px 26px rgba(0,0,0,.55)',
            color: 'var(--dsh-text, #e6edf7)',
          }
        : {
            position: 'absolute', left, top,
            width: geom.w, height: geom.h,
            display: 'flex', flexDirection: 'column',
            pointerEvents: 'auto',
            borderRadius: 12, overflow: 'hidden',
            resize: 'both',
            minWidth: 480, minHeight: 240,
            border: '1px solid rgba(120,150,200,.3)',
            background: 'var(--dsh-surface-solid, #141a24)',
            boxShadow: '0 18px 46px rgba(0,0,0,.5)',
            color: 'var(--dsh-text, #e6edf7)',
          },
      // 悬浮球的手势：拖动换位置、点击展开（两者靠 dragMovedRef 区分）
      ...(geom.min ? {
        title: '三视图建模 —— 点击展开，拖动可换位置',
        onMouseDown: startDrag,
        onClick: () => {
          if (dragMovedRef.current > 4) return // 刚才是拖动，不算点击
          setGeom({ min: false })
        },
      } : {}),
    },
      // 悬浮球图标（只有最小化时可见）
      React.createElement('span', {
        style: {
          display: geom.min ? 'block' : 'none',
          fontSize: 19, lineHeight: 1, pointerEvents: 'none',
        },
        'aria-hidden': 'true',
      }, '◧'),
      // 面板主体：最小化时只 display:none，不卸载
      React.createElement('div', {
        style: {
          display: geom.min ? 'none' : 'flex',
          flexDirection: 'column', flex: 1, minHeight: 0,
        },
      },
      // ---- 标题栏（兼拖动把手）----
      React.createElement('div', {
        onMouseDown: startDrag,
        style: {
          display: 'flex', alignItems: 'center', gap: 9, flex: '0 0 auto',
          padding: '7px 11px', cursor: 'move', userSelect: 'none',
          borderBottom: '1px solid rgba(120,150,200,.2)',
          background: 'rgba(90,160,255,.07)',
        },
      },
        React.createElement('strong', { style: { fontSize: 13.5 } }, '三视图建模 · dsh-modeler'),
        React.createElement('span', { style: { fontSize: 11.5, opacity: 0.5 } },
          '拖入前 / 侧 / 俯三张图 → 雕刻 → 导出 OBJ / STL / GLB'),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', {
          type: 'button', title: geom.min ? '还原' : '最小化',
          onClick: () => setGeom({ min: !geom.min }), style: HEADER_BTN,
        }, geom.min ? '▢' : '—'),
        React.createElement('button', {
          type: 'button', title: '关闭 (Esc)', onClick: () => setOpen(false),
          style: { ...HEADER_BTN, padding: '2px 9px', fontSize: 14 },
        }, '×'),
      ),
      // ---- 内容槽 ----
      // 面板就渲染在这里。状态在 panel.js 的模块级 store 里，所以关掉再打开，
      // 之前拖进去的图、雕好的模型、调好的参数都还在。
      // （最小化时的隐藏由外面那层主体容器负责，这里不用再判 geom.min）
      React.createElement('div', {
        ref: slotRef,
        style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      },
        React.createElement('div', {
          ref: hostRef,
          style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' },
        }, React.createElement(ModelerPanel, null)),
      ),
      ),
    ),
  )
}

// Esc 关闭
function useEscape() {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * 捕获浮层的渲染异常。
 * 为什么需要它：React 渲染抛错时会**卸载整棵子树**，表现就是"点了没反应、什么都不显示"，
 * 而且错误只进控制台（这里看不到）。加了边界之后，异常会直接显示在界面上，
 * 同时写进自诊断，外部就能读到。
 */
class OverlayBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }

  static getDerivedStateFromError(err) { return { err } }

  componentDidCatch(err) { diag('render-error', (err && err.message) || err) }

  render() {
    if (this.state.err) {
      return React.createElement('div', {
        style: {
          position: 'fixed', left: 24, top: 64, width: 620, zIndex: 260,
          padding: '14px 16px', borderRadius: 10,
          font: '12.5px/1.7 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif',
          border: '1px solid rgba(255,120,120,.55)', background: '#2a1418', color: '#ffdcdc',
          boxShadow: '0 16px 40px rgba(0,0,0,.5)',
        },
      },
        React.createElement('strong', null, '三视图建模：面板渲染出错'),
        React.createElement('div', { style: { marginTop: 6, opacity: 0.92 } },
          String((this.state.err && this.state.err.message) || this.state.err)),
        React.createElement('div', { style: { marginTop: 6, opacity: 0.6 } },
          '细节已记录到 localStorage（dsh-modeler-diag-*）'),
      )
    }
    return this.props.children
  }
}

function Root() {
  useEscape()
  return React.createElement(OverlayBoundary, null, React.createElement(Overlay, null))
}

// ---------------------------------------------------------------------------

export function apply(ctx) {
  clientCtx = ctx
  // 每次加载/热重载都会留下这一行：外部据此确认"HMR 到底有没有把新代码推上来"
  diag('apply', 'client half loaded')
  // 导出落盘走哪条路，取决于这两个能力在不在 —— 先报事实，再按事实选路
  diag('save-targets', probeSaveTargets(ctx))
  // 探测 WebGL 余量；若已被泄漏耗尽（必须刷新才能恢复）就自动重载一次页面
  autoRecoverIfWebGLExhausted()
  // 顺带把"哪组上下文属性可用"记下来（面板视口用的那组单独标出来，便于定位差异）
  probeWebGLAttrs()

  const disposers = []

  // 入口按钮（左栏底部，设置上面）
  if (ctx.slots.inject) {
    disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'modeler-entry',
      order: 12,
    }, ModelerButton)))
  }

  // 工作面板（frame 级浮层）
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'modeler-overlay',
    order: 12,
  }, Root)))

  // 第二入口：输入框下方的常驻条（footer 那个位置实测不渲染，见 ModelerDock 的注释）
  if (ctx.slots.inject) {
    disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'modeler-dock',
      order: 12,
    }, ModelerDock)))
  }

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`[${NS}] 已挂载：sidebar.footer.action + conversation.composer.dock 入口 + shell.overlay 面板`)
  }

  return () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch { /* 忽略 */ }
    }
  }
}
