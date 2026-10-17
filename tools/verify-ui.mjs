/**
 * 客户端 UI 的"真实渲染"测试（不需要浏览器、不需要真 React）。
 *
 * 做法：用一个**记录型的 React shim** 替换 react，然后把 ModelerPanel 真正渲染一次。
 * shim 的 createElement 会：
 *   - 函数组件 → 立刻调用它并把返回的树继续展开（所以组件里写的东西真的会执行）
 *   - 宿主元素（div/canvas/input…）→ 记下来
 * 这样能抓到一批"只靠读代码看不出来"的问题：
 *   - 组件引用错了 / 未定义（TypeError）
 *   - 在渲染期访问了 undefined 的属性（TypeError）
 *   - 数组 map 出来的子节点缺 key（React 会警告，我们也检查）
 *   - hooks 返回结构不对（useState 没返回数组之类）
 *
 * ⚠ 抓不到什么：useEffect 里的副作用（shim 不执行 effect）、真实事件、
 *   three.js 的 WebGL 行为。那些属于"浏览器/重启后验证"的范围。
 *
 * 用法：node tools/verify-ui.mjs
 */

import assert from 'node:assert/strict'

const failures = []
const warnings = []

// ---------------------------------------------------------------------------
// 记录型 React shim
// ---------------------------------------------------------------------------

// Fragment 必须是**透明的**：它既不是函数组件，也不是宿主元素。
// 之前 shim 把 Symbol('Fragment') 当宿主元素记下来，于是 tags 里混进一个 Symbol，
// 后面 `[...new Set(tags)].join(', ')` 直接抛 "Cannot convert a Symbol value to a string"
// —— 报的是 shim 的问题，看着却像面板崩了。
const FRAGMENT = Symbol('Fragment')
/** 「这个槽还没被初始化过」的占位符（不能用 undefined，因为初值本身可能就是 undefined） */
const UNSET = Symbol('unset')

function makeShim() {
  const rendered = []          // 收集宿主元素
  const componentTrace = []    // 组件调用顺序，便于定位崩在哪
  const effectQueue = []       // useEffect 的回调（默认不执行）
  const missingKeys = []

  // 极简"真状态"：hook 按调用序号占槽，setState 只标脏，外层循环重渲染。
  // 为什么要做到这一步：面板里不少东西是**点开才渲染**的（导出卡、环境卡），
  // 只返回初值的假 useState 永远看不到它们 —— 等于这些 UI 完全没被验证过。
  const slots = []
  const refs = []
  let cursor = 0
  let dirty = false

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      if (type === FRAGMENT) return flat.length === 1 ? flat[0] : flat
      if (typeof type === 'function') {
        componentTrace.push(type.name || '(anonymous)')
        // 函数组件：真的调用它
        const merged = { ...(props || {}) }
        if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
        const out = type(merged)
        return out
      }
      // 宿主元素
      const key = props && props.key !== undefined ? props.key : undefined
      rendered.push({ tag: type, props: props || {}, childCount: flat.length, key })
      return { $$host: true, tag: type, props: props || {}, children: flat, key }
    },
    useState(initial) {
      const i = cursor++
      if (slots.length <= i || slots[i] === UNSET) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next) => {
        const v = typeof next === 'function' ? next(slots[i]) : next
        if (v !== slots[i]) { slots[i] = v; dirty = true }
      }]
    },
    useEffect(fn, deps) { effectQueue.push({ fn, deps }); return undefined },
    useLayoutEffect(fn, deps) { effectQueue.push({ fn, deps }); return undefined },
    useRef(initial) {
      const i = cursor++
      if (!refs[i]) refs[i] = { current: initial }
      return refs[i]
    },
    useMemo(fn) { cursor++; return fn() },
    useCallback(fn) { cursor++; return fn },
    useContext() { cursor++; return {} },
    useReducer(_r, initial) { const i = cursor++; if (slots.length <= i) slots[i] = initial; return [slots[i], () => {}] },
    memo: (c) => c,
    forwardRef: (c) => c,
    Fragment: FRAGMENT,
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    // 记录 key 缺失：createElement 被调用时若父数组没给 key，React 会警告
    __rendered: rendered,
    __trace: componentTrace,
    __effects: effectQueue,
    __missingKeys: missingKeys,
    /** 从零开始一次渲染（重置 hook 游标与已收集的宿主元素），供交互测试驱动 */
    __beginRender() {
      cursor = 0
      rendered.length = 0
      componentTrace.length = 0
    },
    /** 上一次 __beginRender 之后有没有 setState 过 */
    get __dirty() { return dirty },
    __clearDirty() { dirty = false },
  }
  return React
}

// ---------------------------------------------------------------------------
// 造一个够用的浏览器环境
// ---------------------------------------------------------------------------

function installDom() {
  const listeners = new Map()
  const makeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() {},
    setAttribute() {}, getAttribute() { return null },
    addEventListener(t, fn) { listeners.set(t, fn) },
    removeEventListener() {},
    focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 } },
    getContext() {
      // canvas 2D 的最小替身（preview 生成会用到，但本地无图时不走这条路）
      return {
        drawImage() {}, getImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } },
        createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } },
        putImageData() {}, strokeRect() {}, fillRect() {}, save() {}, restore() {}, scale() {},
        set strokeStyle(v) {}, get strokeStyle() { return '' },
        set lineWidth(v) {}, get lineWidth() { return 1 },
      }
    },
    toDataURL() { return 'data:image/png;base64,AAAA' },
    parentElement: null,
    clientWidth: 800, clientHeight: 600,
  })

  const body = makeEl('body')
  globalThis.document = {
    body,
    documentElement: makeEl('html'),
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener(t, fn) { listeners.set(t, fn) },
    removeEventListener() {},
  }
  globalThis.window = {
    devicePixelRatio: 1,
    innerWidth: 1200, innerHeight: 800,
    addEventListener(t, fn) { listeners.set(t, fn) },
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame
  globalThis.performance = globalThis.performance || { now: () => Date.now() }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  globalThis.URL.createObjectURL = () => 'blob:stub'
  globalThis.URL.revokeObjectURL = () => {}
  globalThis.Blob = class { constructor(parts) { this.parts = parts } }
  return { listeners, makeEl }
}

const dom = installDom()

// ---------------------------------------------------------------------------
// 载入 UI 模块（它 import three / viewport，但渲染期不会碰 WebGL）
// ---------------------------------------------------------------------------

const { createModelerPanel, MODELER_DEFAULTS, VIEW_META } = await import('../src/ui/panel.js')

console.log('=== 1. 面板模块的静态导出 ===')
assert.equal(typeof createModelerPanel, 'function', 'createModelerPanel 必须是函数')
assert.ok(MODELER_DEFAULTS && typeof MODELER_DEFAULTS === 'object', '应导出默认参数')
for (const k of ['resolution', 'padding', 'smooth', 'threshold', 'auto', 'invert', 'fillHoles', 'mirrorSide']) {
  assert.ok(k in MODELER_DEFAULTS, `默认参数缺少 ${k}`)
}
assert.equal(VIEW_META.length, 3, '应有三个视图槽')
assert.deepEqual(VIEW_META.map((v) => v.key), ['front', 'side', 'top'])
console.log(`  默认参数 ${Object.keys(MODELER_DEFAULTS).length} 项；视图槽 ${VIEW_META.map((v) => v.label).join(' / ')}`)

// ---------------------------------------------------------------------------
// 2. 用 shim 真实渲染
// ---------------------------------------------------------------------------

console.log()
console.log('=== 2. 真实渲染组件树（记录型 React shim）===')
const React = makeShim()
const ModelerPanel = createModelerPanel(React)
assert.equal(typeof ModelerPanel, 'function', 'createModelerPanel 应返回组件函数')

let tree
/** 渲染一次（清空本次收集，但保留 hook 状态）——交互测试靠它重渲染 */
function renderPanel() {
  React.__beginRender()
  return ModelerPanel({})
}
try {
  tree = renderPanel()
} catch (e) {
  failures.push(`渲染时抛错：${e.message}\n${String(e.stack).split('\n').slice(0, 6).join('\n')}`)
}

if (tree) {
  console.log(`  渲染成功。调用过的组件：${React.__trace.join(' → ')}`)
  assert.ok(React.__trace.length >= 1, '至少应渲染一个组件')
}

// 检查宿主元素
const hosts = React.__rendered
const tags = hosts.map((h) => h.tag)
const count = (t) => tags.filter((x) => x === t).length
console.log(`  宿主元素 ${hosts.length} 个：${[...new Set(tags)].join(', ')}`)

// 面板应有的骨架。
// ⚠ 这里**不该**再找 <canvas>：视口的那块画布现在由 ThreeViewport 自己创建并塞进容器
//   （因为释放过上下文的 canvas 永久废掉、必须能整块换新的，见 viewport.js 的文件头注释）。
//   React 只渲染那个容器 div。真实的 canvas / WebGL 由 verify-panel（真浏览器）那边验。
const checks = [
  ['input', '文件选择 / 滑块'],
  ['button', '按钮'],
]
for (const [tag, why] of checks) {
  if (count(tag) === 0) failures.push(`渲染结果里没有 <${tag}>（${why}）`)
  else console.log(`  ✔ 有 ${count(tag)} 个 <${tag}>（${why}）`)
}
const vpBox = hosts.find((h) => h.tag === 'div'
  && h.props?.style?.position === 'absolute' && h.props?.style?.inset === 0)
if (!vpBox) failures.push('没有视口容器 div（three.js 视口就挂在这里面）')
else console.log('  ✔ 有视口容器 div（canvas 由 ThreeViewport 运行时创建/替换）')

// 三个视图槽：drop 区应当各有 1 个隐藏的 file input + 1 个可点区域；
// 另外 AI 输入区（默认 single 模式）也有一个自己的 file input —— 它必须**跟着分支渲染**，
// 早先它只挂在「三视图（AI 融合）」分支上，切到 Zero123 时 ref 为 null、按钮静默失效。
// 所以这里是 3 个雕刻槽 + 1 个 AI 槽 = 4。
const fileInputs = hosts.filter((h) => h.tag === 'input' && h.props.type === 'file')
if (fileInputs.length !== 4) failures.push(`应有 4 个 file input（前/侧/俯各一个 + AI 输入一个），实际 ${fileInputs.length}`)
else console.log('  ✔ 三个视图槽 + AI 输入区各有 1 个 file input')
for (const fi of fileInputs) {
  if (!fi.props.accept || !String(fi.props.accept).includes('image')) {
    failures.push('file input 的 accept 应限制为 image/*')
  }
  if (fi.props.style?.display !== 'none') warnings.push('file input 没有隐藏（会导致页面上多出三个选择框）')
}

// 滑块：分辨率/留白/平滑/去碎块 → 至少 4 个 range
const ranges = hosts.filter((h) => h.tag === 'input' && h.props.type === 'range')
if (ranges.length < 4) failures.push(`参数滑块应有至少 4 个，实际 ${ranges.length}`)
else console.log(`  ✔ ${ranges.length} 个 range 滑块（${ranges.map((r) => r.props.min + '~' + r.props.max).join('  ')})`)

// 导出按钮：OBJ / STL / GLB
//
// 注意：按钮文案在源码里是 ('导出 ' + f.toUpperCase()) 这种**运行时拼出来的表达式**，
// 不是静态字面量，所以只能靠"把整棵树里的字符串收集起来再搜"来断言。
// 一开始我只看 button 的第一个 child，结果三个按钮全部漏判 —— 那是测试的错，不是 UI 的错。
function collectStrings(node, out = []) {
  if (node == null) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) collectStrings(c, out); return out }
  if (typeof node === 'object') {
    if (node.children) collectStrings(node.children, out)
    if (node.props) {
      for (const v of Object.values(node.props)) {
        if (typeof v === 'string') out.push(v)
      }
    }
  }
  return out
}

// 导出入口：合并成了一个「导出 ▾」按钮（点开是格式 + 文件名 + 目标位置那张卡）。
// 卡里的东西是**点开才渲染**的，所以这里先用 shim 的真状态点一下，再断言卡的内容 ——
// 否则这段 UI 等于完全没被验证（改坏了也不会有人知道）。
//
// ⚠ 找元素必须在**树**里找，不能在 React.__rendered 里找：后者只记了 tag/props，
// 没有 children（文案全在 children 里）。我第一次就是踩了这个 —— 按钮明明在，
// 却报"找不到"，白查一轮。
function findInTree(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findInTree(c, pred, out); return out }
  if (pred(node)) out.push(node)
  if (node.children) findInTree(node.children, pred, out)
  return out
}
const isHost = (n, tag) => n && n.$$host === true && (tag === undefined || n.tag === tag)
const textOf = (node) => collectStrings(node).join('')
/** mv 的四个方位角视角（面板里的槽标签）；**没有"俯"**是模型的设定，不是漏做 */
const MV_SLOT_LABELS = ['前（可选）', '左（可选）', '后（可选）', '右（可选）']

const allText = textOf(tree)
const expBtn = findInTree(tree, (n) => isHost(n, 'button') && textOf(n).startsWith('导出'))[0]
if (!expBtn) {
  failures.push('找不到「导出 ▾」按钮')
} else {
  console.log(`  ✔ 有导出入口：${textOf(expBtn)}`)
  const before = expBtn.props.disabled
  try {
    expBtn.props.onClick()
  } catch (e) {
    failures.push(`点「导出」按钮抛错：${e.message}`)
  }
  if (React.__dirty) {
    React.__clearDirty()
    tree = renderPanel()          // 状态留着重渲染：导出卡这时才出现
    const cardText = textOf(tree)
    // 六种格式都在下拉里
    const opts = findInTree(tree, (n) => isHost(n, 'option')).map((n) => textOf(n))
    const wantExt = ['gltf', 'glb', 'json', 'obj', 'stl']
    const missing = wantExt.filter((e) => !opts.some((o) => o.toLowerCase().includes('.' + e)))
    if (opts.length !== 6) failures.push(`导出格式下拉应有 6 项，实际 ${opts.length}：${opts.join(' / ')}`)
    else if (missing.length) failures.push(`导出格式下拉里缺：${missing.join(', ')}`)
    else console.log(`  ✔ 导出卡里 6 种格式都在：${opts.map((o) => o.split(' ')[0]).join(' ')}`)
    // 文件名 + 位置输入框
    const txt = findInTree(tree, (n) => isHost(n, 'input') && n.props.type === 'text')
    if (txt.length < 2) failures.push(`导出卡应有「文件名」和「位置」两个输入框，实际 ${txt.length}`)
    else console.log(`  ✔ 文件名 / 位置 两个输入框都在（位置框提示：${txt[1].props.placeholder || '—'}）`)
    // 目标位置的三条出口：写到已选目录 / 强制另存为 / 挑目录
    const cardBtns = findInTree(tree, (n) => isHost(n, 'button')).map((n) => textOf(n))
    if (!cardBtns.some((t) => t.includes('另存为'))) failures.push('导出卡里没有「另存为…」按钮')
    if (!cardBtns.some((t) => t.includes('选择'))) failures.push('导出卡里没有「选择…」（挑本地目录）按钮')
    console.log(`  ✔ 导出卡按钮：${cardBtns.filter((t) => t.startsWith('另存为') || t.startsWith('选择…') || t.startsWith('导出') || t.startsWith('重置') || t.startsWith('清空')).join(' | ')}`)
    if (cardText.includes('无材质')) console.log('  ✔ 导出卡写明了"只含几何（无材质/UV）"')
    else warnings.push('导出卡里没有说明"只含几何"')
    // 空状态下按钮该是禁用的（和别的导出入口一致）
    if (before !== true) warnings.push('还没有网格时「导出」按钮应处于禁用状态')
  } else {
    failures.push('点「导出」没有触发状态变化（导出卡打不开）')
  }
}

// ---------------------------------------------------------------------------
// 2b. 多视图模式（Hunyuan3D-2mv）的输入区 —— **在真浏览器用例里验**（见下）
// ---------------------------------------------------------------------------
//
// 为什么这里不验：md 模式的 tab（mode）和模型选择（aiInput）都存在 useShared 的
// 模块级 store 里，而本文件的 React shim **不执行 effect** —— 订阅没注册，store 一改
// 也不会回流到组件，所以"切 tab → 选模型"这套交互在这里驱动不起来（试过，白折腾）。
// 那部分改由 tools/verify-panel.ps1（真实 React + 真 DOM）覆盖：
//   挂载 → 切「单图 AI」tab → 把模型下拉切到 mv → 断言四个方位角视角槽与按钮存在。

for (const kw of ['三视图建模', '前视图', '侧视图', '俯视图', '分辨率', '导出']) {
  if (!allText.includes(kw)) warnings.push(`渲染文案里没有 "${kw}"`)
}
console.log(`  按钮文案：${collectStrings(tree).filter((t) => t.startsWith('导出') || t.startsWith('◉') || t.startsWith('○') || t === '重新生成' || t === '复位视角' || t === '×').join(' | ')}`)

// 渲染期不应有 effect 被执行（shim 不执行），但应登记了若干 effect
console.log(`  登记了 ${React.__effects.length} 个 effect（shim 不执行；浏览器里会跑）`)
if (React.__effects.length === 0) warnings.push('一个 effect 都没登记，three.js 视口可能不会初始化')

// ---------------------------------------------------------------------------
// 3. 空模型状态：不该崩，且应给出提示
// ---------------------------------------------------------------------------

console.log()
console.log('=== 3. 空状态下再次渲染（模拟无图）===')
const React2 = makeShim()
const Panel2 = createModelerPanel(React2)
try {
  const tree2 = Panel2({})
  const text2 = collectStrings(tree2).join(' ')
  if (!text2.includes('模型会显示在这里') && !text2.includes('拖入')) {
    failures.push('空状态没有给用户任何引导文案')
  } else {
    console.log('  ✔ 空状态给出了引导文案')
  }
  // 空状态下"重新生成"以外，导出按钮应当是禁用的
  const exportBtns = (function findButtons(n, out = []) {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { for (const c of n) findButtons(c, out); return out }
    if (n.tag === 'button') out.push(n)
    if (n.children) findButtons(n.children, out)
    return out
  })(tree2)
  // 导出入口现在只有一个「导出 ▾」（格式在卡里选），没网格时必须禁用，
  // 否则点开是一张卡、里面每个按钮都点不动，反而更迷惑。
  const disabledExports = exportBtns.filter((b) => {
    const t = collectStrings(b).join('')
    return t.startsWith('导出') && b.props.disabled === true
  })
  if (disabledExports.length !== 1) {
    warnings.push(`空状态下应有 1 个导出入口被禁用，实际 ${disabledExports.length}`)
  } else {
    console.log('  ✔ 空状态下「导出 ▾」是禁用的')
  }
} catch (e) {
  failures.push(`空状态渲染抛错：${e.message}`)
}

// ---------------------------------------------------------------------------
// 4. 组件的 key 与 hooks 用法
// ---------------------------------------------------------------------------

console.log()
console.log('=== 4. 细节检查 ===')
// 视图槽是用 map 出来的，应带 key
const slotWrappers = hosts.filter((h) => h.tag === 'div' && h.props?.style?.borderRadius === 10)
console.log(`  卡片式容器 ${slotWrappers.length} 个`)
if (slotWrappers.length < 3) warnings.push('三张视图卡片的容器数少于 3，布局可能与预期不同')

// 检查 style 里没有 undefined 值（常见笔误）
let undefinedStyles = 0
const scanStyle = (o, path = '') => {
  if (!o || typeof o !== 'object') return
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) { undefinedStyles++; failures.push(`style.${path}${k} 是 undefined`) }
    else if (v && typeof v === 'object' && !Array.isArray(v)) scanStyle(v, `${path}${k}.`)
  }
}
for (const h of hosts) scanStyle(h.props.style || {}, `${h.tag}.`)
console.log(`  style 里 undefined 值：${undefinedStyles} 个`)

console.log()
if (warnings.length) {
  console.log(`警告 ${warnings.length} 条：`)
  for (const w of warnings) console.log('  - ' + w)
}
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('UI 组件树渲染通过：骨架元素齐全、三个视图槽就位、导出按钮齐全、无 undefined 样式。')
