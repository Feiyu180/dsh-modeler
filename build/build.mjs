/**
 * 打 DSH 客户端 bundle。
 *
 * 目标产物严格对齐 DSH 客户端模块系统的 lazy-CJS 协议（以 dsh-context / sidebar-right
 * 的实际产物为准）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       ...esbuild 的 CJS 输出...
 *       return module.exports;
 *     }
 *   });
 *
 * 关键点（踩过的）：
 *   1. only **react / react-dom** 是外部依赖 —— 它们在平台模块表里。
 *      three.js 必须打进来（平台表里没有 three）。
 *   2. id 必须等于 package.json 的 name，否则 /plugins 路由与 loader 对不上。
 *   3. 不能有 sourceMappingURL 指向不存在的文件，否则浏览器控制台一片 404，
 *      所以只在内联 sourcemap 时才输出。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const entry = path.join(root, 'src', 'client', 'index.js')
const outFile = path.join(root, 'lib', 'client.js')

const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `
\t\treturn module.exports;
\t}
});
`

const wrapPlugin = {
  name: 'dsh-client-bundle-wrapper',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return
      const raw = fs.readFileSync(outFile, 'utf8')
      // 去掉 esbuild 自己加的 sourceMappingURL（我们不再生成 map 文件）
      const body = raw.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd()
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, banner + body + footer, 'utf8')
      const kb = (fs.statSync(outFile).size / 1024).toFixed(1)
      console.log(`[build] ${path.relative(root, outFile)}  ${kb} KB   id=${pkg.name}`)
    })
  },
}

const options = {
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'firefox115', 'safari16'],
  // react 家族交给平台的模块表；three 与插件自身代码全部打进来
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'],
  legalComments: 'none',
  treeShaking: true,
  minify: false,
  logLevel: 'info',
  nodePaths: [path.join(here, 'node_modules')],
  plugins: [wrapPlugin],
}

const watch = process.argv.includes('--watch')
if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build] watching…')
} else {
  await esbuild.build(options)
}
