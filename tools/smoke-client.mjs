/**
 * 客户端 bundle 冒烟测试 —— **不需要浏览器**，用 Node 的 vm 把 lib/client.js 跑一遍。
 *
 * 这个文件曾经被外部改动删掉过（2026-10-15），这里重建并写清楚它守什么：
 *
 *   1. bundle 是 lazy-CJS 包装（`window.__ModuleLoader__.load({id, factory})`），
 *      factory 能被调用并返回模块对象；
 *   2. `name === 'modeler'`；
 *   3. **`inject` 必须是数组**。这是踩过的坑：写成 `{ required: [], optional: [] }` 时
 *      DSH 的 web boot 会把 required/optional 当**服务名**去等，插件永远停在
 *      `pending (waiting for services: required, optional)`，而**界面上只表现为
 *      "没有那个按钮"、零报错** —— 这条断言就是为了让那种写法立刻红。
 *   4. `apply(ctx)` 能跑通，且把两个入口 + 浮层注册到预期槽位；
 *   5. apply 返回 dispose 函数，且重复调用不炸。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = 'D:/dsh-modeler'
const BUNDLE = path.join(ROOT, 'lib', 'client.js')

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✔ ${msg}`)
  else { console.log(`  ✘ ${msg}`); failed++ }
}

if (!fs.existsSync(BUNDLE)) {
  console.error(`找不到 ${BUNDLE} —— 先跑 build/build.mjs`)
  process.exit(1)
}
const src = fs.readFileSync(BUNDLE, 'utf8')
console.log(`bundle ${(src.length / 1024).toFixed(1)} KB`)

// ---- 1. lazy-CJS 包装 ----
let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
        return spec.factory(() => ({}))
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  globalThis: null,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
sandbox.document = {
  createElement: () => ({
    style: {},
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    getContext: () => null,
  }),
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  body: { appendChild() {} },
}
// react / react-dom 由 DSH 注入，这里给最小替身
const fakeReact = {
  createElement: (...a) => ({ __el: a }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  Fragment: Symbol('Fragment'),
}

const ctxVm = vm.createContext(sandbox)
try {
  vm.runInContext(src, ctxVm, { filename: 'lib/client.js' })
  ok(!!loaded, '1. bundle 调用了 __ModuleLoader__.load')
  ok(loaded && loaded.id === 'dsh-modeler', `2. 模块 id = ${loaded && loaded.id}`)
} catch (e) {
  ok(false, `bundle 执行抛错：${e.message}`)
}

if (!loaded) { console.log(`\n失败 ${failed} 项`); process.exit(1) }

// ---- 2. factory 返回的模块 ----
let mod = null
try {
  mod = loaded.factory((id) => {
    if (id === 'react') return fakeReact
    if (id === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (id === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: Symbol() }
    throw new Error(`未预期的依赖请求：${id}`)
  })
  ok(true, '3. factory() 返回模块对象')
} catch (e) {
  // 依赖替身不全时也要如实报告，而不是掩盖
  ok(false, `factory() 抛错：${e.message}`)
}

if (!mod) { console.log(`\n失败 ${failed} 项`); process.exit(1) }

ok(mod.name === 'modeler', `4. name = ${JSON.stringify(mod.name)}`)

// 5. inject 必须是数组（最要命的那条）
ok(Array.isArray(mod.inject), `5. inject 是数组（实际 ${Array.isArray(mod.inject) ? 'Array' : typeof mod.inject}：${JSON.stringify(mod.inject)}）`)
if (Array.isArray(mod.inject)) {
  ok(mod.inject.includes('slots'), `6. inject 含 'slots'（实际 ${JSON.stringify(mod.inject)}）`)
}

ok(typeof mod.apply === 'function', '7. 导出 apply 函数')

// ---- 3. apply 注册到哪些槽位 ----
if (typeof mod.apply === 'function') {
  const registered = []
  const injected = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      inject(slot, fn) { injected.push(slot); return fn() },
      register(spec, comp) {
        registered.push({ slot: spec.name, id: spec.id, order: spec.order, comp })
        return () => {}
      },
    },
  }
  let dispose = null
  try {
    dispose = mod.apply(fakeCtx)
    ok(true, '8. apply(ctx) 未抛错')
  } catch (e) {
    ok(false, `apply(ctx) 抛错：${e.message}`)
  }

  const slots = registered.map((r) => r.slot).sort()
  const want = ['conversation.composer.dock', 'shell.overlay', 'sidebar.footer.action'].sort()
  ok(JSON.stringify(slots) === JSON.stringify(want),
    `9. 注册槽位 = ${JSON.stringify(slots)}（期望 ${JSON.stringify(want)}）`)

  const ids = registered.map((r) => r.id).sort()
  ok(JSON.stringify(ids) === JSON.stringify(['modeler-dock', 'modeler-entry', 'modeler-overlay']),
    `10. 注册 id = ${JSON.stringify(ids)}`)

  ok(registered.every((r) => typeof r.comp === 'function'), '11. 注册的都是函数组件')

  ok(typeof dispose === 'function', '12. apply 返回 dispose 函数')
  if (typeof dispose === 'function') {
    try { dispose(); dispose(); ok(true, '13. dispose 可重复调用') }
    catch (e) { ok(false, `dispose 抛错：${e.message}`) }
  }
}

console.log(failed ? `\n失败 ${failed} 项` : '\n客户端 bundle 冒烟通过')
process.exit(failed ? 1 : 0)
