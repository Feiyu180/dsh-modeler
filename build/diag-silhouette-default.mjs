/** 最小复现：为什么对 front.png 用**默认参数**调 silhouette 会报"剪影为空"。 */
import fs from 'node:fs'
import { silhouette } from '../src/core/geometry.js'
import { decodePNG } from '../src/core/png.js'

const png = decodePNG(fs.readFileSync('D:/dsh-modeler/samples/user/front.png'))
console.log('PNG:', png.width, 'x', png.height, ' 字段:', Object.keys(png).join(','))

// alpha 分布：判断是不是走了"透明通道"那条分支
let aMin = 255, aMax = 0, aLt250 = 0
for (let i = 3; i < png.rgba.length; i += 4) {
  const a = png.rgba[i]
  if (a < aMin) aMin = a
  if (a > aMax) aMax = a
  if (a < 250) aLt250++
}
console.log(`alpha: min=${aMin} max=${aMax}  <250 的像素数=${aLt250}  ⇒ hasTransparency=${aLt250 > 0}`)

for (const [label, opt] of [
  ['默认（无 opt）', undefined],
  ['{}', {}],
  ['fillHoles:false', { fillHoles: false }],
  ['auto:false thr=0.64', { auto: false, threshold: 0.64 }],
]) {
  try {
    const s = silhouette({ data: png.rgba, width: png.width, height: png.height }, opt)
    const b = s.bbox
    console.log(`${label.padEnd(22)} OK  阈值=${s.threshold.toFixed(4)} alphaUsed=${s.alphaUsed}` +
      `  bbox=${b.x0},${b.y0}→${b.x1},${b.y1} (${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1})  返回字段: ${Object.keys(s).join(',')}`)
  } catch (e) {
    console.log(`${label.padEnd(22)} 抛错: ${e.message.slice(0, 60)}`)
  }
}
