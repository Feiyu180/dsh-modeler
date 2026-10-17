/**
 * 生成 tools/panel-mount-test.html：真实 React UMD + 三张夹具 PNG + 打包好的面板入口，
 * 全部内联成一个自包含页面。
 *
 * 页面自己会：挂载面板 → 用 DataTransfer 往三个槽注入图片 → 等重建 → 报告结果。
 * 然后用 tools/verify-panel.ps1 以 headless 浏览器跑它并截图。
 *
 * 用法：node build/make-panel-mount-test.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const samples = path.join(root, 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

// 用 box 夹具：它最小、最快，而且三视图内容框互不相同，最能暴露轴向错误
const SHAPE = 'box'
const fixtures = {}
for (const k of ['front', 'side', 'top']) {
  const meta = expected[SHAPE][k]
  const buf = fs.readFileSync(path.join(samples, meta.file))
  fixtures[k] = 'data:image/png;base64,' + buf.toString('base64')
}

const reactSrc = fs.readFileSync(path.join(here, 'vendor', 'react.development.js'), 'utf8')
const reactDomSrc = fs.readFileSync(path.join(here, 'vendor', 'react-dom.development.js'), 'utf8')

const bundle = await esbuild.build({
  entryPoints: [path.join(here, 'panel-mount-test.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  write: false,
  nodePaths: [path.join(here, 'node_modules')],
  logLevel: 'warning',
})
const js = bundle.outputFiles[0].text

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>panel-mount-test</title>
<style>
  body { margin: 0; background: #0b0e14; color: #dbe6f5;
    font: 12.5px/1.55 ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif; }
  #top { padding: 10px 14px; border-bottom: 1px solid rgba(120,150,200,.22); }
  #verdict { font-size: 13px; margin: 6px 0 0; }
  .ok { color: #8ef0a8; font-weight: 600; } .bad { color: #ff9d9d; font-weight: 600; }
  #log { padding: 6px 14px; opacity: .7; font: 11px/1.5 ui-monospace, Consolas, monospace; }
  .line { white-space: pre-wrap; }
  /* 面板本身要一个像样的高度，three.js 视口才有尺寸 */
  #panel { height: 1150px; padding: 0 14px 14px; }
</style>
</head>
<body>
<div id="top">
  <strong>面板全渲染测试</strong> —— 真实 React 18 UMD 挂载 + DataTransfer 模拟拖图 + 真 three.js
  <div id="verdict">running…</div>
</div>
<div id="log"></div>
<div id="panel"></div>

<script>${reactSrc}</script>
<script>${reactDomSrc}</script>
<script>window.__FIXTURES__ = ${JSON.stringify(fixtures)};</script>
<script>${js}</script>
</body>
</html>
`

const out = path.join(root, 'tools', 'panel-mount-test.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`已写出 ${path.relative(root, out)}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`)
console.log(`（内联了 React UMD ${(reactSrc.length / 1024).toFixed(0)}KB + ReactDOM ${(reactDomSrc.length / 1024).toFixed(0)}KB + 面板 bundle ${(js.length / 1024).toFixed(0)}KB）`)
