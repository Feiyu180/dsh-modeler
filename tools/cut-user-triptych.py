"""
把用户给的角色三视图（一张 JPEG，前/侧/背并排）切成三份 PNG，供体素雕刻使用。

⚠ 要说清楚一件事：这是**角色设定图**，不是工程用的正交三视图。
   · 绘画风格（有渐变、描线、阴影、水印），不是纯剪影；
   · 三格分别是 前 / 侧 / **背**（不是俯视）；
   · 角色姿态带透视，不是严格正交投影。
   所以视觉壳雕刻出来的东西不会"像这个角色"——它只能从轮廓反推凸包近似。
   这次跑它主要是当**真实素材的鲁棒性冒烟测试**（彩色、复杂轮廓、水印、非正交）。

用法：python cut-user-triptych.py <输入图> <输出目录>
"""

import os
import sys

from PIL import Image


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\YOURNAME\.dsh\attachments\v1\objects\a4\a466d64951b21195034c0bb5818ff4a32e59f468392d5ea94a49cb8f46022caf'
    outdir = sys.argv[2] if len(sys.argv) > 2 else r'D:\dsh-modeler\samples\user'
    os.makedirs(outdir, exist_ok=True)

    im = Image.open(src).convert('RGB')
    W, H = im.size
    print(f'输入 {os.path.basename(src)}  {W}x{H}')

    # 三格大致等宽；先按 1/3 切，再各自裁到"非白内容"的包围盒
    names = ['front', 'side', 'back']
    for i, name in enumerate(names):
        x0 = round(W * i / 3)
        x1 = round(W * (i + 1) / 3)
        tile = im.crop((x0, 0, x1, H))

        # 内容框：把接近白色的像素当背景
        px = tile.load()
        tw, th = tile.size
        minx, miny, maxx, maxy = tw, th, -1, -1
        for y in range(0, th, 2):
            for x in range(0, tw, 2):
                r, g, b = px[x, y]
                if not (r > 238 and g > 238 and b > 238):
                    if x < minx: minx = x
                    if y < miny: miny = y
                    if x > maxx: maxx = x
                    if y > maxy: maxy = y
        if maxx < 0:
            print(f'  {name}: 整格都是背景，跳过')
            continue
        pad = 6
        box = (max(0, minx - pad), max(0, miny - pad), min(tw, maxx + 1 + pad), min(th, maxy + 1 + pad))
        cropped = tile.crop(box)
        dst = os.path.join(outdir, f'{name}.png')
        cropped.save(dst)
        print(f'  {name}: 裁到 {box} → {cropped.size[0]}x{cropped.size[1]}  {dst}')

    # 俯视图：这张设定图里没有。用前视图的宽度 × 侧视图的"厚度"合成一个**实心**矩形。
    #
    # ⚠ 两个坑：
    #   1. 必须画成**深色**（前景色）。第一版写成 (255,255,255) 纯白 —— 那对
    #      silhouette 来说就是"整张图全是背景"，直接抛「剪影为空」。
    #   2. 这块矩形在俯视方向**不提供任何约束**（整个包围盒都算实体），
    #      等价于"不用俯视图"。它只是为了让三视图齐全能跑通。
    #      要真实俯视请自己补一张。
    front_path = os.path.join(outdir, 'front.png')
    side_path = os.path.join(outdir, 'side.png')
    if os.path.exists(front_path) and os.path.exists(side_path):
        f = Image.open(front_path)
        s = Image.open(side_path)
        fw, fh = f.size
        sw, sh = s.size
        spx = s.convert('L').load()
        widths = []
        for y in range(int(sh * 0.30), int(sh * 0.85)):
            row = [x for x in range(sw) if spx[x, y] < 238]
            if row:
                widths.append(row[-1] - row[0] + 1)
        widths.sort()
        depth = widths[len(widths) // 2] if widths else int(sw * 0.35)
        depth = max(24, min(fw, depth))
        top = Image.new('RGB', (fw, depth), (0, 0, 0))   # 深色 = 前景
        dst = os.path.join(outdir, 'top.png')
        top.save(dst)
        print(f'  top: 合成 {fw}x{depth}（前视宽度 x 侧视中位厚度 {depth}）-> {dst}')
        print('       [warn] 这张是合成的实心矩形，在俯视方向不提供约束')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
