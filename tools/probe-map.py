#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
逐个打印中心体素在三张视图上的采样坐标与命中结果。

为什么值得单独跑：torus-ish 的孔在图里（已确认 35..84 是空的），但雕刻后中心却是实心。
这类"图对、结果不对"的问题只可能出在**映射**上，所以把一次采样的每个中间量都打出来，
而不是继续推理。
"""
import os

from PIL import Image

S = r"D:\dsh-modeler\samples"


def load(name):
    im = Image.open(os.path.join(S, name)).convert("L")
    w, h = im.size
    px = im.load()
    mask = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            if px[x, y] < 128:
                mask[y * w + x] = 1
    # bbox
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if mask[y * w + x]:
                x0 = min(x0, x); x1 = max(x1, x)
                y0 = min(y0, y); y1 = max(y1, y)
    return {'mask': mask, 'w': w, 'h': h, 'bbox': (x0, y0, x1, y1)}


views = {k: load("torus-ish-%s.png" % k) for k in ("front", "side", "top")}

# 统一尺度（与 carve 一致）
res, pad = 120, 0.0
bw = {k: views[k]['bbox'][2] - views[k]['bbox'][0] + 1 for k in views}
bh = {k: views[k]['bbox'][3] - views[k]['bbox'][1] + 1 for k in views}
spanX = max(bw['front'], bw['top'])
spanY = max(bh['front'], bh['side'])
spanZ = max(bw['side'], bh['top'])
longest = max(spanX, spanY, spanZ)
scale = res * (1 - 2 * pad) / longest
nx = max(2, round(spanX * scale))
ny = max(2, round(spanY * scale))
nz = max(2, round(spanZ * scale))
print("bbox:", {k: views[k]['bbox'] for k in views})
print("span:", spanX, spanY, spanZ, " scale:", scale)
print("grid:", nx, ny, nz)
print()

# 中心体素
i, j, k = nx // 2, ny // 2, nz // 2
print("取中心体素 (i,j,k) = (%d,%d,%d)" % (i, j, k))
print()

def rng(key, axis):
    x0, y0, x1, y1 = views[key]['bbox']
    v = views[key]
    if axis == 'u':
        return (x0 + 0.5) / v['w'], (x1 + 0.5) / v['w']
    return (y1 + 0.5) / v['h'], (y0 + 0.5) / v['h']


def rng_top_v():
    x0, y0, x1, y1 = views['top']['bbox']
    v = views['top']
    return (y0 + 0.5) / v['h'], (y1 + 0.5) / v['h']


def probe(key, u, v, axis_v='normal'):
    vv = views[key]
    ux = int(u * vv['w'])
    vy = int(v * vv['h'])
    hit = vv['mask'][vy * vv['w'] + ux]
    print("  %-6s u=%.5f v=%.5f -> 像素(%3d,%3d) 命中=%d" % (key, u, v, ux, vy, hit))
    return hit


# front: u←i, v←j
f = rng('front', 'u')
fv = rng('front', 'v')
uf = f[0] + (i + 0.5) / nx * (f[1] - f[0])
vf = fv[0] + (j + 0.5) / ny * (fv[1] - fv[0])
print("front 的 u 区间 [%.5f, %.5f]，v 区间 [%.5f, %.5f]" % (f[0], f[1], fv[0], fv[1]))
probe('front', uf, vf)

# side: u←k, v←j
s = rng('side', 'u')
sv = rng('side', 'v')
us = s[0] + (k + 0.5) / nz * (s[1] - s[0])
vs = sv[0] + (j + 0.5) / ny * (sv[1] - sv[0])
print("side  的 u 区间 [%.5f, %.5f]，v 区间 [%.5f, %.5f]" % (s[0], s[1], sv[0], sv[1]))
probe('side', us, vs)

# top: u←i, v←k
t = rng('top', 'u')
tv = rng_top_v()
ut = t[0] + (i + 0.5) / nx * (t[1] - t[0])
vt = tv[0] + (k + 0.5) / nz * (tv[1] - tv[0])
print("top   的 u 区间 [%.5f, %.5f]，v 区间 [%.5f, %.5f]" % (t[0], t[1], tv[0], tv[1]))
probe('top', ut, vt)

print()
print("三者都为 1 才应该占据。中心体素在孔的位置，应当至少有一张视图命中 0。")
