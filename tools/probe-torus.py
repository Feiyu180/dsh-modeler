#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""查 torus-ish 的孔到底在不在图里，以及中心列的掩码分布。"""
import os

from PIL import Image

S = r"D:\dsh-modeler\samples"


def mask_of(name):
    im = Image.open(os.path.join(S, name)).convert("L")
    w, h = im.size
    px = im.load()
    return [[1 if px[x, y] < 128 else 0 for x in range(w)] for y in range(h)], w, h


for view in ("front", "top", "side"):
    m, w, h = mask_of("torus-ish-%s.png" % view)
    print("=== torus-ish-%s  %dx%d ===" % (view, w, h))
    # 中心行 / 中心列的游程，用来直接看出孔的位置
    cy = h // 2
    row = m[cy]
    runs = []
    cur = row[0]
    start = 0
    for x in range(1, w):
        if row[x] != cur:
            runs.append((cur, start, x - 1))
            cur = row[x]
            start = x
    runs.append((cur, start, w - 1))
    print("  中心行 y=%d 游程 (值,起,止): %s" % (cy, runs))

    cx = w // 2
    col = [m[y][cx] for y in range(h)]
    runs = []
    cur = col[0]
    start = 0
    for y in range(1, h):
        if col[y] != cur:
            runs.append((cur, start, y - 1))
            cur = col[y]
            start = y
    runs.append((cur, start, h - 1))
    print("  中心列 x=%d 游程 (值,起,止): %s" % (cx, runs))

    # 中心点
    print("  中心点 (60,60) =", m[60][60] if h > 60 and w > 60 else "(越界)")
    print()
