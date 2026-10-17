/**
 * 把 client/index.js 里 openPopup 的"独立视口"实现整段换成"整个面板独立"。
 *
 * 用脚本而不是编辑器手工替换的原因：要换掉的区间有 100+ 行，逐字抄写 old_string
 * 很容易漏字符导致匹配失败。这里按行号切，并**先校验首尾锚点**，防止行号漂移改错地方。
 */

import fs from 'node:fs'

const F = 'D:/dsh-modeler/src/client/index.js'
const src = fs.readFileSync(F, 'utf8')
const lines = src.split('\n')

const startIdx = lines.findIndex((l) => l.includes('3D 预览 · dsh-modeler'))
const endIdx = lines.findIndex((l) => l.includes('popupView = { vp, canvas, sub }'))
if (startIdx < 0) throw new Error('没找到起始锚点（3D 预览 · dsh-modeler）')
if (endIdx < 0) throw new Error('没找到结束锚点（popupView 赋值）')
if (endIdx <= startIdx) throw new Error(`锚点顺序不对：${startIdx} -> ${endIdx}`)

const head = lines[startIdx]
const tail = lines[endIdx]
if (!/3D 预览 · dsh-modeler/.test(head)) throw new Error(`起始锚点不符：${head}`)
if (!/popupView = \{ vp, canvas, sub \}/.test(tail)) throw new Error(`结束锚点不符：${tail}`)

const newLines = [
  "    + '<title>三视图建模 · dsh-modeler</title></head><body><div id=\"dsh-modeler-mount\"></div></body></html>',",
  '  )',
  '  w.document.close()',
  '',
  '  // 把主窗口的样式表复制进 popup：面板大量使用 var(--dsh-*)，不复制会掉成兜底色',
  '  adoptStyles(w.document)',
  '',
  '  const base = w.document.createElement(\'style\')',
  '  base.textContent = `',
  '    html,body{margin:0;height:100%}',
  '    body{background:var(--dsh-bg,#0e131b);color:var(--dsh-text,#e6edf7);',
  '      font:13px/1.65 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}',
  '    #dsh-modeler-mount{height:100%;display:flex;flex-direction:column}',
  '  `',
  '  w.document.head.appendChild(base)',
  '',
  '  // 在 popup 自己的 document 里**另建一棵 React root**。',
  '  // ⚠ 这是整个方案的关键：React 18 把事件委托绑在 root container 上，所以 root 必须',
  '  //   建在 popup 的容器里，popup 内的点击才会被 React 收到（见文件顶部那段说明）。',
  '  //   两棵 root 之间靠 panel.js 的模块级 store 同步状态，所以换窗口不丢东西。',
  '  popupRoot = createRoot(w.document.getElementById(\'dsh-modeler-mount\'))',
  '  popupRoot.render(React.createElement(getPanelComponent(), null))',
  '',
  '  popupWin = w',
]

const out = lines.slice(0, startIdx).concat(newLines, lines.slice(endIdx + 1))
fs.writeFileSync(F, out.join('\n'), 'utf8')
console.log(`替换完成：${lines.length} 行 -> ${out.length} 行（换了 ${endIdx - startIdx + 1} 行）`)
