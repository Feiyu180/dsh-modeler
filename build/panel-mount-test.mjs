/**
 * 面板"全渲染 + 模拟拖图"测试入口（会被 esbuild 打进 tools/panel-mount-test.html）。
 *
 * 与已有验证的分工：
 *   tools/verify-ui.mjs        记录型 React **shim** 跑组件树 —— 能抓组件引用/属性错误，
 *                              但不执行 useEffect、不挂真 DOM、不跑 three.js
 *   tools/verify-browser.ps1   浏览器端**图片读取链路**与 Node 对账
 *   本文件                     **真实 React 18 UMD 挂载 + 真 DOM + 真 three.js +
 *                              用 DataTransfer 模拟拖图**，走完整条用户路径
 *
 * 之所以能直接挂载：`src/ui/panel.js` **不 import React**（React 是 createModelerPanel(React)
 * 的参数），所以这里把全局 React 传进去就行，不需要 alias 或 shim。
 *
 * 注意：esbuild 打成 IIFE 时不支持 top-level await，主逻辑包在 async main() 里。
 */

const STEP_WAIT = 500

function dataUrlToBlob(dataURL) {
  const comma = dataURL.indexOf(',')
  const bin = atob(dataURL.slice(comma + 1))
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  const mime = /^data:([^;,]+)/.exec(dataURL)
  return new Blob([u8], { type: mime ? mime[1] : 'image/png' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => {
  const el = document.getElementById('log')
  if (el) el.innerHTML += `<div class="line">${msg}</div>`
}

async function main() {
  const React = window.React
  const ReactDOM = window.ReactDOM
  if (!React || !ReactDOM) throw new Error('React UMD 没加载')

  log('1. import 面板模块…')
  const mod = await import('../src/ui/panel.js')
  const createModelerPanel = mod.createModelerPanel
  if (typeof createModelerPanel !== 'function') throw new Error('createModelerPanel 不是函数')

  log('2. 用真实 React 挂载面板…')
  const Panel = createModelerPanel(React, {})
  const root = ReactDOM.createRoot(document.getElementById('panel'))
  root.render(React.createElement(Panel))
  await sleep(400)

  const fileInputs = [...document.querySelectorAll('input[type="file"]')]
  // 4 个：前/侧/俯三个雕刻槽 + AI 输入区那一个（默认 single 模式，它必须跟着分支渲染，
  // 早先它只挂在「三视图（AI 融合）」分支上，切到 Zero123 时 ref 为 null、按钮静默失效）。
  log(`3. 找到 ${fileInputs.length} 个 file input（应为 4 个 = 3 个雕刻槽 + 1 个 AI 输入）`)
  if (fileInputs.length !== 4) throw new Error(`file input 数量不对：${fileInputs.length}`)

  const FIX = window.__FIXTURES__
  const keys = ['front', 'side', 'top']
  const results = []
  for (let i = 0; i < 3; i++) {
    const k = keys[i]
    const dt = new DataTransfer()
    dt.items.add(new File([dataUrlToBlob(FIX[k])], `${k}.png`, { type: 'image/png' }))
    fileInputs[i].files = dt.files
    fileInputs[i].dispatchEvent(new Event('change', { bubbles: true }))
    log(`4.${i + 1} 已向第 ${i + 1} 个槽注入 ${k}.png（${dt.files.length} 个文件）`)
    await sleep(STEP_WAIT)
  }

  // 等统计文本出现（计算是 setTimeout(0) + 同步重活，给它几秒）
  log('5. 等重建完成…')
  let stats = ''
  for (let i = 0; i < 120; i++) {
    await sleep(100)
    const txt = document.body.innerText || ''
    if (txt.includes('顶点') && txt.includes('三角形')) { stats = txt; break }
  }

  // ---- 多视图模式（Hunyuan3D-2mv）的输入区 ----
  // 这段只能在真浏览器里验：tab（mode）和模型选择（aiInput）都存在 useShared 的
  // 模块级 store 里，而 verify-ui 那个 React shim 不跑 effect、订阅不生效，驱动不了。
  log('6. 切到「单图 AI」tab 并选多视图模型…')
  const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms))
  const clickByText = (kw) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(kw))
    if (b) b.click()
    return !!b
  }
  const tabOk = clickByText('单图 AI')
  await sleep2(200)
  const sel = [...document.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.textContent.includes('TripoSR')))
  let mvInfo = { tabOk, selectFound: !!sel }
  if (sel) {
    // React 受控组件：直接改 .value 不会触发 onChange，得走原生 setter + 派发 change
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(sel, 'mv')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep2(250)
    const body = document.body.innerText || ''
    const slotLabels = ['前', '左', '后', '右'].filter((k) => body.includes(`${k}（可选）`) || body.includes(`${k}\n`))
    mvInfo = {
      ...mvInfo,
      hasMvOption: [...sel.options].some((o) => o.textContent.includes('2mv')),
      slots: slotLabels.length,
      genBtn: clickByText.length > 0 && !![...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('多视图生成')),
      noTopSlot: body.includes('没有俯视槽'),
    }
    log(`   多视图选项=${mvInfo.hasMvOption} 视角槽=${mvInfo.slots}/4 生成按钮=${mvInfo.genBtn} 说明"没有俯视槽"=${mvInfo.noTopSlot}`)
  } else {
    log('   ⚠ 没找到模型下拉框')
  }

  const canvas = document.querySelector('canvas')
  const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null
  const hasCanvas = !!canvas
  const canvasW = canvas ? canvas.width : 0
  const canvasH = canvas ? canvas.height : 0

  // 诊断：视口容器归 React 渲染、canvas 归 ThreeViewport 创建。
  // 万一 canvas 不存在，必须能一眼分清是"容器没渲染"还是"ensure 没跑/跑了没插画布"。
  const vpBox = document.querySelector('div[style*="position: absolute"][style*="inset: 0px"]')
    || document.querySelector('div[style*="position:absolute"][style*="inset:0"]')
  const diagInfo = {
    canvases: document.querySelectorAll('canvas').length,
    vpBoxFound: !!vpBox,
    vpBoxChildren: vpBox ? vpBox.childElementCount : -1,
    banner: (document.body.innerText || '').includes('3D 预览不可用'),
  }

  // 从统计文本里抠出关键数字
  const pick = (re) => { const m = re.exec(stats); return m ? m[1].trim() : null }
  const tri = pick(/三角形\s+([\d,]+)/)
  const vert = pick(/顶点\s+([\d,]+)/)
  const grid = pick(/体素网格\s+([\d×x]+)/)
  const water = /水密\s+✓\s*是/.test(stats)

  // 断言：三张图都注入成功、canvas 有尺寸、WebGL 上下文在、重建出了三角形
  // **外加**多视图模式的输入区（tab + 下拉 + 四个方位角视角槽 + 生成按钮）
  const mvOk = !!(mvInfo && mvInfo.tabOk && mvInfo.selectFound && mvInfo.hasMvOption
    && mvInfo.slots === 4 && mvInfo.genBtn)
  const payload = {
    fileInputs: fileInputs.length,
    hasCanvas,
    canvasSize: `${canvasW}×${canvasH}`,
    hasWebGL: !!gl,
    diagInfo,
    mv: mvInfo,
    mvOk,
    vertices: vert,
    triangles: tri,
    grid,
    watertight: water,
    // 三张图注入成功 + canvas 有尺寸 + WebGL 上下文在 + 重建出了三角形 + 多视图输入区正常
    ok: fileInputs.length === 4 && hasCanvas && canvasW > 0 && !!gl
      && !!tri && Number(String(tri).replace(/,/g, '')) > 0 && mvOk,
  }
  window.__PANEL_RESULT__ = payload

  document.getElementById('verdict').innerHTML = payload.ok
    ? `<span class="ok">✅ 面板全渲染通过</span> —— 真实 React 挂载 + 三张图注入成功 + `
      + `重建出 ${tri} 个三角形（顶点 ${vert}，网格 ${grid}，水密 ${water ? '✓' : '✗'}），`
      + `canvas ${payload.canvasSize}，WebGL ${payload.hasWebGL ? '就绪' : '缺失'}`
    : `<span class="bad">❌ 未通过</span> —— ${JSON.stringify(payload)}`

  log('6. 完成')
  document.title = payload.ok ? 'panel-mount-OK' : 'panel-mount-FAIL'
}

main().catch((e) => {
  document.getElementById('verdict').innerHTML =
    `<span class="bad">❌ 出错：${(e && e.message) || e}</span>`
  document.title = 'panel-mount-ERROR'
})
