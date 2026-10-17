/**
 * 在 app.asar 的原始字节里找 "react-dom/client"，判断 DSH 的平台模块表是否提供它。
 *
 * 为什么这么查：asar 是「头部 JSON 索引 + 明文文件内容」，未压缩，所以直接在整包字节流里
 * 搜字符串就能知道有没有哪个前端 chunk 引用它。如果 DSH 自己的前端代码 import 了
 * react-dom/client，说明模块表里有这个条目 —— 我们的插件也能 require 到，
 * 那"在 popup 里重建 React root"这条路才成立。
 *
 * 同时把命中处的上下文打出来，区分「模块表注册」和「只是动态 import 表达式」。
 */

import fs from 'node:fs'

const ASAR = 'D:/dsh/resources/app.asar'
const NEEDLE = 'react-dom/client'

const buf = fs.readFileSync(ASAR)
console.log(`asar ${(buf.length / 1024 / 1024).toFixed(1)} MB`)

const hits = []
let from = 0
for (;;) {
  const i = buf.indexOf(NEEDLE, from, 'latin1')
  if (i < 0) break
  hits.push(i)
  from = i + 1
  if (hits.length > 200) break
}
console.log(`"${NEEDLE}" 命中 ${hits.length} 处`)

// 看每处前后的上下文，判断是"映射表键"还是"import 语句"
const shown = new Set()
let n = 0
for (const i of hits) {
  const start = Math.max(0, i - 90)
  const end = Math.min(buf.length, i + NEEDLE.length + 90)
  const ctx = buf.toString('utf8', start, end).replace(/[\r\n]+/g, ' ')
  // 去重：上下文相似就跳过，避免同一处被反复打印
  const key = ctx.slice(30, 110)
  if (shown.has(key)) continue
  shown.add(key)
  console.log(`  …${ctx}…`)
  n += 1
  if (n >= 14) break
}

// 顺便确认 react-dom 主包也在
for (const probe of ['"react-dom"', 'react-dom/server', 'react/jsx-runtime']) {
  const cnt = buf.toString('latin1').split(probe).length - 1
  console.log(`  ${probe} 出现 ${cnt} 次`)
}
