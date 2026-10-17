/** 把 samples 里某个夹具的剪影打成 ASCII，先看清形状再谈方向。 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/dsh-modeler'
const G = await import(pathToFileURL(path.join(ROOT, 'src/core/geometry.js')).href)
const { decodePNG } = await import(pathToFileURL(path.join(ROOT, 'src/core/png.js')).href)

const names = process.argv.slice(2)
for (const n of names) {
  const png = decodePNG(fs.readFileSync(path.join(ROOT, 'samples', `${n}.png`)))
  const s = G.silhouette({ data: png.rgba, width: png.width, height: png.height })
  console.log(`\n### ${n}  ${png.width}×${png.height}  channels=${png.channels}  thr=${s.threshold.toFixed(3)} alphaUsed=${s.alphaUsed}`)
  console.log(`bbox = x${s.bbox.x0}..${s.bbox.x1} y${s.bbox.y0}..${s.bbox.y1}  (w=${s.bbox.width} h=${s.bbox.height})  coverage=${(s.coverage * 100).toFixed(1)}%`)
  const W = 60, H = Math.max(1, Math.round(60 * s.height / s.width / 2))
  for (let r = 0; r < H; r++) {
    let line = '  '
    for (let c = 0; c < W; c++) {
      const x0 = Math.floor(c * s.width / W), x1 = Math.max(x0 + 1, Math.floor((c + 1) * s.width / W))
      const y0 = Math.floor(r * s.height / H), y1 = Math.max(y0 + 1, Math.floor((r + 1) * s.height / H))
      let on = 0, tot = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { tot++; on += s.mask[y * s.width + x] }
      line += on / tot > 0.5 ? '#' : on / tot > 0.05 ? '+' : '.'
    }
    console.log(line)
  }
}
