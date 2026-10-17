#!/usr/bin/env python3
"""
多线程分段下载器 —— 专治 ModelScope 这类"单连接限速"的源。

实测同一文件（8.0 GB）：
    1 连接  0.55 MB/s   需 236 分
    4 连接  1.63 MB/s   需  84 分
    12 连接 3.99 MB/s   需  34 分
    32 连接 7.15 MB/s   需  19 分   ← 默认用这个量级
（hf-mirror 0.08 MB/s、aifasthub 不通，都更差，所以还是打 ModelScope 的 CDN 直链。）

⚠ 续传的实现方式（这里踩过一个坑，值得说明）：
  第一版是"预分配整个文件 + 各段 seek 写入"，并用**文件大小**判断已下载量。
  结果：预分配那步 `truncate(total)` 会把文件撑到全尺寸，崩溃后再启动就以为"已经下完"，
  而实际上里面绝大部分是零填充 —— 我因此拿到了一个 8.6 GB 的假文件。
  现在改成**每段写自己的 .segN 文件**：段文件的大小天然就是那一段的真实进度，
  骗不了人；全部完成后按顺序合并成最终文件。

用法：
  python fastdl.py <url> <输出路径> [线程数]
"""

import os
import shutil
import sys
import threading
import time
import urllib.request

BLOCK = 4 * 1024 * 1024
RETRIES = 8


def remote_size(url, timeout=30):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        n = r.headers.get('Content-Length')
        if n is None:
            raise RuntimeError('服务端没给 Content-Length，无法分段')
        return int(n)


def seg_path(out, i):
    return f'{out}.seg{i}'


class Segment(threading.Thread):
    def __init__(self, url, out, begin, end, idx, stats, lock):
        super().__init__(daemon=True)
        self.url, self.out = url, out
        # ⚠ 别叫 self.start —— Thread.start 是方法名，覆盖它会让 t.start() 抛
        # "TypeError: 'int' object is not callable"（踩过）
        self.begin, self.end, self.idx = begin, end, idx
        self.stats, self.lock = stats, lock
        self.error = None

    def run(self):
        path = seg_path(self.out, self.idx)
        have = os.path.getsize(path) if os.path.exists(path) else 0
        pos = self.begin + have
        if pos > self.end:
            with self.lock:
                self.stats['done'] += (self.end - self.begin + 1)
            return

        attempt = 0
        mode = 'ab' if have else 'wb'
        while pos <= self.end:
            try:
                req = urllib.request.Request(
                    self.url, headers={'Range': f'bytes={pos}-{self.end}'}
                )
                with urllib.request.urlopen(req, timeout=90) as r, open(path, mode) as f:
                    while pos <= self.end:
                        chunk = r.read(min(BLOCK, self.end - pos + 1))
                        if not chunk:
                            break
                        f.write(chunk)
                        pos += len(chunk)
                        with self.lock:
                            self.stats['done'] += len(chunk)
                mode = 'ab'
                attempt = 0
            except Exception as e:  # noqa: BLE001
                attempt += 1
                if attempt > RETRIES:
                    self.error = f'段{self.idx} 放弃：{type(e).__name__}: {e}'
                    return
                time.sleep(min(2 ** attempt, 20))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    url, out = sys.argv[1], sys.argv[2]
    nthreads = int(sys.argv[3]) if len(sys.argv) > 3 else 32

    total = remote_size(url)
    print(f'远端 {total:,} 字节 ({total / 1024 / 1024:.1f} MB)')

    if os.path.exists(out) and os.path.getsize(out) == total:
        print('最终文件已存在且大小正确，跳过')
        return 0

    # 段数：每段至少 24 MB，避免段太碎
    n = max(1, min(nthreads, max(1, total // (24 * 1024 * 1024))))
    per = total // n
    segs = []
    for i in range(n):
        s = i * per
        e = (i + 1) * per - 1 if i < n - 1 else total - 1
        segs.append((s, e))

    # 已完成的段先统计出来
    stats = {'done': 0}
    done_bytes = 0
    for i, (s, e) in enumerate(segs):
        p = seg_path(out, i)
        if os.path.exists(p):
            done_bytes += min(os.path.getsize(p), e - s + 1)
    stats['done'] = done_bytes
    if done_bytes:
        print(f'续传：已有 {done_bytes / 1024 / 1024:.1f} MB（{done_bytes / total * 100:.1f}%）')

    print(f'{n} 线程，每段约 {per / 1024 / 1024:.1f} MB')
    lock = threading.Lock()
    threads = [Segment(url, out, s, e, i, stats, lock) for i, (s, e) in enumerate(segs)]

    t0 = time.time()
    for t in threads:
        t.start()

    last, last_t = done_bytes, time.time()
    while any(t.is_alive() for t in threads):
        time.sleep(1)
        with lock:
            d = stats['done']
        now = time.time()
        inst = (d - last) / max(now - last_t, 0.001)
        last, last_t = d, now
        elapsed = now - t0
        avg = (d - done_bytes) / elapsed if elapsed > 0 else 0
        pct = d / total * 100
        eta = (total - d) / avg if avg > 0 else 0
        print(f'\r  {pct:5.1f}%  {d / 1024 / 1024:7.1f}/{total / 1024 / 1024:.0f} MB  '
              f'瞬 {inst / 1024 / 1024:5.2f}  均 {avg / 1024 / 1024:5.2f} MB/s  '
              f'剩 {eta / 60:4.1f} 分  活 {sum(1 for t in threads if t.is_alive())}/{n}',
              end='', flush=True)

    for t in threads:
        t.join()
    print()

    errs = [t.error for t in threads if t.error]
    if errs:
        for e in errs:
            print('  ✘', e)
        return 1

    # 校验每段大小，然后合并
    bad = []
    for i, (s, e) in enumerate(segs):
        want = e - s + 1
        got = os.path.getsize(seg_path(out, i)) if os.path.exists(seg_path(out, i)) else 0
        if got != want:
            bad.append(f'段{i}: {got} != {want}')
    if bad:
        for b in bad:
            print('  ✘', b)
        return 1

    print('合并中…')
    with open(out, 'wb') as o:
        for i in range(n):
            with open(seg_path(out, i), 'rb') as s:
                shutil.copyfileobj(s, o, 8 * 1024 * 1024)
            os.remove(seg_path(out, i))

    got = os.path.getsize(out)
    if got != total:
        print(f'✘ 最终大小不符：{got:,} != {total:,}')
        return 1
    print(f'✔ 完成 {got:,} 字节，用时 {(time.time() - t0) / 60:.1f} 分钟')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
