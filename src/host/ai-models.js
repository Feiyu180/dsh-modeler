/**
 * 建模 AI 的 provider 注册表 + 本地环境探测 + 适配推荐。
 *
 * 设计取舍（重要）：
 *   这里**只做声明**，不把三个模型的运行逻辑搬进来。因为它们的跑法差别很大 ——
 *   TripoSR 走独立的 python311 环境；Zero123 / Hunyuan3D 要走 ComfyUI 的嵌入式 python
 *   （复用它的 Stable Zero123、Hunyuan3D DiT / ShapeVAE / DINOv2 编码器）。硬凑一个统一
 *   的 run() 只会把三种调用方式揉成一团。所以 provider 只描述：
 *     怎么显示 / 怎么判断可用 / 打到哪个端点
 *   加新模型 = 在这里加一条 + 在 host 加对应端点。UI 会自动出现新按钮。
 *
 * 环境探测的目标：让"首次安装"能按这台机器的实际配置（显存 / 内存 / 磁盘 / 已有权重）
 * 告诉用户"你能跑哪些、还缺什么、缺的怎么装"。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// 安装方案（一键下载那些"能跑但还没装"的模型）
// ---------------------------------------------------------------------------

// ModelScope 取文件的 URL。⚠ 别在 URL 里混进尖括号之类的装饰字符 ——
// 之前就因为这个拿到 404（FilePath=<xxx> 把 <> 也当成路径的一部分了）。
const ms = (repo, file) => `https://www.modelscope.cn/api/v1/models/${repo}/repo?Revision=master&FilePath=${file}`

/**
 * 每个模型的下载清单。只收**实际验证过能下、下完就能用**的来源 ——
 * 宁缺毋滥：给一个装不上的方案比不给更糟。
 *
 * 注意这里**不含 TripoSR**：它的权重当初不是从 ModelScope 取的，我没有能担保的官方源，
 * 所以不提供一键安装，面板会如实提示需要手动准备。
 */
export const INSTALL_PLANS = {
  hunyuan3d: {
    label: 'Hunyuan3D-2（精细）',
    dir: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full',
    files: [
      {
        label: 'DiT 权重（三维原生生成的主模型）',
        url: ms('AI-ModelScope/Hunyuan3D-2', 'hunyuan3d-dit-v2-0-turbo/model.fp16.safetensors'),
        name: 'dit-fp16.safetensors',
        bytes: 4930777530,
      },
      {
        label: 'VAE 权重（体素解码）',
        url: ms('AI-ModelScope/Hunyuan3D-2', 'hunyuan3d-vae-v2-0/model.fp16.safetensors'),
        name: 'vae-fp16.safetensors',
        bytes: 428455666,
      },
      {
        label: 'DINOv2-giant 编码器（必须 giant：hidden 1536，large 是 1024 装不上）',
        url: ms('AI-ModelScope/dinov2-giant', 'model.safetensors'),
        name: 'dinov2-giant.safetensors',
        bytes: 4546005432,
      },
    ],
  },
  zero123: {
    label: 'Zero123 多视角',
    // ckpt 要落在脚本读的那个绝对路径下（不是靠 ComfyUI 扫描）
    dir: 'D:\\dsh-data\\ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints',
    files: [
      {
        label: 'Stable Zero123 权重',
        url: ms('AI-ModelScope/stable-zero123', 'stable_zero123.ckpt'),
        name: 'stable_zero123.ckpt',
        bytes: 8584287851,
      },
    ],
  },
  hunyuan3dmv: {
    label: 'Hunyuan3D-2mv（多视图）',
    // 与单图版**同目录**：VAE、DINOv2 编码器直接复用，只多一个 mv 的 DiT 权重
    dir: 'D:\\dsh-data\\dsh-triposr\\hunyuan-full',
    files: [
      {
        label: '多视图 DiT 权重（前/左/后/右 一起推理的版本）',
        url: ms('AI-ModelScope/Hunyuan3D-2mv', 'hunyuan3d-dit-v2-mv-turbo/model.fp16.safetensors'),
        name: 'dit-mv-fp16.safetensors',
        // ⚠ 与单图 turbo 的 DiT **字节数完全相同**（4,930,777,530）却是两套权重，
        //   所以只能靠文件名区分（dit-fp16 vs dit-mv-fp16）—— 比大小是分辨不出来的。
        bytes: 4930777530,
      },
    ],
  },
}

/** 面板用的安装方案摘要（不含 URL，避免把长串塞进 UI） */
export function listInstallPlans() {
  return Object.entries(INSTALL_PLANS).map(([id, p]) => {
    const bytes = p.files.reduce((s, f) => s + (f.bytes || 0), 0)
    return {
      id,
      label: p.label,
      dir: p.dir,
      bytes,
      totalGB: +(bytes / 1024 ** 3).toFixed(2),   // 统一用 GiB，和磁盘显示的 G 对齐
      steps: p.files.map((f) => ({
        label: f.label,
        name: f.name,
        gb: +((f.bytes || 0) / 1024 ** 3).toFixed(2),
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// provider 声明
// ---------------------------------------------------------------------------

/**
 * @param {{ triposr: object, zero123: object, hunyuan: object }} paths host 侧的实际路径配置
 */
export function listProviders(paths) {
  const p = paths || {}
  return [
    {
      id: 'triposr',
      label: 'TripoSR',
      endpoint: '/single',
      kind: 'mesh',          // 直接产出网格
      input: 'single',       // 需要 1 张图
      note: '单图直接出网格，最轻量；细节偏糊（2024 初的模型）',
      needs: ['python-triposr', 'weights-triposr'],
      cost: { seconds: 60, vramMB: 2000, diskMB: 2000 },
      present: () => {
        const t = p.triposr || {}
        return [
          fileOk(t.python, 'python'),
          dirOk(t.cwd, 'TripoSR 源码'),
          fileOk(path.join(t.weights || '', 'model.ckpt'), '权重 model.ckpt'),
        ]
      },
    },
    {
      id: 'zero123',
      label: 'Zero123 多视角',
      endpoint: '/zero123',
      kind: 'views',         // 产出三个正交视角，再由面板做视觉外壳
      input: 'single',
      note: '绕圈生成前/侧/俯 → 视觉外壳雕刻；轮廓清楚但没有颜色',
      needs: ['python-comfy', 'weights-zero123'],
      cost: { seconds: 40, vramMB: 3500, diskMB: 9000 },
      present: () => {
        const z = p.zero123 || {}
        return [
          fileOk(z.python, 'ComfyUI 嵌入式 python'),
          fileOk(z.script, '生成脚本'),
          fileOk(z.ckpt, '权重 stable_zero123.ckpt'),
        ]
      },
    },
    {
      id: 'hunyuan3d',
      label: 'Hunyuan3D-2（精细）',
      endpoint: '/hunyuan',
      kind: 'mesh',
      input: 'single',
      note: '三维原生生成，几何最细、比例最准；约 130 秒，没有颜色',
      needs: ['python-comfy', 'weights-hunyuan'],
      cost: { seconds: 130, vramMB: 6000, diskMB: 12000 },
      present: () => {
        const h = p.hunyuan || {}
        return [
          fileOk(h.python, 'ComfyUI 嵌入式 python'),
          fileOk(h.script, '推理脚本'),
          fileOk(path.join(h.dir || '', 'dit-fp16.safetensors'), 'DiT 权重'),
          fileOk(path.join(h.dir || '', 'vae-fp16.safetensors'), 'VAE 权重'),
          fileOk(path.join(h.dir || '', 'dinov2-giant.safetensors'), 'DINOv2-giant 编码器'),
        ]
      },
    },
    {
      id: 'hunyuan3dmv',
      label: 'Hunyuan3D-2mv（多视图）',
      endpoint: '/hunyuan-mv',
      kind: 'mesh',
      // 输入是**多张**：front / left / back / right（绕物体一圈的方位角视角，没有 top）
      input: 'multi',
      note: '前/左/后(/右) 一起推理，背面一致性明显好于单图；'
        + '但条件序列是 N×1370 token，**显存需求随视角数陡增**：实测 8G 卡上 2 个视角就已经在'
        + 'OOM/崩溃之间摇摆、3 个视角会把显示驱动打崩（TDR）',
      needs: ['python-comfy', 'weights-hunyuan-mv'],
      // ⚠ 门槛是**实测标定**的，不是估的：本机 8G + 没装 xformers/flash-attn 时
      //   1 视图正常、2 视图不可用、3 视图触发驱动复位 → 按"至少 2 视图能用"给到 11G。
      //   本机因此会被判为"跑不动"，这正是我们想要的：不能让用户点一下就把桌面打闪断。
      cost: { seconds: 130, vramMB: 11000, diskMB: 17000 },
      present: () => {
        const h = p.hunyuan || {}
        return [
          fileOk(h.python, 'ComfyUI 嵌入式 python'),
          fileOk(h.scriptMv, '多视图推理脚本'),
          // mv 版复用单图版的 VAE / 编码器，只多一个 DiT
          fileOk(h.ditMv || path.join(h.dir || '', 'dit-mv-fp16.safetensors'), '多视图 DiT 权重'),
          fileOk(path.join(h.dir || '', 'vae-fp16.safetensors'), 'VAE 权重'),
          fileOk(path.join(h.dir || '', 'dinov2-giant.safetensors'), 'DINOv2-giant 编码器'),
        ]
      },
    },
  ]
}

function fileOk(p, label) {
  try {
    return { ok: !!(p && fs.existsSync(p) && fs.statSync(p).isFile()), label, path: p || '' }
  } catch {
    return { ok: false, label, path: p || '' }
  }
}

function dirOk(p, label) {
  try {
    return { ok: !!(p && fs.existsSync(p) && fs.statSync(p).isDirectory()), label, path: p || '' }
  } catch {
    return { ok: false, label, path: p || '' }
  }
}

/** 给每个 provider 附上"缺什么"的结果，供 UI 直接渲染 */
export function describeProviders(paths) {
  return listProviders(paths).map((it) => {
    let checks = []
    try { checks = it.present() } catch { checks = [] }
    const missing = checks.filter((c) => !c.ok)
    return {
      id: it.id,
      label: it.label,
      endpoint: it.endpoint,
      kind: it.kind,
      input: it.input,
      note: it.note,
      cost: it.cost,
      available: missing.length === 0,
      checks: checks.map((c) => ({ label: c.label, ok: c.ok, path: c.path })),
      missing: missing.map((c) => c.label),
    }
  })
}

// ---------------------------------------------------------------------------
// 本地环境探测
// ---------------------------------------------------------------------------

function run(exe, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const fin = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { try { c.kill() } catch { /* 忽略 */ } fin('') }, timeoutMs)
      c.stdout.on('data', (d) => { out += d.toString('utf8') })
      c.stderr.on('data', (d) => { out += d.toString('utf8') })
      c.on('error', () => { clearTimeout(timer); fin('') })
      c.on('close', () => { clearTimeout(timer); fin(out) })
    } catch {
      fin('')
    }
  })
}

async function probeGpu() {
  const txt = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,driver_version',
    '--format=csv,noheader,nounits',
  ])
  const gpus = []
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const [name, totalMB, usedMB, driver] = t.split(',').map((s) => s.trim())
    if (!name) continue
    gpus.push({
      name,
      totalMB: Number(totalMB) || 0,
      usedMB: Number(usedMB) || 0,
      freeMB: Math.max(0, (Number(totalMB) || 0) - (Number(usedMB) || 0)),
      driver: driver || '',
    })
  }
  return gpus
}

function probeMemory() {
  const totalMB = Math.round(os.totalmem() / 1024 / 1024)
  const freeMB = Math.round(os.freemem() / 1024 / 1024)
  return { totalMB, freeMB, usedMB: totalMB - freeMB }
}

async function probeDisks() {
  // ⚠ 不要用 fs.statfsSync：实测在 Windows 上它对 C:/D:/E: 一律返回 0（blocks/bsize 拿不到值）。
  // 改用 CIM 查逻辑卷 —— 顺带只列出**真实存在**的盘符（U 盘没插就不会冒出来），
  // 而且能直接拿到字节数，不用自己换算扇区。
  const txt = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | ForEach-Object { "$($_.DeviceID)|$($_.FreeSpace)|$($_.Size)" }',
  ], 20000)
  const out = []
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.includes('|')) continue
    const [dev, free, size] = t.split('|')
    const totalGB = Number(size) / 1024 ** 3
    const freeGB = Number(free) / 1024 ** 3
    if (!Number.isFinite(totalGB) || totalGB <= 0) continue
    out.push({
      drive: String(dev).replace(':', '').trim(),
      totalGB: Math.round(totalGB * 10) / 10,
      freeGB: Math.round((Number.isFinite(freeGB) ? freeGB : 0) * 10) / 10,
    })
  }
  return out
}

function probePython(candidates) {
  return candidates.map((c) => ({
    label: c.label,
    path: c.path,
    exists: (() => { try { return !!c.path && fs.existsSync(c.path) } catch { return false } })(),
  }))
}

function probeComfy(root) {
  const nodes = [
    ['nodes_hunyuan3d.py', 'Hunyuan3D-2'],
    ['nodes_stable3d.py', 'Stable Zero123 / SV3D'],
    ['nodes_trellis2.py', 'Trellis 2'],
    ['nodes_triposplat.py', 'TripoSplat'],
    ['nodes_mesh_postprocess.py', '网格后处理（上色/减面/UV）'],
    ['nodes_save_3d.py', '3D 导出'],
  ]
  const found = []
  if (root) {
    for (const [file, label] of nodes) {
      try { if (fs.existsSync(path.join(root, 'comfy_extras', file))) found.push(label) } catch { /* 忽略 */ }
    }
  }
  return { root: root || '', exists: (() => { try { return !!root && fs.existsSync(root) } catch { return false } })(), capabilities: found }
}

function probeDirSize(p) {
  let total = 0
  try {
    for (const f of fs.readdirSync(p)) {
      try {
        const st = fs.statSync(path.join(p, f))
        if (st.isFile()) total += st.size
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return total
}

/**
 * 探测本机环境。全部为只读操作 —— 不装、不改、不下载。
 * @param {object} paths host 的路径配置（见 listProviders）
 */
export async function probeEnvironment(paths) {
  const p = paths || {}
  const t = p.triposr || {}
  const h = p.hunyuan || {}

  const [gpu] = await Promise.all([probeGpu()])
  const memory = probeMemory()
  const disks = await probeDisks()
  const pythons = probePython([
    { label: 'TripoSR 独立环境', path: t.python },
    { label: 'ComfyUI 嵌入式', path: h.python || (p.zero123 || {}).python },
    { label: 'DSH 自带运行时', path: p.runtimePython },
  ])
  const comfyui = probeComfy(p.comfyRoot)

  // 已有权重的体积（只数目录里的大文件，不递归整棵树，避免慢）
  const weightDirs = {
    triposr: t.weights || '',
    zero123: (p.zero123 || {}).weightsDir || '',
    hunyuan3d: h.dir || '',
  }
  const weights = {}
  for (const [k, dir] of Object.entries(weightDirs)) {
    weights[k] = dir && fs.existsSync(dir)
      ? { dir, bytes: probeDirSize(dir) }
      : { dir: dir || '', bytes: 0 }
  }

  return {
    time: new Date().toISOString(),
    platform: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: (os.cpus()[0] || {}).model || '',
      cores: os.cpus().length,
      node: process.version,
    },
    gpu,
    memory,
    disks,
    pythons,
    comfyui,
    weights,
  }
}

// ---------------------------------------------------------------------------
// 适配推荐
// ---------------------------------------------------------------------------

/**
 * 按本机配置 + 现有安装情况，给出"能跑什么 / 还缺什么 / 怎么装"。
 * 判据只用实测能得到的东西：显存、内存、磁盘空闲、权重是否已就位。
 */
export function recommend(env, providers) {
  const list = Array.isArray(providers) ? providers : []
  const gpu = (env.gpu && env.gpu[0]) || null
  const vram = gpu ? gpu.totalMB : 0
  const ram = (env.memory && env.memory.totalMB) || 0
  const diskFreeGB = Math.max(...((env.disks || []).map((d) => d.freeGB || 0)), 0)

  // 每个模型的最低要求（保守估计，实测得出：Hunyuan3D 需要 ~6GB 显存才稳，
  // Zero123 约 3.5GB，TripoSR 即使没显卡也能在 CPU 上慢慢跑）
  const need = {
    triposr: { vramMB: 0, ramMB: 6000, diskGB: 4 },
    zero123: { vramMB: 3500, ramMB: 8000, diskGB: 12 },
    hunyuan3d: { vramMB: 6000, ramMB: 10000, diskGB: 16 },
    // mv 的门槛按"至少能跑 2 个视角"标定（实测 8G 上 2 视图不可用、3 视图会打崩驱动）
    hunyuan3dmv: { vramMB: 11000, ramMB: 10000, diskGB: 16 },
  }

  return list.map((it) => {
    const n = need[it.id] || { vramMB: 0, ramMB: 0, diskGB: 0 }
    const blockers = []
    if (vram < n.vramMB) blockers.push(`显存不足（有 ${Math.round(vram / 1024)}G，需要约 ${Math.round(n.vramMB / 1024)}G）`)
    if (ram < n.ramMB) blockers.push(`内存不足（有 ${Math.round(ram / 1024)}G，需要约 ${Math.round(n.ramMB / 1024)}G）`)
    if (diskFreeGB < n.diskGB) blockers.push(`磁盘不足（空闲 ${diskFreeGB.toFixed(1)}G，需要约 ${n.diskGB}G）`)

    let verdict
    if (it.available) {
      // 已经装好了就直接标 ready —— 此时再报"磁盘不足"只会让人困惑（它明明能跑）。
      //
      // ⚠ 但**显存/内存是运行时硬约束**，装好了也照样跑不动，必须照报。
      //   踩到的实例：Hunyuan3D-2mv 权重装好了（available=true），但本机 8G 显存跑不动
      //   多视图 → 按旧逻辑会显示"已就绪"，而面板上按钮又是禁用的，两边自相矛盾。
      const runtimeBlockers = blockers.filter((b) => b.startsWith('显存') || b.startsWith('内存'))
      if (runtimeBlockers.length) {
        verdict = 'blocked'
        blockers.length = 0
        blockers.push(...runtimeBlockers)
      } else {
        verdict = 'ready'
        blockers.length = 0
      }
    } else if (blockers.length) {
      verdict = 'blocked'      // 这台机器跑不动
    } else {
      verdict = 'installable'  // 能跑，只是还没装
    }

    return {
      id: it.id,
      label: it.label,
      verdict,
      blockers,
      missing: it.missing || [],
      cost: it.cost || null,
      note: it.note,
    }
  })
}
