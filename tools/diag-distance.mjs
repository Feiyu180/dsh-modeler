/**
 * 把 distanceField + chamfer 原样抽出来执行，打印中间量。
 * 上一次抽取失败是因为残留了 export 关键字、以及切片切到了下一个函数头，这次修正。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'src', 'core', 'geometry.js'), 'utf8')

function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  if (i < 0) throw new Error('找不到起点: ' + startMarker)
  const j = src.indexOf(endMarker, i + startMarker.length)
  if (j < 0) throw new Error('找不到终点: ' + endMarker)
  return src.slice(i, j + endMarker.length)
}

let distFn = grab('export function distanceField(', '\n}\n')
const chamferFn = grab('function chamfer(d, nx, ny, nz) {', '\n}\n')
// 把源码里的 export 去掉，最后统一导出（否则重复导出）
distFn = distFn.replace('export function distanceField', 'function distanceField')

const code = `
const D1 = 3, D2 = 4, D3 = 5
const BIG = 0x3fffffff
${chamferFn}
${distFn}
export { distanceField, chamfer }
export const _peek = { D1, BIG }
`

const tmp = path.join(here, '_tmp-df2.mjs')
fs.writeFileSync(tmp, code, 'utf8')
const M = await import('file://' + tmp.replace(/\\/g, '/') + '?t=' + Date.now())
const { D1, BIG } = M._peek

// 复刻 distanceField 的中间量（用同一份 chamfer）
function peek(occ, nx, ny, nz) {
  const boxed = Uint8Array.from(occ)
  const n = nx * ny * nz
  const outside = new Int32Array(n)
  for (let i = 0; i < n; i++) outside[i] = boxed[i] ? BIG : 0
  M.chamfer(outside, nx, ny, nz)
  const inside = new Int32Array(n)
  for (let i = 0; i < n; i++) inside[i] = boxed[i] ? 0 : BIG
  const insideBefore = Int32Array.from(inside)
  M.chamfer(inside, nx, ny, nz)
  return { boxed, outside, inside, insideBefore, nx, ny, nz }
}

const n = 7
const occ = new Uint8Array(n * n * n).fill(1)
// 挖掉正中的一格 (3,3,3)
occ[(3 * n + 3) * n + 3] = 0

const p = peek(occ, n, n, n)
const I = (x, y, z) => (z * n + y) * n + x

console.log('n=7，只有 (3,3,3) 是空格')
console.log('occ:      (3,3,3) =', occ[I(3, 3, 3)], ' (2,3,3) =', occ[I(2, 3, 3)])
console.log('boxed:    (3,3,3) =', p.boxed[I(3, 3, 3)], ' (2,3,3) =', p.boxed[I(2, 3, 3)])
console.log('inside初: (3,3,3) =', p.insideBefore[I(3, 3, 3)], '(2,3,3) =', p.insideBefore[I(2, 3, 3)])
console.log('inside后: (3,3,3) =', p.inside[I(3, 3, 3)], '(2,3,3) =', p.inside[I(2, 3, 3)], '(1,3,3) =', p.inside[I(1, 3, 3)])
console.log('outside:  (3,3,3) =', p.outside[I(3, 3, 3)], '(2,3,3) =', p.outside[I(2, 3, 3)])
console.log()
console.log('期望：实体 inside = 到最近空格的距离（(2,3,3)→1, (1,3,3)→2），空格 inside = 0')
console.log('      实体 inside 若全是 0，说明 chamfer 的 min 被"自身种子 0"吃掉了')
console.log()
const r = M.distanceField(occ, n, n, n, { pad: 0 })
console.log('distanceField 实际: (3,3,3) =', r.field[I(3, 3, 3)], '(2,3,3) =', r.field[I(2, 3, 3)], '(1,3,3) =', r.field[I(1, 3, 3)])
fs.unlinkSync(tmp)
