#!/usr/bin/env python3
"""
对比 Hunyuan3D-2 单图版 与 2mv 多视图版 的**张量形状差异**。

为什么值得单独做：两个文件的张量**数量和名字完全一样**（1649 个），光看名字看不出区别。
真正的差别一定在少数几个" conditioner 投影"上 —— 多视图版要把 N 张图的特征拼起来，
投影层的输入维度就会变成 N 倍。把差异列出来，就知道：
  · 多视图是怎么把多张图喂进 DiT 的（拼接？独立 token？）
  · 我们的"三视图"能不能直接喂（要几张、什么顺序、要不要额外形状）
"""
import json
import os
import struct
import urllib.request

CACHE = r'D:\dsh-modeler\.tmp-mv-header.json'
URL = ('https://www.modelscope.cn/api/v1/models/AI-ModelScope/Hunyuan3D-2mv/repo'
       '?Revision=master&FilePath=hunyuan3d-dit-v2-mv-turbo/model.fp16.safetensors')
LOCAL = r'D:\dsh-data\dsh-triposr\hunyuan-full\dit-fp16.safetensors'


def header(buf):
    n = struct.unpack('<Q', buf[:8])[0]
    return json.loads(buf[8:8 + n].decode('utf-8'))


def mv_header():
    if os.path.exists(CACHE):
        with open(CACHE, 'r', encoding='utf-8') as f:
            return json.load(f)
    req = urllib.request.Request(URL, headers={'Range': f'bytes=0-{(1 << 20) - 1}'})
    with urllib.request.urlopen(req, timeout=90) as r:
        h = header(r.read())
    with open(CACHE, 'w', encoding='utf-8') as f:
        json.dump(h, f)
    return h


with open(LOCAL, 'rb') as f:
    sv = header(f.read(1 << 20))
mv = mv_header()

keys = set(sv) | set(mv)
only_sv = sorted(set(sv) - set(mv))
only_mv = sorted(set(mv) - set(sv))
diff = []
for k in sorted(keys & set(sv) & set(mv)):
    a, b = sv[k], mv[k]
    if a['shape'] != b['shape'] or a['dtype'] != b['dtype']:
        diff.append((k, a['shape'], b['shape'], a['dtype'], b['dtype']))

print(f'单图版张量 {len(sv)}   多视图版张量 {len(mv)}')
print(f'只在单图版有：{len(only_sv)}   只在多视图版有：{len(only_mv)}')
for k in only_sv[:10]:
    print(f'   - {k} {sv[k]["shape"]}')
for k in only_mv[:10]:
    print(f'   + {k} {mv[k]["shape"]}')
print(f'\n形状/精度不同的（{len(diff)} 个）：')
for k, a, b, da, db in diff:
    print(f'   {k}')
    print(f'      单图 {a} {da}')
    print(f'      mv   {b} {db}')

# 顺带把 conditioner 里所有"不是 encoder 内部"的层列出来（那些才是投影头）
print('\nconditioner 里非 encoder 内部的键（投影头/聚合层）：')
for k, v in sorted(mv.items()):
    if k.startswith('conditioner.') and '.model.encoder.' not in k and 'model.embeddings' not in k:
        tag = ''
        if k in sv and sv[k]['shape'] != v['shape']:
            tag = f'   ← 与单图版不同（单图 {sv[k]["shape"]}）'
        print(f'   {k:70s} {v["dtype"]:6s} {v["shape"]}{tag}')
