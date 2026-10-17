/**
 * 客户端产物的静态冒烟测试（不需要浏览器）。
 *
 * 做法：造一个假的 window.__ModuleLoader__，把 lib/client.js 读进来执行，
 * 拿到 factory 后用桩 require 调用它，检查导出的插件形状。
 * 这样能在"还没装进 DSH"之前就抓到 90% 的低级错误：
 *   - loader 头格式不对 / id 与包名不一致
 *   - react 没被外部化（bundle 里混进 react 会导致双 React 实例）
 *   - 忘了导出 apply / inject
 *   - 语法错误
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const bundlePath = path.join(root, 'lib', 'client.js')

const code = fs.readFileSync(bundlePath, 'utf8')

// --- 1. 必须在 load 之前先有模块系统 ---
assert.ok(code.startsWith('window.__ModuleLoader__.load('), '产物必须以 window.__ModuleLoader__.load( 开头')
assert.ok(code.includes(`id: ${JSON.stringify(pkg.name)}`), `loader id 必须等于包名 ${pkg.name}`)
assert.ok(/return module\.exports;\s*\}\s*\}\);\s*$/.test(code.trimEnd()), '产物结尾必须是 return module.exports 后收尾的 factory 闭合')

// --- 2. react 必须外部化 ---
assert.ok(!/var\s+\w+\s*=\s*__commonJSMin\(.*react/i.test(code.slice(0, 4000)),
  'bundle 开头不应内联 react')
for (const marker of ['react.development', 'react.production', 'ReactCurrentDispatcher$1']) {
  assert.ok(!code.includes(marker), `bundle 里出现了 react 内部实现标记 "${marker}" —— react 没被外部化`)
}
assert.ok(code.includes('require("react")'), '应当通过 require("react") 取平台模块表里的 react')

// --- 3. 用桩执行 ---
const recorded = { id: null, factory: null }
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) {
        recorded.id = def.id
        recorded.factory = def.factory
      },
    },
  },
  console,
}
sandbox.window.window = sandbox.window
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

assert.equal(recorded.id, pkg.name, 'loader 收到的 id')
assert.equal(typeof recorded.factory, 'function', 'factory 必须是函数')

// 桩 require：只给 react 系；别的都要报错（如果代码还 require 别的，说明外部化名单不对）
const REQUIRED = new Set()
// 桩必须够"像"：类组件里的 `class X extends React.Component` 是**模块求值期**就跑的，
// 少了 Component 会直接 TypeError: Class extends value undefined —— 那报的是桩的问题，
// 不是产物的问题，很容易误判成"改坏了"。
class StubComponent {
  constructor(props) { this.props = props || {} }
  setState() {}
  forceUpdate() {}
  render() { return null }
}
const reactStub = {
  Component: StubComponent,
  PureComponent: StubComponent,
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  createRef: () => ({ current: null }),
  createContext: (v) => ({ Provider: null, Consumer: null, _currentValue: v }),
  forwardRef: (f) => f,
  memo: (f) => f,
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useContext: () => ({}),
  useReducer: (r, v) => [typeof v === 'function' ? v() : v, () => {}],
}
const requireStub = (id) => {
  REQUIRED.add(id)
  if (id === 'react' || id === 'react/jsx-runtime') return reactStub
  throw new Error(`产物 require 了未外部化的模块：${id}`)
}

const exportsObj = recorded.factory(requireStub)

// --- 4. 导出形状 ---
assert.equal(typeof exportsObj.apply, 'function', '必须导出 apply')
assert.equal(exportsObj.name, 'modeler', 'name 应为 modeler')

// inject 必须是**数组**。写成 { required: [...], optional: [...] } 时，DSH 的 web boot
// 会把 required / optional 当成两个服务名去等 → 插件永远卡在
//   `dsh-modeler: pending (waiting for services: required, optional)`
// 界面只表现为"左栏没有那个按钮"，报错只在 web-boot 崩溃日志里（这条真踩过）。
assert.ok(
  Array.isArray(exportsObj.inject),
  `inject 必须是数组，实际是 ${JSON.stringify(exportsObj.inject)}；` +
  '写成 {required,optional} 会被当成服务名，插件永远 pending。',
)
assert.ok(
  exportsObj.inject.includes('slots'),
  `client 插件必须 inject slots，实际 ${JSON.stringify(exportsObj.inject)}`,
)

// --- 5. apply 能跑，并且注册到预期的槽位 ---
const registered = []
const ctx = {
  slots: {
    inject(slot, cb) { registered.push({ kind: 'inject', slot }); return cb() },
    register(def) { registered.push({ kind: 'register', name: def.name, id: def.id }); return () => {} },
  },
  logger: { info: () => {} },
}
const dispose = exportsObj.apply(ctx)
assert.equal(typeof dispose, 'function', 'apply 应返回 dispose 函数')

const slots = registered.filter((r) => r.kind === 'register').map((r) => r.name)
// 三个入口都必须在：sidebar.footer.action（原入口，这台机器上那一块实测不渲染）、
// conversation.composer.dock（输入框下方，一定会渲染）、shell.overlay（面板本体）。
assert.deepEqual(
  slots.sort(),
  ['conversation.composer.dock', 'shell.overlay', 'sidebar.footer.action'].sort(),
  `注册的槽位不对：${slots.join(', ')}`,
)

const ids = registered.filter((r) => r.kind === 'register').map((r) => r.id)
for (const id of ids) assert.ok(/^[a-z0-9][a-z0-9.-]*$/i.test(id), `槽位 id 格式可疑：${id}`)

// 清理不应抛
dispose()

console.log(JSON.stringify({
  ok: true,
  bundleKB: Number((Buffer.byteLength(code) / 1024).toFixed(1)),
  pluginId: recorded.id,
  exported: Object.keys(exportsObj).sort(),
  slots: ids,
  externals: [...REQUIRED].sort(),
}, null, 2))
