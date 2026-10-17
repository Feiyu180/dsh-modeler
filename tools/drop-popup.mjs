/**
 * 删掉"独立窗口"整块实现，只保留 getPanelComponent。
 *
 * 为什么删：DSH 桌面版把两条路都堵死了 —— window.open 被 Electron 外壳拒绝，
 * Document Picture-in-Picture 在 Electron 里报 "Internal error: no window"。
 * 用户要求把按钮和相关代码一并清掉，不留死代码。
 *
 * 用脚本按锚点切区间（而不是手抄上百行 old_string），并在切之前校验首尾锚点。
 */

import fs from 'node:fs'

const F = 'D:/dsh-modeler/src/client/index.js'
const src = fs.readFileSync(F, 'utf8')
const lines = src.split('\n')

const startIdx = lines.findIndex((l) => l.includes('// 独立窗口（把**整个面板**搬到一个真正独立的浏览器窗口）'))
if (startIdx < 0) throw new Error('找不到起始锚点（独立窗口注释块）')

// 区间结束：下一个区块的标题行（"// 入口按钮"）之前的那个横线注释
const nextSection = lines.findIndex((l, i) => i > startIdx && l.includes('// 入口按钮'))
if (nextSection < 0) throw new Error('找不到结束锚点（入口按钮区块）')
// 往上退两行，把它的上边框注释和空行一起留给后续重建
let endIdx = nextSection - 1
while (endIdx > startIdx && lines[endIdx].trim() === '') endIdx -= 1
if (!lines[endIdx].includes('---')) throw new Error(`结束位置不在分隔线上：${lines[endIdx]}`)
endIdx -= 1 // 连同那条分隔线一起替换掉

const newLines = [
  '// ---------------------------------------------------------------------------',
  '// 面板组件',
  '// ---------------------------------------------------------------------------',
  '//',
  '// 曾经这里还有一套"把面板弹成独立浏览器窗口"的实现（window.open + 在 popup 里另建',
  '// React root）。已删除，原因：DSH 桌面版两头都堵 —— Electron 外壳拒绝 window.open，',
  '// Document Picture-in-Picture 在 Electron 里报 "Internal error: no window"。',
  '// 面板现在就是 DSH 内的非模态浮窗（可拖动 / 缩放 / 最小化 / 记忆位置）。',
  '',
  'let panelComp = null',
  '',
  '/** 面板组件类型（保持单例；状态在 panel.js 的模块级 store 里，关掉再开不丢） */',
  'function getPanelComponent() {',
  '  if (!panelComp) panelComp = createModelerPanel(React, {})',
  '  return panelComp',
  '}',
  '',
  '// ---------------------------------------------------------------------------',
]

const out = lines.slice(0, startIdx).concat(newLines, lines.slice(endIdx + 1))
fs.writeFileSync(F, out.join('\n'), 'utf8')
console.log(`删除完成：${lines.length} 行 -> ${out.length} 行（删掉 ${endIdx - startIdx + 1} 行，写入 ${newLines.length} 行）`)
