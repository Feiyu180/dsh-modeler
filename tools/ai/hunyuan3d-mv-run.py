"""Hunyuan3D-2mv（多视图版）：前/左/后(/右) 多张图 → 精细 3D。

和单图版（hunyuan3d-run.py）只差 **条件构造**，模型结构完全一样 ——
这是实测出来的：把 mv-turbo 与单图 turbo 的 safetensors 张量表逐项对比，
**都是 1649 个张量、零形状差异**（tools/diff-hunyuan-mv-headers.py）。所以多视图
不是"另一个模型"，而是"同一结构 + 条件序列里放 N 路图像 token"再微调出来的版本。

条件怎么拼：照抄本机 ComfyUI 的官方实现
（comfy_extras/nodes_hunyuan3d.py 的 Hunyuan3Dv2ConditioningMultiView）：
    all_embeds = [front, left, back, right]        # 固定顺序，缺的留 None
    pos = get_1d_sincos_pos_embed_from_grid_torch(1536, arange(4))
    每路: last_hidden_state + pos[i]              # 给"第几个视角"加位置编码
    拼:   torch.cat(out, dim=1)                    # 沿 token 维拼
⚠ 位置编码**必须按固定顺序的下标**（front=0/left=1/back=2/right=3）。
  顺序错了不会报错，只会生成一个"视角错位"的模型 —— 这是本脚本最容易悄悄错的地方。
⚠ 没有 top（俯视）这个槽：mv 的四个视角是绕物体一圈的方位角视角，
  工程三视图里的俯视图**喂不进去**，这是模型的设定，不是我们偷懒。

用法（跑在 ComfyUI 的嵌入式 Python 里，因为要 import comfy）：
    set HY3D_MV_FRONT=... & set HY3D_MV_LEFT=... & <comfy python> hunyuan3d-mv-run.py
环境变量：
    HY3D_MV_FRONT / HY3D_MV_LEFT / HY3D_MV_BACK / HY3D_MV_RIGHT   各视角图（至少给一张）
    HY3D_MV_DIT    DiT 权重（默认 hunyuan-full\\dit-mv-fp16.safetensors）
    HY3D_OUT / HY3D_JSON / HY3D_OBJ / HY3D_STEPS / HY3D_OCTREE / HY3D_FREE_AFTER  同单图版
"""

import base64
import json
import os
import sys
import time

# ⚠ PYTORCH_CUDA_ALLOC_CONF 默认**不动**。
#
# 曾经为了治"free 3.5G 却分不出 20MB"的碎片化，把 expandable_segments 设成默认开 ——
# 结果在 Windows/WDDM 上是负作用：VAE 解码阶段报
#   `expandable_segments: memory mapping failed with OOM ... (free: 5.5G)`
# 也就是**空闲 5.5 G 却连 20 MB 都映射不出来**（它的分段映射要预留虚拟地址空间，
# 在 WDDM 下会失败），还带出次生的 shape 错位报错。
# 所以默认不开；真需要时显式 HY3D_MV_EXPANDABLE=1。
if os.environ.get('HY3D_MV_EXPANDABLE', '0') == '1':
    os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
    print('[alloc] 已开启 expandable_segments（注意：Windows 上可能导致映射失败）')

COMFY = os.environ.get('COMFY_ROOT', r'D:\dsh-data\ComfyUI_windows_portable\ComfyUI')
sys.path.insert(0, COMFY)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
import torch  # noqa: E402

import comfy.clip_vision  # noqa: E402
import comfy.model_management as mm  # noqa: E402
import comfy.sd  # noqa: E402
import comfy.utils  # noqa: E402
from comfy.ldm.modules.diffusionmodules.mmdit import get_1d_sincos_pos_embed_from_grid_torch  # noqa: E402
from comfy_extras.nodes_hunyuan3d import voxel_to_mesh_surfnet  # noqa: E402
import nodes  # noqa: E402

# ⚠ SDPA 后端：多视图下**默认收紧**（只允许 flash / mem-efficient，关掉 math）。
#
# 为什么默认开：条件序列从 1370 涨到 2740 token 后，math 后端（显式构造 N×N 注意力矩阵，
# O(N²)）会在采样阶段直接把显存打满 —— 实测报 "Memory allocation failure"。
# 收紧到 mem-efficient 之后，同样的 2 视图采样一次通过。单视图下它也无害（见回归测试）。
#
# 历史教训（别急着关这个开关就当"没事了"）：这个开关**本身**曾经看起来像元凶 ——
# 开着它时 2 视图在编码第二张图时崩（0xC0000005）。后来查清楚那是另一回事：
# "同一进程里第二次调用 DINOv2 编码器"的问题，已用 batch 一次前向解决。
# 两个坑叠在一起，很容易误判成同一个。
if os.environ.get('HY3D_MV_SDPA_STRICT', '1') == '1':
    try:
        torch.backends.cuda.enable_flash_sdp(True)
        torch.backends.cuda.enable_mem_efficient_sdp(True)
        torch.backends.cuda.enable_math_sdp(False)
        print('[sdpa] 只允许 flash / mem-efficient 后端（math 关闭；省显存的那个）')
    except Exception as _e:  # noqa: BLE001
        print('[warn] 设置 SDPA 后端失败（%s），继续' % _e)

# 显存预检用的经验需求（GB，LOW_VRAM 模式下的峰值）。
# 单图版（1370 token）在 8G 卡上稳定通过，实测峰值约 5-6 GB；条件序列变长主要吃 attention。
VRAM_NEED_GB = {1: 5.0, 2: 6.0, 3: 8.0, 4: 10.0}

# ⚠⚠ "几个视角能跑"的**硬边界**，是实测撞出来的（不是估的）。
#   本机：8 GB 显存 + **没装 xformers / flash-attn**（只有 PyTorch SDPA）：
#     1 视图 → ✅ 正常（99.7s 出网格，87860 顶点）
#     2 视图 → 逐张编码崩在"第二次加载 DINOv2"（已用 batch 修掉）；batch 后采样 OOM
#              （math 后端 → 换 mem-efficient 后过）；VAE 解码又 OOM
#              （free 3.5G 却分不出 20MB，碎片化）→ 加 expandable_segments 后又变成
#              c10.dll 访问冲突。**一直在"崩 / OOM"之间摇摆，等于不可用**。
#     3 视图 → **直接把显示驱动打崩**（TDR，事件 nvlddmkm 153，整个桌面闪断）。
#   所以按总显存给上限，而不是"再试一次赌一把"。
MAX_VIEWS_BY_TOTAL_GB = [(16.0, 4), (11.0, 2), (0.0, 1)]   # (总显存 ≥ X GB, 最多几个视角)


def allowed_views(total_gb):
    for need_gb, n in MAX_VIEWS_BY_TOTAL_GB:
        if total_gb >= need_gb:
            return n
    return 1

D = os.environ.get('HY3D_WEIGHTS', r'D:\dsh-data\dsh-triposr\hunyuan-full')
DIT = os.environ.get('HY3D_MV_DIT', os.path.join(D, 'dit-mv-fp16.safetensors'))
VAE = os.path.join(D, 'vae-fp16.safetensors')
ENC = os.path.join(D, 'dinov2-giant.safetensors')
OUT = os.environ.get('HY3D_OUT', r'D:\dsh-data\dsh-triposr\hunyuan-out')
JSON_OUT = os.environ.get('HY3D_JSON', '')
OBJ_OUT = os.environ.get('HY3D_OBJ', '')
STEPS = int(os.environ.get('HY3D_STEPS', '8'))
OCTREE = int(os.environ.get('HY3D_OCTREE', '192'))
SEED = 42
FREE_AFTER = os.environ.get('HY3D_FREE_AFTER', '1') == '1'

# 顺序**不能改**：位置编码的下标就是这个顺序（见文件头）
VIEW_ORDER = ['front', 'left', 'back', 'right']
VIEW_ENV = {
    'front': 'HY3D_MV_FRONT',
    'left': 'HY3D_MV_LEFT',
    'back': 'HY3D_MV_BACK',
    'right': 'HY3D_MV_RIGHT',
}


def free_gpu_resources():
    try:
        before = 0.0
        if torch.cuda.is_available():
            before = torch.cuda.memory_reserved() / 1024 / 1024
        mm.unload_all_models()
        mm.soft_empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            after = torch.cuda.memory_reserved() / 1024 / 1024
            print('[free] 已卸载模型，显存缓存 %.0f MB -> %.0f MB' % (before, after))
        else:
            print('[free] 已卸载模型（本机无 CUDA）')
    except Exception as e:  # noqa: BLE001
        print('[free] 跳过（%s: %s）' % (type(e).__name__, e))


def unwrap(res):
    if isinstance(res, tuple):
        res = res[0] if len(res) == 1 else res
    if hasattr(res, 'result'):
        res = res.result
    if isinstance(res, (tuple, list)):
        res = res[0]
    return res


def load_square(path, pad_color=(255, 255, 255)):
    """读图并 padding 成正方形（DINOv2 会 resize 到 518²，非方图会被拉伸，见单图版说明）。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    s = max(w, h)
    if w != h:
        canvas = Image.new('RGB', (s, s), pad_color)
        canvas.paste(im, ((s - w) // 2, (s - h) // 2))
        im = canvas
    return im, (w, h), (s, s)


def load_square_batch(paths, pad_color=(255, 255, 255)):
    """把 N 张图各自 padding 成**同一个边长**的正方形，返回 (图像列表, 原始尺寸列表, 边长)。

    为什么要统一边长：这几张图要 **stack 成一个 batch 一次喂给编码器**，
    而 ComfyUI 的 clip_preprocess 要求 batch 内尺寸一致（它内部只做一次 resize/crop）。
    另外方形是必须的，见文件头 —— DINOv2 会 resize 到 518²，非方图会被拉伸。
    """
    ims, origs = [], []
    S = 1
    for p in paths:
        im = Image.open(p).convert('RGB')
        w, h = im.size
        ims.append(im)
        origs.append((w, h))
        S = max(S, w, h)
    out = []
    for im in ims:
        w, h = im.size
        if w != S or h != S:
            canvas = Image.new('RGB', (S, S), pad_color)
            canvas.paste(im, ((S - w) // 2, (S - h) // 2))
            im = canvas
        out.append(im)
    return out, origs, S


def main():
    os.makedirs(OUT, exist_ok=True)
    for p in (DIT, VAE, ENC):
        if not os.path.exists(p):
            print('MISSING ' + p)
            return 1

    provided = []
    for name in VIEW_ORDER:
        path = os.environ.get(VIEW_ENV[name], '').strip()
        if path and os.path.exists(path):
            provided.append((name, path))
        elif path:
            print('  ⚠ %s 给的路径不存在，忽略：%s' % (name, path))
    if not provided:
        print('至少要给一个视角（HY3D_MV_FRONT / LEFT / BACK / RIGHT）')
        return 1
    print('[0] 视角：%s' % ', '.join(n for n, _ in provided))

    # ---- 显存预检（在**任何模型上卡之前**做）----
    # 为什么要有这一道：3 视图在这台 8G 卡上实测把显示驱动打崩过（TDR，桌面闪断）。
    # 与其"再试一次赌一把"，不如在这里直接拒绝 —— 拒绝的代价是用户看到一句说明，
    # 不拒绝的代价是整个桌面跟着一起崩。
    risky = os.environ.get('HY3D_MV_ALLOW_RISKY', '0') == '1'
    if torch.cuda.is_available():
        free_b, total_b = torch.cuda.mem_get_info()
        free_gb, total_gb = free_b / 1024 ** 3, total_b / 1024 ** 3
        need = VRAM_NEED_GB.get(len(provided), 10.0)
        cap = allowed_views(total_gb)
        print('[guard] 显存：总 %.1fG / 空闲 %.1fG；%d 个视角估计需要 %.1fG；本机上限 %d 个视角'
              % (total_gb, free_gb, len(provided), need, cap))
        if len(provided) > cap and not risky:
            print('')
            print('✘ 拒绝执行：本机总显存 %.1fG，多视图最多只支持 %d 个视角（本次给了 %d 个，'
                  '条件序列 %d token）。' % (total_gb, cap, len(provided), len(provided) * 1370))
            print('  实测（本机 8G + 无 xformers/flash-attn）：1 视图正常；2 视图在采样/解码阶段')
            print('  反复 OOM 或崩溃（c10.dll 访问冲突）；3 视图直接把显示驱动打崩（TDR，桌面闪断）。')
            print('  也就是说：这台机器上多视图等于不可用，只有 1 视图能跑（那等价于单图版）。')
            print('  换到 ≥11 GB 显存的卡上会自动放开到 2 个视角，≥16 GB 到 4 个。')
            print('  确实想赌一把：设 HY3D_MV_ALLOW_RISKY=1（后果自负，可能闪断桌面）。')
            return 3
        if free_gb < need and not risky:
            print('')
            print('✘ 拒绝执行：当前空闲显存 %.1fG < 估计需要的 %.1fG。' % (free_gb, need))
            print('  把别的吃显存的任务停掉再试（或设 HY3D_MV_ALLOW_RISKY=1 自行承担风险）。')
            return 3
    else:
        print('[guard] 没有 CUDA —— 会在 CPU 上跑，非常慢')

    t_all = time.time()

    print('[1] load DiT (Hunyuan3D-2mv)')
    # 权重放哪儿：默认 LOW_VRAM（权重留内存、按需换入）。
    # 想更省显存可以设 HY3D_MV_VRAM_STATE=NO（ComfyUI 的 NO_VRAM：每个算子临时换入）。
    #
    # ⚠⚠ 实测结论：**NO_VRAM 在这台机器上不可用**，别以为它是解药。
    #   它确实把编码和采样都跑过了（配下面的分阶段让位），但代价是：
    #     · 采样 4 分钟以上跑不完（CPU 时间 817 s），**GPU 利用率只有 5%** —— 等于在用 CPU 跑模型；
    #     · 日志持续刷 `WARNING:root:Unpin error.`（内存 pin 机制在这台机器上失效）；
    #     · 进程会卡在**不可中断的 GPU 调用**里，Stop-Process / taskkill /F 都杀不掉，
    #       最后只能靠 .NET `Process.Kill()`。
    #   所以 8G 卡上的正确结论是"多视图不可用"，而不是"换个显存策略就能跑"。
    vs = os.environ.get('HY3D_MV_VRAM_STATE', 'LOW').upper()
    mm.vram_state = {
        'NO': mm.VRAMState.NO_VRAM,
        'NORMAL': mm.VRAMState.NORMAL_VRAM,
        'HIGH': mm.VRAMState.HIGH_VRAM,
    }.get(vs, mm.VRAMState.LOW_VRAM)
    print('    显存策略 = %s' % vs)
    t0 = time.time()
    model = comfy.sd.load_diffusion_model(DIT, model_options={'dtype': torch.float16})
    print('    OK %.1fs' % (time.time() - t0))

    print('[2] load VAE')
    t0 = time.time()
    vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(VAE))
    print('    OK %.1fs' % (time.time() - t0))

    print('[3] load DINOv2-giant encoder')
    t0 = time.time()
    enc = comfy.clip_vision.load(ENC)
    if enc is None:
        print('    FAILED to assemble encoder')
        return 1
    print('    OK %.1fs' % (time.time() - t0))

    print('[4] encode %d 个视角 + 拼条件序列' % len(provided))
    t0 = time.time()
    # pos[i] 对应 VIEW_ORDER 里的下标 —— 所以这里用 name 反查下标，而不是用 provided 的顺序
    pos_all = get_1d_sincos_pos_embed_from_grid_torch(1536, torch.arange(4))
    tokens = []
    used = []

    # ⚠⚠ 关键：N 张图 **stack 成一个 batch，只调用一次 encode_image**。
    #
    # 为什么不能一张一张循环调用（这是踩出来的，代价是整台机器崩了两次）：
    #   实测 mv 权重 + 1 个视角完全正常（99.7s 出网格），但只要编码**第二张**图，
    #   python 立刻以 0xC0000005（访问冲突，崩在 torch 的 c10.dll）挂掉 ——
    #   跟条件序列长度、attention、显存规模都无关，是"同一进程里第二次加载
    #   DINOv2 编码器"这条路径的问题（encode_image 内部每次都会 load_model_gpu，
    #   LOW_VRAM 下第一次之后模型被换出，第二次重新换入时踩到了失效的存储）。
    #   ViT 的 batch 维本来就是自由的，一次前向既绕开这条路径，也更快。
    ims, origs, S = load_square_batch([p for _, p in provided])
    for (name, _), im, orig in zip(provided, ims, origs):
        print('    %-5s %dx%d -> %dx%d' % (name, orig[0], orig[1], S, S))

    # 两种编码方式，按显存压力选：
    #   batch  —— 一次前向编码 N 张。最快，但激活峰值是 N 倍（8G 卡上 2 张就在临界线，
    #             实测同一份代码一次过、一次崩）。
    #   reload —— 逐张编码，而且**每张都新建一个编码器对象**。激活峰值只有 1 张，
    #             代价是每张要多花约 20s 重新读权重。它绕开的是另一条路：
    #             "同一进程里第二次调用同一个编码器对象"会踩到失效存储（c10.dll 访问冲突）。
    mode = os.environ.get('HY3D_MV_ENCODE_MODE', 'batch').lower()
    hs = None
    if mode == 'reload' and len(provided) > 1:
        parts = []
        for (name, path), orig in zip(provided, origs):
            e2 = comfy.clip_vision.load(ENC)          # 每次新建，不复用旧对象
            if e2 is None:
                raise RuntimeError('重新加载编码器失败')
            mm.load_models_gpu([e2.patcher])
            one = torch.from_numpy(np.array(ims[provided.index((name, path))]).astype(np.float32) / 255.0).unsqueeze(0)
            out2 = e2.encode_image(one)
            parts.append(out2.last_hidden_state)
            print('    %-5s 单独编码完成 token %s' % (name, tuple(out2.last_hidden_state.shape)))
            # 编完立刻让位，下一张（或采样）才有干净的显存
            mm.unload_all_models()
            mm.soft_empty_cache()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        hs = torch.cat(parts, dim=0)
    else:
        batch = torch.stack([torch.from_numpy(np.array(im).astype(np.float32) / 255.0) for im in ims], dim=0)
        print('    一次前向编码 %d 张（batch %s）' % (len(ims), tuple(batch.shape)))
        o = enc.encode_image(batch)
        hs = o.last_hidden_state
    if hs.shape[0] != len(provided):
        raise RuntimeError('编码器返回的 batch 数不对：%d != %d' % (hs.shape[0], len(provided)))

    # ⚠ 分阶段让位：编码用完就立刻把 DINOv2 从显存里赶走，而且**要放掉 Python 引用**。
    #
    # 为什么"卸载"不够：`mm.unload_all_models()` 只是让 ComfyUI 把权重搬到 CPU；
    # 脚本自己还持有 `enc` / `o` / `batch` 的引用，PyTorch 的 caching allocator 就仍然
    # 认为那些块被占用 —— 于是后面 VAE 解码出现**"free 6.4G 却分不出 18MB"**，
    # 然后 ComfyUI 回退到"tiled VAE 解码"（那是给 2D 图像 VAE 写的），
    # 而 Hunyuan3D 的 3D 八叉树 VAE 不支持 tiled → 报
    # `The size of tensor a (3) must match the size of tensor b (257)`。
    # 一路查下来，这个 shape 报错其实只是"分配失败之后走错了分支"的次生现象。
    # del + gc.collect() + empty_cache 才能真正把块还给分配器。
    if not os.environ.get('HY3D_MV_STAGE_UNLOAD', '1') == '0':
        import gc
        try:
            del o, batch, ims, enc
        except NameError:
            pass
        gc.collect()
        mm.unload_all_models()
        mm.soft_empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            free_b, _ = torch.cuda.mem_get_info()
            print('    [stage] 编码完成：已释放编码器引用并让位给 DiT；当前空闲显存 %.1fG' % (free_b / 1024 ** 3))

    for i, (name, _) in enumerate(provided):
        emb = hs[i:i + 1]
        idx = VIEW_ORDER.index(name)
        # ⚠ 位置编码要显式转成 emb 的 dtype/device：get_1d_sincos_pos_embed_from_grid_torch
        #   默认给 float32，而模型跑在 fp16 —— 直接相加会把条件序列升成 float32，
        #   随后 cond_in（fp16 Linear）就会报 "expected scalar type Half but found Float"。
        pe = pos_all[idx].to(device=emb.device, dtype=emb.dtype).reshape(1, 1, -1)
        tokens.append(emb + pe)
        used.append(name)
        print('    %-5s token %s  pos#%d' % (name, tuple(emb.shape), idx))

    embeds = torch.cat(tokens, dim=1)
    print('    条件序列 %s（%d 路 × %d token）' % (tuple(embeds.shape), len(tokens), embeds.shape[1] // len(tokens)))
    print('    OK %.1fs' % (time.time() - t0))

    positive = [[embeds, {}]]
    negative = [[torch.zeros_like(embeds), {}]]
    latent = {'samples': torch.zeros([1, 64, 3072]), 'type': 'hunyuan3dv2'}

    print('[5] sample (%d steps)' % STEPS)
    t0 = time.time()
    res = unwrap(nodes.common_ksampler(
        model, SEED, STEPS, 1.0, 'euler', 'normal',
        positive, negative, latent, denoise=1.0,
    ))
    samples = res['samples'] if isinstance(res, dict) else res
    print('    OK %.1fs  samples %s' % (time.time() - t0, tuple(samples.shape)))

    # 同理：采样完把 DiT 连**引用**一起放掉，VAE 解码（八叉树体素）才有干净的大块可用。
    # 这里是本轮真正的关键：`model` 这个变量一直握着 DiT，光 unload 不 del，
    # 分配器里那 4.6G 的块就还挂着 —— 于是 VAE 解码"free 6.4G 却分不出 18MB"。
    if not os.environ.get('HY3D_MV_STAGE_UNLOAD', '1') == '0':
        import gc
        del model, positive, negative, res, tokens, embeds
        gc.collect()
        mm.unload_all_models()
        mm.soft_empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            free_b, total_b = torch.cuda.mem_get_info()
            print('    [stage] 采样完成：已释放 DiT 引用并让位给 VAE；当前空闲显存 %.1fG / %.1fG'
                  % (free_b / 1024 ** 3, total_b / 1024 ** 3))

    print('[6] VAE decode to voxels (octree=%d)' % OCTREE)
    t0 = time.time()
    # num_chunks 越大 → 每次处理的体素越少 → 峰值越低（代价是慢一点）。
    # 8G 卡上 VAE 解码是第二个 OOM 高发点，所以给个可调开关。
    chunks = int(os.environ.get('HY3D_MV_CHUNKS', '20000'))
    voxels = vae.decode(samples, vae_options={'num_chunks': chunks, 'octree_resolution': OCTREE})
    print('    OK %.1fs  shape=%s' % (
        time.time() - t0, tuple(voxels.shape) if hasattr(voxels, 'shape') else '?'))

    print('[7] voxel -> mesh (surface net)')
    t0 = time.time()
    vx = voxels
    if hasattr(vx, 'ndim') and vx.ndim == 4:
        vx = vx[0]
    # 返回 (vertices, faces) 元组 —— 别再套 unwrap（会丢掉 faces）
    try:
        verts, faces = voxel_to_mesh_surfnet(vx, threshold=0.6, device=mm.get_torch_device())
    except (torch.AcceleratorError, RuntimeError) as e:
        if isinstance(e, RuntimeError) and 'memory' not in str(e).lower():
            raise
        mm.soft_empty_cache()
        verts, faces = voxel_to_mesh_surfnet(vx, threshold=0.6, device=None)
    print('    OK %.1fs' % (time.time() - t0))

    v = verts.detach().cpu().numpy() if hasattr(verts, 'detach') else np.asarray(verts)
    f = faces.detach().cpu().numpy() if hasattr(faces, 'detach') else np.asarray(faces)
    if v.ndim > 2:
        v = v.reshape(-1, 3)
    if f.ndim > 2:
        f = f.reshape(-1, 3)
    v = np.ascontiguousarray(v, dtype=np.float32)
    f = np.ascontiguousarray(f, dtype=np.uint32)
    print('    verts %d  tris %d' % (len(v), len(f)))

    ext = [float(v[:, i].max() - v[:, i].min()) for i in range(3)]
    print('    extents %s' % ([round(x, 3) for x in ext],))

    if JSON_OUT:
        data = {
            'positions': base64.b64encode(v.tobytes()).decode(),
            'indices': base64.b64encode(f.tobytes()).decode(),
            'colors': None,
            'vertexCount': int(len(v)),
            'triangleCount': int(len(f)),
            'watertight': False,
            'extents': ext,
            'source': 'hunyuan3d-2mv',
            'views': used,
            'seconds': round(time.time() - t_all, 1),
        }
        with open(JSON_OUT, 'w', encoding='utf-8') as fp:
            json.dump(data, fp)
        print('    wrote %s  (%.1f MB)' % (JSON_OUT, os.path.getsize(JSON_OUT) / 1024 / 1024))

    if OBJ_OUT:
        with open(OBJ_OUT, 'w', encoding='utf-8') as fp:
            fp.write('# Hunyuan3D-2mv views=%s\n' % ','.join(used))
            for p in v:
                fp.write('v %.6f %.6f %.6f\n' % (p[0], p[1], p[2]))
            for t in f:
                fp.write('f %d %d %d\n' % (int(t[0]) + 1, int(t[1]) + 1, int(t[2]) + 1))
        print('    wrote %s  (%.1f MB)' % (OBJ_OUT, os.path.getsize(OBJ_OUT) / 1024 / 1024))

    if FREE_AFTER:
        free_gpu_resources()

    print('total %.1fs' % (time.time() - t_all))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
