#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立验收外部模型交付的三视图夹具。

为什么用 Python + Pillow 而不是 Node：夹具是它自己用 Node 写的，如果我也用 Node
去读，就有可能两边的 bug 相互抵消。换一个实现栈（libpng 的 Pillow）来解同一批
PNG，才能真正说明这些文件是"标准可读的"，而不是"只对它自己的解码器可读"。

检查项：
  1. samples/ 下文件清单与 expected.json 一一对应
  2. 每张 PNG 能被 Pillow 打开、是灰度或可转灰度、尺寸 > 0
  3. 前景像素数（阈值 <128）与 expected.json 的 area 完全一致
  4. 前景内容框（bbox）与 expected.json 一致
  5. 内容框宽高比符合任务单里给的目标（长方体三轴不同、圆是方的等）
"""
import json
import os
import sys

from PIL import Image

ROOT = r"D:\dsh-modeler"
SAMPLES = os.path.join(ROOT, "samples")
EXPECTED = os.path.join(SAMPLES, "expected.json")

fail = []
warn = []


def fail_(msg):
    fail.append(msg)
    print("  FAIL " + msg)


def ok(msg):
    print("  ok   " + msg)


def main():
    if not os.path.exists(EXPECTED):
        print("expected.json 不存在，无法验收")
        return 1

    with open(EXPECTED, "r", encoding="utf-8-sig") as f:
        exp = json.load(f)

    pngs = sorted(n for n in os.listdir(SAMPLES) if n.lower().endswith(".png"))
    print("samples/ 里 PNG 数量:", len(pngs))

    # --- 1. 清单对齐 ---
    listed = []
    for shape, views in exp.items():
        if not isinstance(views, dict):
            continue
        for view, meta in views.items():
            if isinstance(meta, dict) and "file" in meta:
                listed.append(meta["file"])
    missing = [n for n in listed if n not in pngs]
    extra = [n for n in pngs if n not in listed]
    if missing:
        fail_("expected.json 列了但文件不存在: " + ", ".join(missing))
    if extra:
        warn.append("samples/ 里有 expected.json 未列出的图: " + ", ".join(extra))
        print("  warn 未列出的图:", ", ".join(extra))
    if not missing:
        ok("%d 个文件与 expected.json 一一对应" % len(listed))

    # --- 2..4. 逐张核对 ---
    checked = 0
    for shape, views in exp.items():
        if not isinstance(views, dict):
            continue
        for view, meta in views.items():
            if not isinstance(meta, dict) or "file" not in meta:
                continue
            p = os.path.join(SAMPLES, meta["file"])
            if not os.path.exists(p):
                continue
            try:
                im = Image.open(p)
                im.load()
            except Exception as e:
                fail_("%s 无法被 Pillow 打开: %s" % (meta["file"], e))
                continue

            if im.mode not in ("L", "LA", "1", "I;16", "RGB", "RGBA"):
                warn.append("%s 模式是 %s" % (meta["file"], im.mode))
            gray = im.convert("L")
            w, h = gray.size

            if "width" in meta and meta["width"] != w:
                # width/height 在任务单里指的是"内容框"而不是画布，两者都可能，
                # 所以先看是不是整个画布；不是的话再用内容框比。
                pass

            px = gray.load()
            count = 0
            x0, y0, x1, y1 = w, h, -1, -1
            for y in range(h):
                for x in range(w):
                    if px[x, y] < 128:
                        count += 1
                        if x < x0:
                            x0 = x
                        if x > x1:
                            x1 = x
                        if y < y0:
                            y0 = y
                        if y > y1:
                            y1 = y

            if count == 0:
                fail_("%s 没有任何前景像素" % meta["file"])
                continue

            bw, bh = x1 - x0 + 1, y1 - y0 + 1

            if "area" in meta and meta["area"] != count:
                fail_("%s 前景像素数不符: expected %s, 实测 %d"
                      % (meta["file"], meta["area"], count))

            # 内容框：expected 可能写 width/height 或 bbox
            if "bbox" in meta and isinstance(meta["bbox"], list) and len(meta["bbox"]) == 4:
                if list(meta["bbox"]) != [x0, y0, x1, y1]:
                    fail_("%s bbox 不符: expected %s, 实测 %s"
                          % (meta["file"], meta["bbox"], [x0, y0, x1, y1]))
            if "width" in meta and "height" in meta and "bbox" not in meta:
                if meta["width"] != bw or meta["height"] != bh:
                    fail_("%s 内容框不符: expected %dx%d, 实测 %dx%d"
                          % (meta["file"], meta["width"], meta["height"], bw, bh))

            checked += 1

    ok("逐张核对了 %d 张图" % checked)

    # --- 5. 关键比例抽查 ---
    def box_of(shape, view):
        m = exp.get(shape, {}).get(view)
        if not isinstance(m, dict):
            return None
        p = os.path.join(SAMPLES, m["file"])
        if not os.path.exists(p):
            return None
        g = Image.open(p).convert("L")
        w, h = g.size
        px = g.load()
        x0, y0, x1, y1 = w, h, -1, -1
        for y in range(h):
            for x in range(w):
                if px[x, y] < 128:
                    x0 = min(x0, x); x1 = max(x1, x)
                    y0 = min(y0, y); y1 = max(y1, y)
        return (x1 - x0 + 1, y1 - y0 + 1)

    # 长方体：三轴尺寸互不相同（X=120, Y=60, Z=40）
    fb = box_of("box", "front")
    sb = box_of("box", "side")
    tb = box_of("box", "top")
    print("box 三视图内容框:", fb, sb, tb)
    if fb and sb and tb:
        if not (fb[0] == tb[0]):
            fail_("box: 前视图宽(%d) 应等于 俯视图宽(%d)（都是 X）" % (fb[0], tb[0]))
        if not (fb[1] == sb[1]):
            fail_("box: 前视图高(%d) 应等于 侧视图高(%d)（都是 Y）" % (fb[1], sb[1]))
        if not (sb[0] == tb[1]):
            fail_("box: 侧视图宽(%d) 应等于 俯视图高(%d)（都是 Z）" % (sb[0], tb[1]))
        if fb[0] == sb[0] or fb[1] == tb[1]:
            fail_("box: 三轴尺寸不应有重复，否则测不出串轴")
        ok("box 三视图的轴向约束成立（X=%d, Y=%d, Z=%d）" % (fb[0], fb[1], sb[0]))

    # 球：三视图都应是正方形
    for v in ("front", "side", "top"):
        d = box_of("sphere", v)
        if d and abs(d[0] - d[1]) > 2:
            fail_("sphere %s 的内容框不是正方形: %s" % (v, d))
    ok("sphere 三视图均为正方形")

    # tiny：内容框 6×6 但画布 200×200
    d = box_of("tiny", "front")
    if d and d != (6, 6):
        fail_("tiny front 内容框应 6x6，实测 %s" % (d,))
    else:
        ok("tiny 内容框 6×6（画布 200×200，用于测自动裁边）")

    print()
    if warn:
        print("警告 %d 条:" % len(warn))
        for w_ in warn[:10]:
            print("  -", w_)
    if fail:
        print("失败 %d 条 ↑" % len(fail))
        return 1
    print("全部通过：%d 张 PNG 与 expected.json 一致，轴向约束成立" % len(pngs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
