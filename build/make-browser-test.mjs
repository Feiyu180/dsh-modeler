/**
 * 生成 tools/browser-test.html：把三张夹具 PNG（base64）+ Node 端对照值 + 打包好的
 * 浏览器入口一起内联，然后用 headless 浏览器跑一遍并截图。
 *
 * 目的见 build/browser-pipeline.mjs 的注释：验证**浏览器独有的那条图片读取路径**
 * （fetch → createImageBitmap → canvas → getImageData）与 Node 端自研解码器结果一致。
 *
 * 用法：
 *   node build/make-browser-test.mjs            # 生成 HTML
 *   （再用 Edge headless 截图，见 tools/verify-browser.ps1）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

import { silhouette, buildMesh } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const samples = path.join(root, 'samples')
const expected = JSON.parse(fs.readFileSync(path.join(samples, 'expected.json'), 'utf8'))

const RES_OPT = { resolution: 56, padding: 0.06, smooth: 0 }
const CASES = ['box', 'sphere', 'torus-ish']

const fixtures = {}
const expectOut = {}

console.log('Node 端对照值（自研 decodePNG）：')
for (const name of CASES) {
  fixtures[name] = {}
  expectOut[name] = { sil: {} }
  const sils = {}
  for (const k of ['front', 'side', 'top']) {
    const meta = expected[name][k]
    const buf = fs.readFileSync(path.join(samples, meta.file))
    fixtures[name][k] = 'data:image/png;base64,' + buf.toString('base64')
    const png = decodePNG(buf)
    const sil = silhouette({ data: png.rgba, width: png.width, height: png.height })
    sils[k] = sil
    expectOut[name].sil[k] = {
      x0: sil.bbox.x0, y0: sil.bbox.y0, x1: sil.bbox.x1, y1: sil.bbox.y1,
      w: sil.width, h: sil.height,
    }
  }
  const m = buildMesh(sils, RES_OPT)
  expectOut[name].triangles = m.meta.triangleCount
  expectOut[name].watertight = m.meta.watertight
  expectOut[name].volume = m.meta.volume
  expectOut[name].grid = m.meta.grid
  console.log(`  ${name.padEnd(11)} 三角形 ${String(m.meta.triangleCount).padStart(6)}  水密 ${m.meta.watertight ? '是' : '否'}  体积 ${m.meta.volume.toFixed(6)}`)
}

const bundle = await esbuild.build({
  entryPoints: [path.join(here, 'browser-pipeline.mjs')],
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
<title>browser-pipeline-test</title>
<style>
  body { margin: 0; padding: 14px 16px; background: #070a10; color: #dbe6f5;
    font: 13px/1.55 ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  p.ok { color: #8ef0a8; } p.bad { color: #ff9d9d; }
  table { border-collapse: collapse; margin: 0 0 10px; min-width: 560px; }
  th, td { border: 1px solid rgba(120,150,200,.22); padding: 3px 10px; text-align: left; font-size: 12px; }
  th { background: rgba(90,160,255,.12); }
  tr.bad td { background: rgba(255,80,80,.16); color: #ffd0d0; }
</style>
</head>
<body>
<div id="out">running…</div>
<script>window.__FIXTURES__ = ${JSON.stringify(fixtures)};</script>
<script>window.__EXPECT__ = ${JSON.stringify(expectOut)};</script>
<script>${js}</script>
</body>
</html>
`

const out = path.join(root, 'tools', 'browser-test.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`\n已写出 ${path.relative(root, out)}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`)
