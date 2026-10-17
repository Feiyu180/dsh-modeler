/**
 * host 侧端点测试台。
 *
 * 为什么需要它：host 半边的代码改动**必须重启 DSH 才生效**，而重启是用户手动做的。
 * 在等重启的空档里想验证 /install、/environment 这些新端点，就只能自己把 host 模块
 * 拉起来：伪造一个 ctx（tools.register / webServer.register 都收下），拿到真正的
 * handleApi 处理器，再用一个本地 http server 把它暴露出来。
 *
 * 这样测的是**真实的路由代码**（不含 DSH 的加载器），只差一个 DSH 的 ctx。
 *
 * 用法：
 *   node tools/host-harness.mjs 19399          # 起在 19399，常驻
 *   curl -s http://127.0.0.1:19399/dsh-modeler/api/providers
 */
import http from 'node:http'
import { apply } from '../src/host/index.js'

const port = Number(process.argv[2] || 19399)

let handler = null
const registered = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (t) => { registered.push(t && t.name); return () => {} } },
  webServer: {
    register: (r) => { handler = r && r.handler; return () => {} },
  },
}

apply(ctx, {})
if (typeof handler !== 'function') {
  console.error('[harness] 没有拿到 handler —— webServer.register 没被调用')
  process.exit(2)
}
console.log(`[harness] tools = ${registered.join(', ')}`)

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((e) => {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
    } catch { /* 头已发出去就算了 */ }
  })
})
server.listen(port, '127.0.0.1', () => {
  console.log(`[harness] listening http://127.0.0.1:${port}/dsh-modeler/api`)
})
