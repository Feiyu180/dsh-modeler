"""
Zero123 多视角生成 —— 供插件调用（host 侧 spawn 这个脚本）。

产出三个**正交视角**图，交给插件的视觉外壳用：
    front  : elevation 0  , azimuth 0     （正前）
    side   : elevation 0  , azimuth 90    （正侧）
    top    : elevation 75 , azimuth 0     （俯视 —— 见下面说明）

⚠ 关于 top 为什么用 75° 而不是正俯视 90°：
  Zero123 的训练数据以小仰角为主，正俯视（90°）会画成乱糟糟的一团（实测确认）。
  75° 仍然清晰、且轮廓接近俯视，是可用性与准确度之间的折中。
  代价是那一根轴会有约 15% 的尺寸偏差（插件会给出「三视图尺寸不自洽」警告）。

用法：
    python zero123-views-cli.py --image <输入图> --out <输出目录> [--steps 24] [--size 256]
输出：
    <out>/front.png、side.png、top.png
    <out>/meta.json（含每张的相机参数与耗时）
"""

import argparse
import json
import os
import sys
import time

COMFY = os.environ.get('COMFY_ROOT', r'D:\dsh-data\ComfyUI_windows_portable\ComfyUI')
if COMFY not in sys.path:
    sys.path.insert(0, COMFY)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
import torch  # noqa: E402

import comfy.clip_vision  # noqa: E402
import comfy.model_management as mm  # noqa: E402
import comfy.sd  # noqa: E402
import comfy.utils  # noqa: E402
from comfy_extras.nodes_stable3d import camera_embeddings  # noqa: E402
import nodes  # noqa: E402

CKPT = os.environ.get('HY3D_ZERO123_CKPT', os.path.join(COMFY, 'models', 'checkpoints', 'stable_zero123.ckpt'))

VIEWS = [
    ('front', 0.0, 0.0),
    ('side', 0.0, 90.0),
    ('top', 75.0, 0.0),
]

# 跑完是否主动卸载模型 + 清空显存缓存（面板上的「自动卸载模型」开关，默认开）
FREE_AFTER = os.environ.get('HY3D_FREE_AFTER', '1') == '1'


def free_gpu_resources():
    """主动卸载模型并清空显存缓存。

    本脚本是独立进程，退出时显存自然会归还；显式再清一次是为了**更早、更确定** ——
    在 8G 卡上和别的任务抢显存时（比如同时跑模型训练）这一点很实际。
    由面板的「自动卸载模型」开关控制（HY3D_FREE_AFTER=0 可关）。
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
            print('[free] 已卸载模型，显存缓存 %.0f MB -> %.0f MB' % (before, after), flush=True)
        else:
            print('[free] 已卸载模型（本机无 CUDA）', flush=True)
    except Exception as e:  # noqa: BLE001
        # 清理失败不能影响"结果已经写盘"这件事
        print('[free] 跳过（%s: %s）' % (type(e).__name__, e), flush=True)


def tensor_to_pil(t):
    # vae.decode 的输出带 grad，直接 .numpy() 会报 requires-grad 错误
    arr = (t.detach().clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
    return Image.fromarray(arr)


def unwrap(res):
    """common_ksampler 各版本返回形式不一，统一拆成 dict"""
    if isinstance(res, tuple):
        res = res[0] if len(res) == 1 else res
    if hasattr(res, 'result'):
        res = res.result
    if isinstance(res, (tuple, list)):
        res = res[0]
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--image', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--steps', type=int, default=24)
    ap.add_argument('--size', type=int, default=256)
    ap.add_argument('--cfg', type=float, default=4.0)
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    W = H = int(args.size)
    os.makedirs(args.out, exist_ok=True)
    t_all = time.time()

    print('[1] 加载 stable_zero123.ckpt', flush=True)
    # fp16 + LOW_VRAM 是 8 GB 卡上跑得动的前提（fp32 权重 8.6 GB，必然 OOM）
    mm.vram_state = mm.VRAMState.LOW_VRAM
    model, clip, vae = comfy.sd.load_checkpoint_guess_config(
        CKPT, output_vae=True, output_clip=True, output_clipvision=False,
        model_options={'dtype': torch.float16},
    )[:3]
    t_load = time.time() - t_all

    print('[2] 提取 ckpt 自带的 CLIP Vision（ViT-L/14，768 维）', flush=True)
    # 不能用 ComfyUI 的 clip_vision_g（那是 ViT-H，1280 维），模型要 768 维：
    # cc_projection 是 Linear(772,768)，会报 mat1 1x1284 vs mat2 772x768
    sd_all = comfy.utils.load_torch_file(CKPT, safe_load=True, device='cpu')
    if 'state_dict' in sd_all:
        sd_all = sd_all['state_dict']
    vis_sd = {k[len('cond_stage_model.model.'):]: v
              for k, v in sd_all.items() if k.startswith('cond_stage_model.model.')}
    # prefix='visual.' 不能省：convert_to_transformers 靠它剥离前缀，
    # 而 load_clipvision_from_sd 靠层号（layers.22）判断是不是 ViT-L/14
    clip_vision = comfy.clip_vision.load_clipvision_from_sd(vis_sd, prefix='visual.', convert_keys=True)
    if clip_vision is None:
        raise RuntimeError('CLIP Vision 组装失败')

    print(f'[3] 读输入图 {args.image}', flush=True)
    im = Image.open(args.image).convert('RGB').resize((W, H), Image.LANCZOS)
    img = torch.from_numpy(np.array(im).astype(np.float32) / 255.0).unsqueeze(0)

    out = clip_vision.encode_image(img)
    pooled = out.image_embeds.unsqueeze(0)
    pixels = comfy.utils.common_upscale(img.movedim(-1, 1), W, H, 'bilinear', 'center').movedim(1, -1)
    # ⚠ VAE 编码前必须卸载 UNet，否则 8 GB 卡在 256×256 就 OOM
    mm.unload_all_models()
    mm.soft_empty_cache()
    t_lat = vae.encode(pixels[:, :, :, :3])

    meta = {'image': args.image, 'size': W, 'steps': args.steps, 'cfg': args.cfg,
            'loadSeconds': round(t_load, 1), 'views': {}}

    for i, (key, el, az) in enumerate(VIEWS):
        t0 = time.time()
        cam = camera_embeddings(float(el), float(az))
        cond = torch.cat([pooled, cam.to(pooled.device).repeat((pooled.shape[0], 1, 1))], dim=-1)
        positive = [[cond, {'concat_latent_image': t_lat}]]
        negative = [[torch.zeros_like(pooled), {'concat_latent_image': torch.zeros_like(t_lat)}]]
        latent = {'samples': torch.zeros([1, 4, H // 8, W // 8])}

        res = unwrap(nodes.common_ksampler(
            model, args.seed + i, args.steps, args.cfg, 'euler', 'normal',
            positive, negative, latent, denoise=1.0,
        ))
        samples = res['samples'] if isinstance(res, dict) else res
        pil = tensor_to_pil(vae.decode(samples)[0])
        p = os.path.join(args.out, f'{key}.png')
        pil.save(p)
        dt = round(time.time() - t0, 1)
        meta['views'][key] = {'elevation': el, 'azimuth': az, 'seconds': dt, 'file': p}
        print(f'[4] {key:6s} el={el:5.1f} az={az:5.1f}  {dt:5.1f}s  -> {p}', flush=True)

    meta['totalSeconds'] = round(time.time() - t_all, 1)
    with open(os.path.join(args.out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f'[5] 完成，合计 {meta["totalSeconds"]}s', flush=True)
    # 结果已写盘，再清显存（顺序重要：清理失败也不能影响已落盘的输出）
    if FREE_AFTER:
        free_gpu_resources()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
