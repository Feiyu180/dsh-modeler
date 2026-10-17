"""Hunyuan3D-2（完整版）：单图 → 精细 3D。

为什么用它而不是 TripoSR / Zero123：
  TripoSR 糊成一团；Zero123 是"逐视角重画"，连侧面都还带正脸、细长附件会漂移。
  Hunyuan3D-2 是**在三维空间里直接生成**（DiT 输出 3D latent，VAE 解成体素），
  没有"各视角互相矛盾"这回事。

三个权重的选择（都踩过坑，改之前先读）：
  · DiT / VAE 用**完整版**不用 mini —— ComfyUI 的 ShapeVAE() 硬编码
    width=1024 / mlp_expand_ratio=4，正好是完整版 VAE 的架构；mini 的 decoder 是
    512 / expand=1，装不上会报一屏 "size mismatch ... [512,512] vs [1024,1024]"，
    而且 ShapeVAE 只有一个 width 参数同时管 encoder(1024) 和 decoder(512)，
    表达不了 mini 的混合架构。
  · 视觉编码器用 **DINOv2-giant**（hidden 1536）。模型 cond_in.weight 是 [1024,1536]，
    F.linear 算 input @ weight.T，所以 context 必须 1536。实测：
      siglip-so400m  1152 → mat1 729x1152   vs 1536x1024 ✘
      dino-large     1024 → mat1 1370x1024  vs 1536x1024 ✘
      dino-giant     1536 → 匹配 cond_in.weight [1024,1536] ✔

两个容易踩的细节：
  · 输入图必须 **padding 成正方形**再送进去。DINOv2 会 resize 到 518x518，
    640x1067 的竖图会被横向拉伸 1.67 倍，模型"看到"就是个宽东西 —— 实测输出
    包围盒 1.885 x 1.965 x 1.096（宽=高，完全不对）；padding 后变成
    1.372 x 1.966 x 0.776，宽高比 0.70，才正常。
  · 网格化必须用 **voxel_to_mesh_surfnet**，不是 voxel_to_mesh。
    后者（basic）输出离散体素面片，boundaryEdges == 顶点数（1422080），完全不闭合。

用法（跑在 ComfyUI 的嵌入式 Python 里，因为要 import comfy）：
    set HY3D_IMG=<输入图>  &  <comfy python> hunyuan3d-run.py
环境变量：
    HY3D_IMG   输入图（默认 samples/user/front.png）
    HY3D_OUT   输出目录（默认 D:\\dsh-triposr\\hunyuan-out）
    HY3D_JSON  输出 JSON 路径（给插件用；不设则不写）
    HY3D_OBJ   输出 OBJ 路径（可选）
    HY3D_STEPS 采样步数（默认 8）
    HY3D_OCTREE VAE 八叉树分辨率（默认 256）
"""

import base64
import json
import os
import sys
import time

COMFY = os.environ.get('COMFY_ROOT', r'D:\dsh-data\ComfyUI_windows_portable\ComfyUI')
sys.path.insert(0, COMFY)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
import torch  # noqa: E402

import comfy.clip_vision  # noqa: E402
import comfy.model_management as mm  # noqa: E402
import comfy.sd  # noqa: E402
import comfy.utils  # noqa: E402
from comfy_extras.nodes_hunyuan3d import voxel_to_mesh_surfnet  # noqa: E402
import nodes  # noqa: E402

D = os.environ.get('HY3D_WEIGHTS', r'D:\dsh-data\dsh-triposr\hunyuan-full')
DIT = os.path.join(D, 'dit-fp16.safetensors')
VAE = os.path.join(D, 'vae-fp16.safetensors')
ENC = os.path.join(D, 'dinov2-giant.safetensors')
IMG = os.environ.get('HY3D_IMG', r'D:\dsh-modeler\samples\user\front.png')
OUT = os.environ.get('HY3D_OUT', r'D:\dsh-data\dsh-triposr\hunyuan-out')
JSON_OUT = os.environ.get('HY3D_JSON', '')
OBJ_OUT = os.environ.get('HY3D_OBJ', '')
STEPS = int(os.environ.get('HY3D_STEPS', '8'))
# ⚠ 默认 192 而不是 ComfyUI 节点里的 256：
#   256 → 257³ 网格，surface net 里的中间张量 pos = [N, 8, 3] int64 峰值 3.26 GB（CPU），
#   在 DSH 常驻 + 浏览器 + ComfyUI 模块的 16 GB 机器上会
#   "DefaultCPUAllocator: not enough memory"（实测在插件链路里崩过一次，单独跑却能过 ——
#   差的正是环境里其它常驻进程占的那几 GB）。
#   192 → 193³，峰值降到约 1.4 GB，质量损失很小，稳定性换得很值。
OCTREE = int(os.environ.get('HY3D_OCTREE', '192'))
SEED = 42
# 跑完是否主动卸载模型 + 清空显存缓存（面板上的「自动卸载模型」开关，默认开）
FREE_AFTER = os.environ.get('HY3D_FREE_AFTER', '1') == '1'


def free_gpu_resources():
    """主动卸载模型并清空显存缓存。

    为什么明知道"进程退出就会还显存"还要做：本脚本是独立进程，退出时显存自然会归还，
    但大型 safetensors 的析构不一定及时，而且显式清一次**更早、更确定** ——
    在 8G 卡上和别的任务抢显存时（比如同时跑模型训练）这一点很实际。
    由面板的「自动卸载模型」开关控制（环境变量 HY3D_FREE_AFTER=0 可关）。
    """
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
        # 清理失败绝不能影响"已经算出来的结果已经写盘"这件事
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
    """读图并 padding 成正方形（必须，见文件头说明）。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    s = max(w, h)
    if w != h:
        canvas = Image.new('RGB', (s, s), pad_color)
        canvas.paste(im, ((s - w) // 2, (s - h) // 2))
        im = canvas
    return im, (w, h), (s, s)


def main():
    os.makedirs(OUT, exist_ok=True)
    for p in (DIT, VAE, ENC):
        if not os.path.exists(p):
            print('MISSING ' + p)
            return 1
    t_all = time.time()

    print('[1] load DiT (Hunyuan3D-2 full)')
    mm.vram_state = mm.VRAMState.LOW_VRAM
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

    print('[4] read image (pad to square)')
    im, orig, sq = load_square(IMG)
    print('    %dx%d -> %dx%d' % (orig[0], orig[1], sq[0], sq[1]))
    arr = np.array(im).astype(np.float32) / 255.0
    img = torch.from_numpy(arr).unsqueeze(0)

    print('[5] encode + conditioning')
    o = enc.encode_image(img)
    embeds = o.last_hidden_state
    print('    embeds %s' % (tuple(embeds.shape),))
    positive = [[embeds, {}]]
    negative = [[torch.zeros_like(embeds), {}]]
    latent = {'samples': torch.zeros([1, 64, 3072]), 'type': 'hunyuan3dv2'}

    print('[6] sample (%d steps)' % STEPS)
    t0 = time.time()
    res = unwrap(nodes.common_ksampler(
        model, SEED, STEPS, 1.0, 'euler', 'normal',
        positive, negative, latent, denoise=1.0,
    ))
    samples = res['samples'] if isinstance(res, dict) else res
    print('    OK %.1fs  samples %s' % (time.time() - t0, tuple(samples.shape)))

    print('[7] VAE decode to voxels (octree=%d)' % OCTREE)
    t0 = time.time()
    voxels = vae.decode(samples, vae_options={'num_chunks': 8000, 'octree_resolution': OCTREE})
    print('    OK %.1fs  shape=%s' % (
        time.time() - t0, tuple(voxels.shape) if hasattr(voxels, 'shape') else '?'))

    print('[8] voxel -> mesh (surface net)')
    t0 = time.time()
    vx = voxels
    if hasattr(vx, 'ndim') and vx.ndim == 4:
        vx = vx[0]  # voxel_to_mesh* 里是 D, H, W = shape，只吃 3 维
    # ⚠ 返回的是 (vertices, faces) 元组，**不要**再套 unwrap（unwrap 会取 [0] 丢掉 faces）。
    # 优先放 GPU：此刻 DiT 已卸载、VAE 只占 ~400 MB，8 GB 显存放得下 ~1.4 GB 峰值，
    # 比 CPU 快。万一 GPU 也被别的应用挤了，回退 CPU（octree=192 时 CPU 峰值也才 ~1.4 GB）。
    try:
        verts, faces = voxel_to_mesh_surfnet(vx, threshold=0.6, device=mm.get_torch_device())
    except (torch.AcceleratorError, RuntimeError) as e:
        # 只有内存不足才回退 CPU；别的错照抛，别把真 bug 吞成静默的次优路径。
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
            'colors': None,  # 几何阶段没有颜色（要上色得再跑 paint 模块）
            'vertexCount': int(len(v)),
            'triangleCount': int(len(f)),
            'watertight': False,
            'extents': ext,
            'source': 'hunyuan3d-2mini-full',
            'seconds': round(time.time() - t_all, 1),
        }
        with open(JSON_OUT, 'w', encoding='utf-8') as fp:
            json.dump(data, fp)
        print('    wrote %s  (%.1f MB)' % (JSON_OUT, os.path.getsize(JSON_OUT) / 1024 / 1024))

    if OBJ_OUT:
        with open(OBJ_OUT, 'w', encoding='utf-8') as fp:
            fp.write('# Hunyuan3D-2\n')
            for p in v:
                fp.write('v %.6f %.6f %.6f\n' % (p[0], p[1], p[2]))
            for t in f:
                fp.write('f %d %d %d\n' % (int(t[0]) + 1, int(t[1]) + 1, int(t[2]) + 1))
        print('    wrote %s  (%.1f MB)' % (OBJ_OUT, os.path.getsize(OBJ_OUT) / 1024 / 1024))

    # 结果已经写盘，再清显存（顺序很重要：清理失败也不能影响已落盘的输出）
    if FREE_AFTER:
        free_gpu_resources()

    print('total %.1fs' % (time.time() - t_all))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
