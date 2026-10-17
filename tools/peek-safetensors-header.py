#!/usr/bin/env python3
"""
只下 1 MB 就把 safetensors 的**张量表**读出来 —— 不用下 4.9 GB 才能判断结构。

safetensors 的格式：头 8 字节 = JSON 头长度（小端 u64），紧跟 JSON 头（张量名 → dtype/shape/offset）。
所以只要 Range 取前 1 MB，就能拿到完整张量表（大模型的头一般几十 KB）。
用它来对比"单图版"和"多视图版"的 conditioner 到底差在哪 ——
这正是判断"能不能把三视图喂给 mv 模型"的关键，靠猜没用。
"""
import json
import struct
import sys
import urllib.request


def header_from_url(url, nbytes=1 << 20):
    req = urllib.request.Request(url, headers={'Range': f'bytes=0-{nbytes - 1}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        buf = r.read()
    return header_from_buf(buf)


def header_from_file(path, nbytes=1 << 20):
    with open(path, 'rb') as f:
        return header_from_buf(f.read(nbytes))


def header_from_buf(buf):
    if len(buf) < 8:
        raise RuntimeError('数据太短')
    n = struct.unpack('<Q', buf[:8])[0]
    if n <= 0 or n > len(buf) - 8:
        raise RuntimeError(f'JSON 头长度异常：{n}（拿到 {len(buf)} 字节）')
    return json.loads(buf[8:8 + n].decode('utf-8'))


def summarize(hdr, label, patterns):
    print(f'\n=== {label} ===')
    print(f'张量总数 {len(hdr)}')
    for pat in patterns:
        hits = {k: v for k, v in hdr.items() if pat in k}
        print(f'  -- 含 "{pat}" 的（{len(hits)} 个）--')
        for k, v in sorted(hits.items())[:14]:
            print(f'     {k:60s} {v["dtype"]:8s} {v["shape"]}')


if __name__ == '__main__':
    URL = ('https://www.modelscope.cn/api/v1/models/AI-ModelScope/Hunyuan3D-2mv/repo'
           '?Revision=master&FilePath=hunyuan3d-dit-v2-mv-turbo/model.fp16.safetensors')
    print('拉取 mv 版头部（Range 1 MB）…')
    mv = header_from_url(URL)
    summarize(mv, 'Hunyuan3D-2mv (dit-v2-mv-turbo)', ['cond', 'conditioner', 'image_encoder', 'view'])

    print('\n读本地单图版头部…')
    sv = header_from_file(r'D:\dsh-data\dsh-triposr\hunyuan-full\dit-fp16.safetensors')
    summarize(sv, '本地已装：dit-v2-0-turbo（单图）', ['cond', 'conditioner', 'image_encoder', 'view'])
