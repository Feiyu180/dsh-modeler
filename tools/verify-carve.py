#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立复现体素雕刻（Python 版），与 JS 实现逐层对数。

为什么值得单独写一遍：验证脚本已经连续两次把"期望值"算错（一次用连续公式比离散几何，
一次把三视图取交写成了相乘）。与其继续在脑子里推公式，不如用另一个实现把手算过程
固化下来，然后和 JS 输出**对数**——两个独立实现如果一致，才说明雕刻本身没问题，
剩下的偏差才是真的离散化误差。

用法：
    python tools/verify-carve.py            # 打印对照表
    python tools/verify-carve.py --json     # 输出 JSON（给别的脚本消费）
"""
import json
import os
import sys

from PIL import Image

ROOT = r"D:\dsh-modeler"
SAMPLES = os.path.join(ROOT, "samples")


def load_mask(name):
    """读 PNG → 前景布尔表（<128 视为前景），返回 (mask, w, h)"""
    im = Image.open(os.path.join(SAMPLES, name)).convert("L")
    w, h = im.size
    px = im.load()
    mask = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            if px[x, y] < 128:
                mask[row + x] = 1
    return mask, w, h


def bbox(mask, w, h):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1


def carve(views, resolution=120, padding=0.0):
    """
    views: {'front': (mask,w,h), 'side': ..., 'top': ...}
    与 src/core/geometry.js 的 carve() 用同一套约定：
      - 每张视图取内容框
      - 统一尺度：contentPixels → 体素（scale = res*(1-2pad)/maxSpan）
      - 前视图 u→X v→Y(反)，侧视图 u→Z v→Y(反)，俯视图 u→X v→Z
      - 逐体素对三张掩码做最近邻采样后取交
    """
    boxes = {k: bbox(*v) for k, v in views.items()}
    spans = {}
    w = {k: (boxes[k][2] - boxes[k][0] + 1) for k in boxes}
    h = {k: (boxes[k][3] - boxes[k][1] + 1) for k in boxes}

    spanX = max([w.get('front', 0), w.get('top', 0)])
    spanY = max([h.get('front', 0), h.get('side', 0)])
    spanZ = max([w.get('side', 0), h.get('top', 0)])
    longest = max(spanX, spanY, spanZ)
    scale = resolution * (1 - 2 * padding) / longest

    nx = max(2, round(spanX * scale))
    ny = max(2, round(spanY * scale))
    nz = max(2, round(spanZ * scale))

    def axis_lo_hi(key, iaxis):
        """返回该视图在某个世界轴上的归一化采样区间 [lo, hi)"""
        m, mw, mh = views[key]
        x0, y0, x1, y1 = boxes[key]
        if iaxis == 'u':
            return (x0 + 0.5) / mw, (x1 + 0.5) / mw
        else:  # v，自顶向下 → 世界轴自下而上，交换
            return (y1 + 0.5) / mh, (y0 + 0.5) / mh

    def sample(mask, ww, hh, u, v):
        if not (0 <= u < 1 and 0 <= v < 1):
            return 0
        x = int(u * ww)
        y = int(v * hh)
        return mask[y * ww + x]

    def sampleV(mask, ww, hh, u, v):
        """俯视图的 v 是自顶向下→Z 正向，不需交换（与 JS 的 mapVTop 一致）"""
        if not (0 <= u < 1 and 0 <= v < 1):
            return 0
        return mask[int(v * hh) * ww + int(u * ww)]

    grids = {}
    for key in ('front', 'side', 'top'):
        if key in views:
            grids[key] = axis_lo_hi(key, 'u')
    gridsV = {}
    for key in ('front', 'side'):
        if key in views:
            gridsV[key] = axis_lo_hi(key, 'v')
    if 'top' in views:
        m, mw, mh = views['top']
        x0, y0, x1, y1 = boxes['top']
        gridsV['top'] = ((y0 + 0.5) / mh, (y1 + 0.5) / mh)

    occupied = bytearray(nx * ny * nz)
    filled = 0
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                ok = True
                if 'front' in views:
                    m, mw, mh = views['front']
                    u = grids['front'][0] + (i + 0.5) / nx * (grids['front'][1] - grids['front'][0])
                    v = gridsV['front'][0] + (j + 0.5) / ny * (gridsV['front'][1] - gridsV['front'][0])
                    if not sample(m, mw, mh, u, v):
                        ok = False
                if ok and 'side' in views:
                    m, mw, mh = views['side']
                    u = grids['side'][0] + (k + 0.5) / nz * (grids['side'][1] - grids['side'][0])
                    v = gridsV['side'][0] + (j + 0.5) / ny * (gridsV['side'][1] - gridsV['side'][0])
                    if not sample(m, mw, mh, u, v):
                        ok = False
                if ok and 'top' in views:
                    m, mw, mh = views['top']
                    u = grids['top'][0] + (i + 0.5) / nx * (grids['top'][1] - grids['top'][0])
                    v = gridsV['top'][0] + (k + 0.5) / nz * (gridsV['top'][1] - gridsV['top'][0])
                    if not sampleV(m, mw, mh, u, v):
                        ok = False
                if ok:
                    occupied[(k * ny + j) * nx + i] = 1
                    filled += 1
    return {'occupied': occupied, 'nx': nx, 'ny': ny, 'nz': nz, 'filled': filled, 'scale': scale}


SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'lshape', 'torus-ish', 'asym']
VIEWS = ['front', 'side', 'top']


def main():
    out = {}
    print("%-12s %-14s %10s %10s %8s" % ("形状", "体素网格", "Python 体素", "JS 体素", "一致?"))
    print("-" * 62)

    js_path = os.path.join(ROOT, "tools", "_py-carve-dump.json")
    js = {}
    if os.path.exists(js_path):
        with open(js_path, "r", encoding="utf-8") as f:
            js = json.load(f)

    for shape in SHAPES:
        views = {}
        for v in VIEWS:
            fn = "%s-%s.png" % (shape, v)
            if os.path.exists(os.path.join(SAMPLES, fn)):
                views[v] = load_mask(fn)
        if len(views) < 3:
            print("%-12s 缺视图，跳过" % shape)
            continue
        r = carve(views)
        got = js.get(shape, {}).get("filled")
        same = "—" if got is None else ("是" if got == r["filled"] else "否")
        out[shape] = {'nx': r['nx'], 'ny': r['ny'], 'nz': r['nz'], 'filled': r['filled'], 'scale': r['scale']}
        print("%-12s %-14s %10d %10s %8s" % (
            shape, "%dx%dx%d" % (r['nx'], r['ny'], r['nz']), r['filled'],
            got if got is not None else "?", same))

    if '--json' in sys.argv:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
