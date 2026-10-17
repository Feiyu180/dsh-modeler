/**
 * 诊断：为什么角色三视图（白底彩色插画）在 `silhouette` 里被判定为"没有前景像素"。
 *
 * 打印：亮度直方图、Otsu 选中的阈值、各阈值下的前景像素数，
 * 以及 fillHoles 之后的效果 —— 用来判断"自动阈值"是不是选错了。
 */

import fs from 'node:fs'
import { silhouette } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const p = 'D:/dsh-modeler/samples/user/front.png'
const png = decodePNG(fs.readFileSync(p))
const { rgba, width: W, height: H } = png
const n = W * H
console.log(`图 ${W}x${H}  像素 ${n}`)

const lum = new Float32Array(n)
for (let i = 0, q = 0; i < n; i++, q += 4) {
  lum[i] = (0.2126 * rgba[q] + 0.7152 * rgba[q + 1] + 0.0722 * rgba[q + 2]) / 255
}

// 直方图（20 档）
const hist = new Array(20).fill(0)
for (let i = 0; i < n; i++) hist[Math.min(19, Math.floor(lum[i] * 20))]++
console.log('\n亮度直方图（0=黑 → 1=白）:')
const maxH = Math.max(...hist)
for (let b = 0; b < 20; b++) {
  const pct = (hist[b] / n * 100)
  console.log(`  ${(b / 20).toFixed(2)}-${((b + 1) / 20).toFixed(2)}  ${String(hist[b]).padStart(7)}  ${pct.toFixed(2).padStart(6)}%  ${'#'.repeat(Math.round(hist[b] / maxH * 40))}`)
}

// 复刻 geometry.js 里的 otsu（同样的实现，才能对比）
function otsu(values) {
  const bins = 256
  const h = new Float64Array(bins)
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.round(values[i] * (bins - 1))))
    h[b]++
  }
  const total = values.length
  let sum = 0
  for (let b = 0; b < bins; b++) sum += b * h[b]
  let sumB = 0, wB = 0, best = 0, bestVar = -1
  for (let b = 0; b < bins; b++) {
    wB += h[b]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += b * h[b]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) { bestVar = between; best = b }
  }
  return best / (bins - 1)
}
const thr = otsu(lum)
console.log(`\notsu 阈值 = ${thr.toFixed(4)}  （clamp 后 = ${Math.min(0.95, Math.max(0.05, thr)).toFixed(4)}）`)

let below = 0
for (let i = 0; i < n; i++) if (lum[i] <= thr) below++
console.log(`亮度 <= 阈值的像素：${below}  (${(below / n * 100).toFixed(2)}%)`)

console.log('\n不同固定阈值下的剪影前景像素数（走 auto:false 手动阈值）:')
for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  try {
    const s = silhouette({ data: rgba, width: W, height: H }, { auto: false, threshold: t })
    const b = s.bbox
    console.log(`  thr=${t.toFixed(2)}  前景 ${String(s.count).padStart(7)} (${(s.count / n * 100).toFixed(1).padStart(5)}%)  内容框 ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}`)
  } catch (e) {
    console.log(`  thr=${t.toFixed(2)}  失败：${e.message.slice(0, 40)}`)
  }
}

console.log('\n反相 + 各阈值:')
for (const t of [0.3, 0.5, 0.7, 0.9]) {
  try {
    const s = silhouette({ data: rgba, width: W, height: H }, { auto: false, threshold: t, invert: true })
    const b = s.bbox
    console.log(`  invert thr=${t.toFixed(2)}  前景 ${String(s.count).padStart(7)} (${(s.count / n * 100).toFixed(1).padStart(5)}%)  内容框 ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}`)
  } catch (e) {
    console.log(`  invert thr=${t.toFixed(2)}  失败：${e.message.slice(0, 40)}`)
  }
}
