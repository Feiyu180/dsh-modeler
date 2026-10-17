/**
 * 直接跑一遍 ai-models.js 的 provider 探测 / 环境探测 / 推荐逻辑。
 *
 * 为什么能脱离 DSH 跑：这个模块是纯函数 + 只读探测，不依赖 Cordis 上下文，
 * 所以可以在 host 重启之前先验证它的输出是否正确。
 */

import { describeProviders, probeEnvironment, recommend } from '../src/host/ai-models.js'

const paths = {
  triposr: {
    python: 'D:\\dsh-data\\dsh-triposr\\python311\\python.exe',
    cwd: 'D:\\dsh-data\\dsh-triposr\\TripoSR-main',
    weights: 'D:\\dsh-data\\dsh-triposr\\weights',
  },
  zero123: {
    python: 'D:\\dsh-data\\ComfyUI_windows_portable\\python_embeded\\python.exe',
    script: 'D:\\dsh-data\\dsh-triposr\\zero123-views-cli.py',
    ckpt: 'D:\\dsh-data\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints\\stable_zero123.ckpt',
    weightsDir: 'D:\\dsh-data\\dsh-triposr\\weights',
  },
  hunyuan: {
    python: 'D:\\dsh-data\\ComfyUI_windows_portable\\python_embeded\\python.exe',
    script: 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-run.py',
    // ⚠ 多视图那两个字段漏了的话，hunyuan3dmv 会误报"缺 多视图推理脚本" ——
    //   我第一版就漏了，测出来的"缺项"其实是夹具自己不全（真实 /providers 是"就绪"）。
    scriptMv: 'D:\\dsh-data\\dsh-triposr\\hunyuan3d-mv-run.py',
    ditMv: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full\\dit-mv-fp16.safetensors',
    dir: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full',
  },
  comfyRoot: 'D:\\dsh-data\\ComfyUI_windows_portable\\ComfyUI',
}

const provs = describeProviders(paths)
console.log('--- providers ---')
for (const p of provs) {
  const miss = p.missing.length ? `缺: ${p.missing.join(' / ')}` : '齐备'
  console.log(`  ${p.id.padEnd(11)} available=${String(p.available).padEnd(5)} ${miss}`)
}

const env = await probeEnvironment(paths)
console.log('--- environment ---')
console.log('  platform:', env.platform.os, env.platform.arch, `cores=${env.platform.cores}`, env.platform.node)
console.log('  gpu:', env.gpu.map((g) => `${g.name} ${Math.round(g.totalMB / 1024)}G (空闲 ${Math.round(g.freeMB / 1024)}G) drv ${g.driver}`).join('; ') || '未检测到')
console.log('  mem:', `${Math.round(env.memory.totalMB / 1024)}G 总 / ${Math.round(env.memory.freeMB / 1024)}G 空闲`)
console.log('  disk:', env.disks.map((d) => `${d.drive}: ${d.freeGB}G 空闲 / ${d.totalGB}G`).join('  '))
console.log('  python:', env.pythons.map((p) => `${p.label}=${p.exists ? '有' : '无'}`).join('  '))
console.log('  comfyui:', env.comfyui.exists ? `${env.comfyui.capabilities.length} 项能力: ${env.comfyui.capabilities.join(' / ')}` : '未找到')
console.log('  weights:', Object.entries(env.weights).map(([k, v]) => `${k}=${v.bytes ? Math.round(v.bytes / 1024 / 1024) + 'MB' : '无'}`).join('  '))

console.log('--- recommend ---')
for (const r of recommend(env, provs)) {
  const extra = r.blockers.length ? `  ⛔ ${r.blockers.join('; ')}` : ''
  const miss = r.missing.length ? `  缺: ${r.missing.join('/')}` : ''
  console.log(`  ${r.label.padEnd(22)} ${r.verdict}${extra}${miss}`)
}
