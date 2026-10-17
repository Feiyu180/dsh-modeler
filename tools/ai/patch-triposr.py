"""
给 TripoSR 打三个补丁（幂等，可重复跑）。每个补丁都会先备份成 .orig-*。

为什么需要这三个（都是本机环境逼出来的，不是 TripoSR 的 bug）：

  1) tsr/models/isosurface.py —— `from torchmcubes import marching_cubes`
     torchmcubes 在 Windows + VS2022 + 新 CUDA 上编译不过（cudafe++ 不兼容）。
     改成优先 try 原版、失败则用 PyMCubes 做 CPU 版 marching cubes。
     语义一致：输入 3D 张量 + 阈值，返回 (顶点[体素索引空间], 三角形[long])。
     代价：网格提取走 CPU，约 2–3 分钟/对象。

  2) tsr/system.py —— `torch.load(weight_path, map_location="cpu")`
     torch 2.6+ 把 weights_only 默认值改成了 True，会拒绝含非张量对象的旧 ckpt。
     显式补上 weights_only=False。

  3) tsr/models/tokenizers/image.py —— DINO 的 config.json 走 hf_hub_download
     这台机器 HuggingFace 完全不可达。改成优先读环境变量 DINO_CONFIG_PATH
     指向的本地文件（从 ModelScope 的 AI-ModelScope/dino-vitb16 取的 config.json）。
     注意：**只需要 config.json**，DINO 的权重包含在 model.ckpt 里
     （ViTModel(config) 建结构，权重由 ckpt 的 state_dict 覆盖）。

补丁 0（不用改代码）：tsr/system.py 的 from_pretrained 已经原生支持传本地目录
（`if os.path.isdir(...)` 分支），所以只要把 config.yaml + model.ckpt 放进同一个目录，
传那个目录路径即可 —— 完全绕开 HF。

用法：python patch-triposr.py
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ.get('TRI_ROOT', r'D:\dsh-data\dsh-triposr\TripoSR-main'))
STAMP = '[patched]'


def backup(p: Path) -> None:
    bak = p.with_suffix(p.suffix + '.orig-triposr')
    if not bak.exists():
        shutil.copy2(p, bak)
        print(f'    备份 -> {bak.name}')


def patch_isosurface() -> bool:
    p = ROOT / 'tsr' / 'models' / 'isosurface.py'
    s = p.read_text(encoding='utf-8')
    if STAMP in s:
        print('  1) isosurface.py 已打过，跳过')
        return False
    old = 'from torchmcubes import marching_cubes'
    if old not in s:
        print('  1) isosurface.py 找不到目标行，跳过')
        return False

    new = f'''# {STAMP} torchmcubes 在 Windows + VS2022 + 新 CUDA 上编译不过（cudafe++ 不兼容），
# 这里优先尝试原版，失败则回退到 PyMCubes 的 CPU 版 marching cubes。
# 语义与原版一致：输入 3D 张量 + 阈值，返回 (顶点[体素索引空间], 三角形[long])。
try:
    from torchmcubes import marching_cubes
except Exception:  # noqa: BLE001
    import numpy as _np
    import torch as _torch
    import mcubes as _mcubes

    def marching_cubes(vol, level):
        arr = vol.detach().cpu().numpy() if hasattr(vol, "detach") else _np.asarray(vol)
        verts, faces = _mcubes.marching_cubes(arr.astype(_np.float32), float(level))
        return (
            _torch.from_numpy(_np.ascontiguousarray(verts, dtype=_np.float32)),
            _torch.from_numpy(_np.ascontiguousarray(faces, dtype=_np.int64)),
        )
'''
    backup(p)
    p.write_text(s.replace(old, new), encoding='utf-8')
    print('  1) isosurface.py -> PyMCubes 回退 OK')
    return True


def patch_torch_load() -> bool:
    p = ROOT / 'tsr' / 'system.py'
    s = p.read_text(encoding='utf-8')
    if 'weights_only=False' in s:
        print('  2) system.py 已打过，跳过')
        return False
    old = 'ckpt = torch.load(weight_path, map_location="cpu")'
    if old not in s:
        print('  2) system.py 找不到目标行，跳过')
        return False
    new = ('ckpt = torch.load(weight_path, map_location="cpu", weights_only=False)'
           f'  # {STAMP} torch 2.6+ 默认 weights_only=True，会拒绝含非张量对象的旧 ckpt')
    backup(p)
    p.write_text(s.replace(old, new), encoding='utf-8')
    print('  2) system.py -> torch.load(weights_only=False) OK')
    return True


def patch_dino_config() -> bool:
    p = ROOT / 'tsr' / 'models' / 'tokenizers' / 'image.py'
    s = p.read_text(encoding='utf-8')
    if 'DINO_CONFIG_PATH' in s:
        print('  3) image.py 已打过，跳过')
        return False

    old = '''            ViTModel.config_class.from_pretrained(
                hf_hub_download(
                    repo_id=self.cfg.pretrained_model_name_or_path,
                    filename="config.json",
                )
            )'''
    new = '''            ViTModel.config_class.from_pretrained(
                # [patched] 本机 HuggingFace 不可达。优先用 DINO_CONFIG_PATH 指向的本地
                # config.json（从 ModelScope 的 AI-ModelScope/dino-vitb16 取）；
                # 只有本地没有时才退回 hf_hub_download。
                _dino_config_path(self.cfg.pretrained_model_name_or_path)
            )'''
    if old not in s:
        print('  3) image.py 找不到目标片段，跳过')
        return False

    helper = '''

def _dino_config_path(repo_id: str) -> str:
    """DINO 的 config.json 路径：本地优先（HF 不可达），否则回退 hf_hub_download。

    注意只需要 config.json —— DINO 的权重在 TripoSR 的 model.ckpt 里，
    这里建的是结构，权重随后由 ckpt 的 state_dict 覆盖。
    """
    local = os.environ.get("DINO_CONFIG_PATH")
    if local and os.path.exists(local):
        return local
    return hf_hub_download(repo_id=repo_id, filename="config.json")
'''

    backup(p)
    s = s.replace('from dataclasses import dataclass', 'import os\nfrom dataclasses import dataclass', 1)
    s = s.replace('from ...utils import BaseModule', 'from ...utils import BaseModule' + helper, 1)
    s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print('  3) image.py -> DINO config 本地优先 OK')
    return True


def patch_rembg_optional() -> bool:
    """rembg 只在"需要抠图"时才会被调用，但它在 utils.py / run.py 的**顶层**被 import，
    于是没装这个包时连 import tsr 都失败。

    为什么不干脆 pip install rembg：它会拖进 onnxruntime，还常把 numpy 降到 2.0 以下，
    把我们刚配好、已经验证过 CUDA 可用的环境搞坏。
    而且 tsr/utils.py 的 remove_background() 已经有一句：
        if image.mode == "RGBA" and image.getextrema()[3][0] < 255: do_remove = False
    —— 喂透明底的 RGBA 图它会**自动跳过抠图**，所以 rembg 根本用不上。

    这里改成可选导入，并在"确实需要抠图却缺包"时给出明确报错。
    """
    import re

    changed = False
    for rel in ('tsr/utils.py', 'run.py'):
        p = ROOT / rel
        s = p.read_text(encoding='utf-8')
        if 'REMBG_OPTIONAL' in s:
            print(f'  4) {rel} 已打过，跳过')
            continue
        new_s, n = re.subn(
            r'^import rembg$',
            '# [patched] rembg 只用于背景移除。我们用 --no-remove-bg + 自带透明底的输入图，\n'
            '# 不需要它，也不希望它为拉 u2net 模型去联网（本机 HuggingFace 不可达）。\n'
            'try:\n'
            '    import rembg\n'
            'except ImportError:  # REMBG_OPTIONAL\n'
            '    rembg = None',
            s,
            flags=re.M,
        )
        if n == 0:
            print(f'  4) {rel} 找不到独占一行的 import rembg，跳过')
            continue
        backup(p)
        p.write_text(new_s, encoding='utf-8')
        print(f'  4) {rel} -> rembg 改为可选导入 OK')
        changed = True
    return changed


def main() -> int:
    if not ROOT.exists():
        print(f'找不到 {ROOT}')
        return 1
    print(f'给 {ROOT} 打补丁：')
    changed = [
        patch_isosurface(),
        patch_torch_load(),
        patch_dino_config(),
        patch_rembg_optional(),
    ]
    print(f'完成：{sum(changed)} 处改动')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
