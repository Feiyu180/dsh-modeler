/**
 * 浏览器端三视图管线的验证入口（会被 esbuild 打进 tools/browser-test.html）。
 *
 * 为什么需要它：整条链路里**只有这一段是浏览器独有的** ——
 *   File/Blob → createImageBitmap（含 EXIF 方向）→ canvas → getImageData → RGBA
 * Node 里我用的是自己写的 decodePNG，走的是完全不同的代码路径。
 * 如果这一段有问题（颜色空间、alpha 预乘、canvas 尺寸、EXIF 旋转），
 * 用户在网页里拖图就会得到与 Node 端不一致的剪影 —— 而我的回归测试全在 Node 侧，照不出来。
 *
 * 注意：esbuild 打成 IIFE 时不支持 top-level await，所以主逻辑包在 async main() 里。
 */

import { silhouette, buildMesh } from '../src/core/geometry.js'

const RES_OPT = { resolution: 56, padding: 0.06, smooth: 0 }

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

/**
 * dataURL → Blob。
 *
 * ⚠ 不要用 `fetch(dataURL)`：在 file:// 打开的本页面里，fetch 一个 data: URL 会被
 * 当作跨源请求拦掉（表现为 await 永远不返回，页面停在 "running…"，控制台未必有错）。
 * 直接从 base64 造 Blob 更稳，而且**走的仍然是 createImageBitmap(Blob)** 这条真实路径
 * —— 和面板里把拖进来的 File 交给 createImageBitmap 完全一致。
 */
function dataUrlToBlob(dataURL) {
  const comma = dataURL.indexOf(',')
  const b64 = dataURL.slice(comma + 1)
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  const mime = /^data:([^;,]+)/.exec(dataURL)
  return new Blob([u8], { type: mime ? mime[1] : 'image/png' })
}

async function imageDataOf(dataURL) {
  const blob = dataUrlToBlob(dataURL)
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height)
  bmp.close?.()
  return px
}

const setProgress = (msg) => {
  const el = document.getElementById('out')
  if (el) el.innerHTML = `<p class="run">⏳ ${esc(msg)}</p>`
}

async function main() {
  const FIX = window.__FIXTURES__
  const EXPECT = window.__EXPECT__
  const rows = []
  let allOk = true

  for (const [name, files] of Object.entries(FIX)) {
    const row = { name, checks: [] }
    const sils = {}
    for (const k of ['front', 'side', 'top']) {
      setProgress(`${name} · 读 ${k} 视图…`)
      const px = await imageDataOf(files[k])
      const sil = silhouette({ data: px.data, width: px.width, height: px.height })
      sils[k] = sil
      const exp = EXPECT[name].sil[k]
      const same = sil.bbox.x0 === exp.x0 && sil.bbox.y0 === exp.y0 &&
        sil.bbox.x1 === exp.x1 && sil.bbox.y1 === exp.y1 && sil.width === exp.w && sil.height === exp.h
      if (!same) allOk = false
      row.checks.push({
        what: `${k} 剪影内容框`,
        browser: `${sil.bbox.width}×${sil.bbox.height}`,
        node: `${exp.x1 - exp.x0 + 1}×${exp.y1 - exp.y0 + 1}`,
        ok: same,
      })
    }

    const m = buildMesh(sils, RES_OPT)
    const exp = EXPECT[name]
    const cmp = [
      ['三角形数', m.meta.triangleCount, exp.triangles],
      ['水密', m.meta.watertight, exp.watertight],
      ['体素网格', m.meta.grid.join('×'), exp.grid.join('×')],
    ]
    for (const [what, b, n] of cmp) {
      const ok = String(b) === String(n)
      if (!ok) allOk = false
      row.checks.push({ what, browser: String(b), node: String(n), ok })
    }
    const dv = Math.abs(m.meta.volume - exp.volume) / (Math.abs(exp.volume) || 1)
    const vok = dv < 1e-9
    if (!vok) allOk = false
    row.checks.push({ what: '体积', browser: m.meta.volume.toFixed(6), node: exp.volume.toFixed(6), ok: vok })

    rows.push(row)
  }

  window.__RESULT__ = { allOk, rows }

  let html = `<h1>浏览器端图片读取链路 · 与 Node 端对账</h1>`
  html += `<p class="${allOk ? 'ok' : 'bad'}">${
    allOk
      ? '✅ 全部一致 —— 浏览器（createImageBitmap + getImageData）与 Node（自研 decodePNG）得到完全相同的剪影与网格'
      : '❌ 存在不一致，见下表红色行'
  }</p>`
  for (const r of rows) {
    html += `<table><tr><th colspan="3">${esc(r.name)}</th></tr>`
    for (const c of r.checks) {
      html += `<tr class="${c.ok ? '' : 'bad'}"><td>${esc(c.what)}</td><td>浏览器 ${esc(c.browser)}</td><td>Node ${esc(c.node)}</td></tr>`
    }
    html += `</table>`
  }
  document.getElementById('out').innerHTML = html
  document.title = allOk ? 'browser-test-OK' : 'browser-test-FAIL'
}

main().catch((e) => {
  document.getElementById('out').innerHTML =
    `<p class="bad">❌ 运行出错：${esc(e && e.message ? e.message : e)}</p>`
  document.title = 'browser-test-ERROR'
})
