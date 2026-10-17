"""
把 TripoSR 输出的 GLB 转成渲染页要的原始数组 JSON。

为什么不让 Node 直接读 GLB：本项目 vendored 的 three 是精简版，没有 GLTFLoader。
用 trimesh（Python 侧已经装好）拆成 positions/indices/colors 最短路径，也不引入新依赖。

用法：python glb-to-json.py <glb> <out.json>
"""

import base64
import json
import sys

import numpy as np
import trimesh


def main() -> int:
    glb = sys.argv[1]
    out = sys.argv[2]

    m = trimesh.load(glb)
    # ⚠ 必须走 dump(concatenate=True)。
    # GLB 的 scene graph 里通常有个带旋转的根节点（glTF 是 Y-up，而 TripoSR 写出的
    # 节点会带自己的朝向变换）。直接取 m.geometry.values()[0].vertices 拿到的是
    # **未应用变换的局部坐标**，渲染出来就是横躺的 —— 我因此一度以为"模型本身是横的"，
    # 其实只是我没把场景变换算进去。
    if hasattr(m, 'geometry') and m.geometry:
        # trimesh 5.x 把 dump(concatenate=True) 标了弃用（2025-04 移除），新名字是 to_geometry()。
        # 两个都试，免得哪天升级后直接崩。
        g = m.to_geometry() if hasattr(m, 'to_geometry') else m.dump(concatenate=True)
    else:
        g = m

    pos = np.ascontiguousarray(g.vertices, dtype=np.float32)
    idx = np.ascontiguousarray(g.faces, dtype=np.uint32)

    colors = None
    vc = getattr(getattr(g, 'visual', None), 'vertex_colors', None)
    if vc is not None:
        arr = np.asarray(vc)
        if arr.ndim == 2 and arr.shape[0] == len(pos):
            colors = np.ascontiguousarray(arr[:, :3], dtype=np.uint8)

    data = {
        'positions': base64.b64encode(pos.tobytes()).decode(),
        'indices': base64.b64encode(idx.tobytes()).decode(),
        'colors': base64.b64encode(colors.tobytes()).decode() if colors is not None else None,
        'vertexCount': int(len(pos)),
        'triangleCount': int(len(idx)),
        'watertight': bool(g.is_watertight),
        'extents': [float(x) for x in g.extents],
    }
    with open(out, 'w') as f:
        json.dump(data, f)

    print(f'  {out}')
    print(f'    {data["vertexCount"]} 顶点 / {data["triangleCount"]} 三角形'
          f' / 颜色 {"有" if colors is not None else "无"} / 水密 {data["watertight"]}')
    print(f'    包围盒 {[round(x, 3) for x in data["extents"]]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
