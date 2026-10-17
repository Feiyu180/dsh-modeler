#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""列出所有夹具的：画布尺寸、内容框、前景像素数。用来核对任务单里的参数有没有被落实。"""
import json
import os

from PIL import Image

S = r"D:\dsh-modeler\samples"
with open(os.path.join(S, "expected.json"), encoding="utf-8-sig") as f:
    E = json.load(f)

print("%-12s %-7s %-11s %-11s %8s  %s" % ("shape", "view", "canvas", "content", "area", "expected"))
print("-" * 70)
for shape, views in E.items():
    if not isinstance(views, dict):
        continue
    for view, meta in views.items():
        if not isinstance(meta, dict) or "file" not in meta:
            continue
        p = os.path.join(S, meta["file"])
        if not os.path.exists(p):
            continue
        im = Image.open(p)
        w, h = im.size
        g = im.convert("L")
        px = g.load()
        x0, y0, x1, y1 = w, h, -1, -1
        a = 0
        for y in range(h):
            for x in range(w):
                if px[x, y] < 128:
                    a += 1
                    x0 = min(x0, x)
                    x1 = max(x1, x)
                    y0 = min(y0, y)
                    y1 = max(y1, y)
        cw = (x1 - x0 + 1) if a else 0
        ch = (y1 - y0 + 1) if a else 0
        exp = meta.get("width"), meta.get("height")
        print("%-12s %-7s %-11s %-11s %8d  %s" % (
            shape, view, "%dx%d" % (w, h), "%dx%d" % (cw, ch), a, exp))
