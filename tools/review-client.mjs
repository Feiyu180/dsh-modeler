/**
 * 独立审查脚本 F：lib/client.js 的 DSH lazy-CJS 接线。
 *
 * 不用仓库里的 build/smoke-client.mjs，自己起一个 vm + 假 window.__ModuleLoader__。
 *
 * 运行：
 *   node D:/dsh-modeler/tools/review-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = process.env.DSH_ROOT || 'D:/dsh-modeler'
const BUNDLE = path.join(ROOT, 'lib', 'client.js')
const hdr = (s) => { console.log(''); console.log('='.repeat(72)); console.log(s); console.log('='.repeat(72)) }

const src = fs.readFileSync(BUNDLE, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

hdr('F-1 bundle 静态体检')
console.log(`文件：${path.relative(ROOT, BUNDLE)}  ${(Buffer.byteLength(src) / 1024).toFixed(1)} KB`)
const statics = [
  ['包含 window.__ModuleLoader__.load(', src.includes('window.__ModuleLoader__.load(')],
  [`注册 id 字符串 = ${JSON.stringify(pkg.name)}`, src.includes(`id: ${JSON.stringify(pkg.name)}`) || src.includes(`id: "${pkg.name}"`)],
  ['没有内联 react.production', !/react\.production/.test(src)],
  ['没有 ReactCurrentDispatcher（react 内部符号）', !/ReactCurrentDispatcher/.test(src)],
  ['没有 __SECRET_INTERNALS（react 内部符号）', !/__SECRET_INTERNALS/.test(src)],
  ['没有 sourceMappingURL 注释（否则控制台 404）', !/sourceMappingURL=/.test(src)],
  ['对 react 走 require 外部化', /require\("react"\)/.test(src)],
  ['若出现 react-dom 也必须是 require（而非内联）', !/react-dom/.test(src) || /require\("react-dom/.test(src)],
  ['three.js 已打进 bundle（不该外部化）', /OrbitControls|THREE\.REVISION|BufferGeometry/.test(src)],
  ['没有 require("three")', !/require\("three"\)/.test(src)],
]
for (const [n, ok] of statics) console.log(`  ${ok ? '✅' : '❌'} ${n}`)

// ---------------------------------------------------------------------------
hdr('F-2 在假 __ModuleLoader__ 里执行 bundle，抓注册信息')
let captured = null
const requiredIds = []
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder,
  Uint8Array, Float32Array, Int32Array, Uint32Array, Uint16Array, Int16Array, Int8Array, Uint8ClampedArray,
  ArrayBuffer, DataView, Map, Set, WeakMap, WeakSet, Promise, Math, JSON, Date, Error, Symbol,
  Object, Array, String, Number, Boolean, Function, RegExp,
}
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.globalThis = sandbox
sandbox.window.__ModuleLoader__ = {
  load(reg) {
    captured = reg
  },
}
sandbox.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
}
sandbox.navigator = { userAgent: 'node-vm' }

const ctx = vm.createContext(sandbox)
try {
  vm.runInContext(src, ctx, { filename: 'lib/client.js' })
  console.log('  ✅ bundle 在 vm 里执行未抛错')
} catch (e) {
  console.log(`  ❌ bundle 执行抛错：${e.message}`)
}
console.log(`  捕获到的注册 id = ${JSON.stringify(captured && captured.id)}  ${captured && captured.id === pkg.name ? '✅ 与 package.json 的 name 一致' : '❌ 不一致'}`)
console.log(`  factory 类型 = ${typeof (captured && captured.factory)}  ${typeof (captured && captured.factory) === 'function' ? '✅' : '❌'}`)

// ---------------------------------------------------------------------------
hdr('F-3 调用 factory(require)：react 用 mock，检查导出面')
// 极简 mock React：够 apply() 注册组件 + 触发一次 render 即可
const ReactMock = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }),
  version: '18.0.0-mock',
}
const requireFn = (id) => {
  requiredIds.push(id)
  if (id === 'react') return ReactMock
  if (id === 'react-dom') return { render() {}, createRoot: () => ({ render() {}, unmount() {} }) }
  if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  if (id === 'react/jsx-runtime') return { jsx: ReactMock.createElement, jsxs: ReactMock.createElement, Fragment: ReactMock.Fragment }
  throw new Error(`未预期的外部依赖：${id}`)
}

let exportsObj = null
try {
  exportsObj = captured.factory(requireFn)
  console.log('  ✅ factory(require) 调用成功')
} catch (e) {
  console.log(`  ❌ factory 抛错：${e.message}`)
}
console.log(`  factory 请求过的外部模块 = [${[...new Set(requiredIds)].join(', ')}]`)
console.log(`    ${[...new Set(requiredIds)].every((x) => x === 'react' || x.startsWith('react-dom') || x.startsWith('react/')) ? '✅ 只请求了 react 家族（three 确实被打包了）' : '❌ 请求了非 react 家族的外部模块'}`)
console.log('')
console.log(`  导出的键 = [${exportsObj ? Object.keys(exportsObj).join(', ') : '(无)'}]`)
console.log(`  name = ${JSON.stringify(exportsObj && exportsObj.name)}`)
console.log(`  inject = ${JSON.stringify(exportsObj && exportsObj.inject)}`)
console.log(`  apply 类型 = ${typeof (exportsObj && exportsObj.apply)}  ${typeof exportsObj.apply === 'function' ? '✅' : '❌'}`)

// ---------------------------------------------------------------------------
hdr('F-4 调 apply(ctx)：只该注册到 shell.overlay 与 sidebar.footer.action 两个槽位')
const registered = []
const injected = []
const disposed = []
const ctx2 = {
  logger: { info: (...a) => console.log(`    [插件日志] ${a.join(' ')}`), warn() {}, error() {} },
  slots: {
    inject(name, cb) {
      injected.push(name)
      const d = cb()
      return typeof d === 'function' ? d : () => { disposed.push(name) }
    },
    register(desc, comp) {
      registered.push({ desc, comp, compType: typeof comp })
      return () => disposed.push(desc && desc.name)
    },
  },
}
let dispose = null
try {
  dispose = exportsObj.apply(ctx2)
  console.log('  ✅ apply(ctx) 未抛错')
} catch (e) {
  console.log(`  ❌ apply(ctx) 抛错：${e.stack}`)
}
console.log(`  inject() 过的槽位 = [${injected.join(', ')}]`)
console.log(`  register() 的槽位 = [${registered.map((r) => r.desc.name).join(', ')}]`)
console.log('')
const wantSlots = ['sidebar.footer.action', 'shell.overlay'].sort()
const gotSlots = [...new Set(registered.map((r) => r.desc.name))].sort()
const slotOk = wantSlots.length === gotSlots.length && wantSlots.every((s, i) => s === gotSlots[i])
console.log(`  ${slotOk ? '✅' : '❌'} 注册槽位集合 = {${gotSlots.join(', ')}}，期望 {${wantSlots.join(', ')}}`)
console.log(`  ${registered.every((r) => r.compType === 'function') ? '✅' : '❌'} 注册的都是函数组件`)
const hasUnexpected = registered.filter((r) => !wantSlots.includes(r.desc.name))
console.log(`  ${hasUnexpected.length === 0 ? '✅' : '❌'} 没有注册到第三个槽位（意外注册：${hasUnexpected.map((r) => r.desc.name).join(',') || '无'}）`)
for (const r of registered) {
  console.log(`     槽位 ${r.desc.name}  id=${r.desc.id}  order=${r.desc.order}`)
}
console.log('')
console.log(`  apply 返回类型 = ${typeof dispose}  ${typeof dispose === 'function' ? '✅ 是 dispose 函数' : '❌ 不是函数（框架无法卸载）'}`)
if (typeof dispose === 'function') {
  try { dispose(); console.log('  ✅ dispose() 调用未抛错') } catch (e) { console.log(`  ❌ dispose() 抛错：${e.message}`) }
  try { dispose(); console.log('  ✅ dispose() 二次调用也未抛错（幂等）') } catch (e) { console.log(`  ❌ dispose() 二次调用抛错：${e.message}`) }
}
console.log(`  dispose 记录数 = ${disposed.length}（每个槽位应各有一个）`)

// ---------------------------------------------------------------------------
hdr('F-5 渲染一次组件，确认不依赖浏览器专有 API 就能返回 React 元素树')
{
  // 只用 mock React 的 createElement 递归展开，检查组件能不能调用（不做真实 reconcile）
  const btn = registered.find((r) => r.desc.name === 'sidebar.footer.action')
  if (btn) {
    try {
      if (typeof btn.comp === 'function') {
        // 组件内部用到了 mock 的 useState/useEffect，直接调用即可
        const el = btn.comp({})
        console.log(`  ✅ 入口按钮组件调用成功，返回 ${el && el.type ? `<${typeof el.type === 'string' ? el.type : 'Component'}>` : '(null，因为面板默认关闭是正常的)'}`)
      } else console.log('  ⚠ 入口组件不是可调用函数')
    } catch (e) {
      console.log(`  ❌ 入口按钮组件调用抛错：${e.message}`)
    }
  }
  const ov = registered.find((r) => r.desc.name === 'shell.overlay')
  if (ov) {
    try {
      const el = ov.comp({})
      console.log(`  ✅ 浮层组件调用成功，返回 ${el === null ? 'null（面板默认关闭，符合预期）' : '元素'}`)
    } catch (e) {
      console.log(`  ❌ 浮层组件调用抛错：${e.message}`)
    }
  }
}
