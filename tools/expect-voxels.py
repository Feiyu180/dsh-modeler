#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立计算离散体素雕刻的**精确期望体素数**（纯解析，不跑 JS）。

为什么需要：验证脚本连续几轮把期望值算错（拿连续公式比离散几何、把球/锥当成棱柱）。
这里用最朴素的方式重新定义一遍，只依赖"剪影二值化 + 逐体素取交"这个定义本身，
不依赖 JS 实现：

  给定三张视图的**二值掩码**（真实 PNG 里读出来的），
  以及 carve 的映射规则（内容框 → 世界盒、统一尺度），
  逐体素 (i,j,k) 判定：
      前视图命中(i,j) and 侧视图命中(k,j) and 俯视图命中(i,k)
  统计命中数。

这就是"理论上应该雕出多少个体素"，与 JS 输出对比即可判定 JS 对不对。
"""
import json
import os
import sys

from PIL import Image

S = r"D:\dsh-modeler\samples"

with open(os.path.join(S, "expected.json"), encoding="utf-8-sig") as f:
    E = json.load(f)


def load_mask(name):
    im = Image.open(os.path.join(S, name)).convert("L")
    w, h = im.size
    px = im.load()
    m = bytearray(w * h)
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y] < 128:
                m[y * w + x] = 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return {"m": m, "w": w, "h": h, "bbox": (x0, y0, x1, y1)}


def bbox_of(m, w, h):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if m[y * w + x]:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1


def expected_voxels(front, side, top, resolution=120, padding=0.0):
    """复刻 carve 的尺度规则，逐体素判定，返回 (体素数, 网格维度)"""
    names = ['front', 'side', 'top']
    views = {'front': front, 'side': side, 'top': top}
    bw = {}
    bh = {}
    for k in names:
        x0, y0, x1, y1 = views[k]['bbox']
        bw[k] = x1 - x0 + 1
        bh[k] = y1 - y0 + 1

    spanX = max(bw['front'], bw['top'])
    spanY = max(bh['front'], bh['side'])
    spanZ = max(bw['side'], bh['top'])
    longest = max(spanX, spanY, spanZ)
    scale = resolution * (1 - 2 * padding) / longest

    nx = max(2, round(spanX * scale))
    ny = max(2, round(spanY * scale))
    nz = max(2, round(spanZ * scale))

    def rng(k, axis):
        x0, y0, x1, y1 = views[k]['bbox']
        v = views[k]
        if axis == 'u':
            return (x0 + 0.5) / v['w'], (x1 + 0.5) / v['w']
        if k == 'top':
            return (y0 + 0.5) / v['h'], (y1 + 0.5) / v['h']
        return (y1 + 0.5) / v['h'], (y0 + 0.5) / v['h']

    def hit(k, u, v):
        if not (0 <= u < 1 and 0 <= v < 1):
            return 0
        vv = views[k]
        return vv['m'][int(v * vv['h']) * vv['w'] + int(u * vv['w'])]

    fu, fv = rng('front', 'u'), rng('front', 'v')
    su, sv = rng('side', 'u'), rng('side', 'v')
    tu, tv = rng('top', 'u'), rng('top', 'v')

    cnt = 0
    for k in range(nz):
        kz_s = su[0] + (k + 0.5) / nz * (su[1] - su[0])
        kz_t = tv[0] + (k + 0.5) / nz * (tv[1] - tv[0])
        for j in range(ny):
            jy_f = fv[0] + (j + 0.5) / ny * (fv[1] - fv[0])
            jy_s = sv[0] + (j + 0.5) / ny * (sv[1] - sv[0])
            for i in range(nx):
                ix_f = fu[0] + (i + 0.5) / nx * (fu[1] - fu[0])
                ix_t = tu[0] + (i + 0.5) / nx * (tu[1] - tu[0])
                if hit('front', ix_f, jy_f) and hit('side', kz_s, jy_s) and hit('top', ix_t, kz_t):
                    cnt += 1
    return cnt, (nx, ny, nz)


SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'lshape', 'torus-ish', 'asym', 'tiny']

js = {}
dump = os.path.join(r"D:\dsh-modeler\tools", "_py-carve-dump.json")
if os.path.exists(dump):
    with open(dump, encoding="utf-8") as f:
        js = json.load(f)

print("%-12s %-14s %12s %12s %8s" % ("形状", "网格(解析)", "解析体素数", "JS 体素数", "一致"))
print("-" * 62)
mismatch = 0
results = {}
for shape in SHAPES:
    try:
        f = load_mask("%s-front.png" % shape)
        s = load_mask("%s-side.png" % shape)
        t = load_mask("%s-top.png" % shape)
    except FileNotFoundError:
        continue
    n, dims = expected_voxels(f, s, t)
    got = js.get(shape, {}).get("filled")
    same = "—" if got is None else ("是" if got == n else "否")
    if got is not None and got != n:
        mismatch += 1
    results[shape] = {
        "expectedVoxels": n,
        "grid": list(dims),
        "jsFilled": got,
        "match": None if got is None else (got == n),
    }
    print("%-12s %-14s %12d %12s %8s" % (
        shape, "%dx%dx%d" % dims, n, got if got is not None else "?", same))

print()
out_path = os.path.join(r"D:\dsh-modeler\tools", "expected-voxels.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print("已写出 %s（供 tools/verify-pipeline.mjs 作为期望基准）" % out_path)

if mismatch:
    print("有 %d 个形状与 JS 不一致 —— 需要查（可能是 carve 的边界处理或尺度取整差 1）" % mismatch)
    sys.exit(1)
print("全部一致：JS 的 carve 与独立解析计算逐体素相同。")
