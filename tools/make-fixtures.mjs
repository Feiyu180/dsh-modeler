#!/usr/bin/env node
// tools/make-fixtures.mjs
//
// 生成三视图测试夹具：8 个形状 × 3 视图 = 24 张灰度 PNG + samples/expected.json。
//
// 设计要点：
// - 零第三方依赖，只用 node 内置模块。
// - 不 import 本仓库任何源码：每个剪影都用解析几何公式独立判定（矩形/圆/三角形/
//   并集/挖孔），作为独立参照物。
// - 手写最小 PNG 编码器（grayscale colorType=0，每像素 1 字节），CRC32 自建表。
// - 每像素 4×4 超采样取平均再二值化（>=8/16 视为前景），产生真实的抗锯齿边缘。
// - 前景=黑(0)，背景=白(255)。
// - 除 tiny 外全部裁到前景内容框（内容贴边）；tiny 保留 200×200 画布且内容居中，
//   专门验证插件自动裁内容框。
//
// 性能：全部 24 张图按解析几何超采样渲染，总命中判定约 5M 次，远低于 3 秒。
// （若需要裁剪画布可把非 tiny 视图的画布缩到 160×160，但当前 200×200 已足够快。）

import { deflateSync, inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'samples');
const SS = 4; // 每像素 4×4 超采样

// ---------------------------------------------------------------- PNG 编码/解码

// CRC32，标准多项式 0xEDB88320，自建表
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// pixels: Uint8Array，行主序，0=前景(黑)，255=背景(白)
function encodePNG(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colorType: 0 = 灰度
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    raw.set(pixels.subarray(y * width, y * width + width), y * stride + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 自检用最小解码器：校验签名、逐 chunk 校验 CRC、解压 IDAT、剥离 filter byte（必须全 0）
function decodePNG(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(buf.length > 8 && buf.subarray(0, 8).equals(sig), 'PNG 签名错误');
  let off = 8;
  let width = 0;
  let height = 0;
  const idatParts = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crcCalc = crc32(Buffer.concat([buf.subarray(off + 4, off + 8), data]));
    const crcStored = buf.readUInt32BE(off + 8 + len);
    assert.strictEqual(crcCalc, crcStored, `chunk ${type} CRC 不一致`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.strictEqual(data[8], 8, 'IHDR bit depth 应为 8');
      assert.strictEqual(data[9], 0, 'IHDR colorType 应为 0（灰度）');
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    }
    off += 12 + len;
  }
  assert(width > 0 && height > 0, 'IHDR 缺失');
  const raw = inflateSync(Buffer.concat(idatParts));
  assert.strictEqual(raw.length, height * (width + 1), 'IDAT 解压后尺寸不符');
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    assert.strictEqual(raw[y * (width + 1)], 0, `第 ${y} 行 filter byte 应为 0`);
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------- 解析几何判定

function rectHit(x0, y0, x1, y1) {
  return (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
}
function circleHit(cx, cy, r) {
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
}
function triangleHit(apexX, apexY, baseY, halfWidth) {
  // 等腰三角形：顶点在上，底边在 baseY（图坐标 y 向下增大）
  return (x, y) => {
    if (y < apexY || y >= baseY) return false;
    const t = (y - apexY) / (baseY - apexY);
    return Math.abs(x - apexX) <= t * halfWidth;
  };
}
function unionHit(...fns) {
  return (x, y) => fns.some((f) => f(x, y));
}
function frameHit(x0, y0, x1, y1, hx0, hy0, hx1, hy1) {
  // 方框 = 外矩形 - 内孔
  return (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1
    && !(x >= hx0 && x < hx1 && y >= hy0 && y < hy1);
}

// ---------------------------------------------------------------- 形状定义

// 每个视图：{ w, h, hit } 在 w×h 画布上用解析公式渲染；keep=true 表示不裁内容框
// （tiny 必须保留整张 200×200 画布以测试自动裁内容框）。
// 除 tiny 外所有视图都是画布 = 内容尺寸，裁剪后内容必然贴边。
const SHAPES = {
  // 长方体 120(宽)×60(高)×40(深)：前=宽×高，侧=深×高，俯=宽×深
  box: {
    front: { w: 120, h: 60, hit: rectHit(0, 0, 120, 60) },
    side: { w: 40, h: 60, hit: rectHit(0, 0, 40, 60) },
    top: { w: 120, h: 40, hit: rectHit(0, 0, 120, 40) },
  },
  // 球：直径 120，三视图同形。圆心 (60,60) 半径 60，恰好横跨像素 0..119
  sphere: {
    front: { w: 120, h: 120, hit: circleHit(60, 60, 60) },
    side: { w: 120, h: 120, hit: circleHit(60, 60, 60) },
    top: { w: 120, h: 120, hit: circleHit(60, 60, 60) },
  },
  // 立式圆柱：半径 50，高 140
  cylinder: {
    front: { w: 100, h: 140, hit: rectHit(0, 0, 100, 140) },
    side: { w: 100, h: 140, hit: rectHit(0, 0, 100, 140) },
    top: { w: 100, h: 100, hit: circleHit(50, 50, 50) },
  },
  // 立式圆锥：底 100 高 140。三角形解析高取 141：顶点那行因 <50% 覆盖率不会成为
  // 前景，裁剪后内容框正好 140 行，且顶点贴顶、底边贴底。
  cone: {
    front: { w: 100, h: 141, hit: triangleHit(50, 0, 141, 50) },
    side: { w: 100, h: 141, hit: triangleHit(50, 0, 141, 50) },
    top: { w: 100, h: 100, hit: circleHit(50, 50, 50) },
  },
  // L 形柱体：前视竖臂在左（宽 40 高 120）+ 底部横臂（高 40 宽 120），凹角保留
  lshape: {
    front: { w: 120, h: 120, hit: unionHit(rectHit(0, 0, 40, 120), rectHit(0, 80, 120, 120)) },
    side: { w: 60, h: 120, hit: rectHit(0, 0, 60, 120) },
    top: { w: 40, h: 60, hit: rectHit(0, 0, 40, 60) },
  },
  // 中间带方孔的方板：外 120×120，孔 50×50 居中（中心 60），板厚 30
  'torus-ish': {
    front: { w: 120, h: 120, hit: frameHit(0, 0, 120, 120, 35, 35, 85, 85) },
    side: { w: 120, h: 30, hit: rectHit(0, 0, 120, 30) },
    top: { w: 120, h: 120, hit: frameHit(0, 0, 120, 120, 35, 35, 85, 85) },
  },
  // 左右不对称台阶：左半高 100，右半高 50（右半是下半截）
  asym: {
    front: { w: 140, h: 100, hit: unionHit(rectHit(0, 0, 70, 100), rectHit(70, 50, 140, 100)) },
    side: { w: 60, h: 100, hit: rectHit(0, 0, 60, 100) },
    top: { w: 140, h: 60, hit: rectHit(0, 0, 140, 60) },
  },
  // 极小主体：6×6 方块在 200×200 画布正中，四周大量留白
  tiny: {
    front: { w: 200, h: 200, keep: true, hit: rectHit(97, 97, 103, 103) },
    side: { w: 200, h: 200, keep: true, hit: rectHit(97, 97, 103, 103) },
    top: { w: 200, h: 200, keep: true, hit: rectHit(97, 97, 103, 103) },
  },
};

// ---------------------------------------------------------------- 光栅化

function rasterize(w, h, hit) {
  const px = new Uint8Array(w * h);
  const half = (SS * SS) / 2;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = 0;
      for (let j = 0; j < SS; j++) {
        const sy = y + (j + 0.5) / SS;
        for (let i = 0; i < SS; i++) {
          if (hit(x + (i + 0.5) / SS, sy)) inside++;
        }
      }
      if (inside >= half) {
        px[y * w + x] = 0; // 前景=黑
        count++;
      } else {
        px[y * w + x] = 255; // 背景=白
      }
    }
  }
  return { px, count };
}

function findBbox(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[y * w + x] === 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  assert(x0 <= x1 && y0 <= y1, '画布上没有前景像素');
  return [x0, y0, x1, y1];
}

function crop(px, w, h, [x0, y0, x1, y1]) {
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      out[y * cw + x] = px[(y0 + y) * w + (x0 + x)];
    }
  }
  return { px: out, w: cw, h: ch };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const t0 = performance.now();
  mkdirSync(OUT_DIR, { recursive: true });

  // 清掉可能残留的旧夹具，保证 samples 下正好 24 张 PNG + expected.json
  for (const old of ['expected.json', ...Object.keys(SHAPES).flatMap(
    (n) => ['front', 'side', 'top'].map((v) => `${n}-${v}.png`))]) {
    try {
      // 只删属于本夹具集的已知文件，不碰目录里其他东西
      unlinkSync(join(OUT_DIR, old));
    } catch { /* 不存在则忽略 */ }
  }

  const expected = {};
  for (const [name, views] of Object.entries(SHAPES)) {
    expected[name] = {};
    for (const [view, spec] of Object.entries(views)) {
      const { px, count } = rasterize(spec.w, spec.h, spec.hit);
      const bbox = findBbox(px, spec.w, spec.h);
      let imgPx = px;
      let imgW = spec.w;
      let imgH = spec.h;
      if (!spec.keep) {
        const c = crop(px, spec.w, spec.h, bbox);
        imgPx = c.px;
        imgW = c.w;
        imgH = c.h;
      }
      const file = `${name}-${view}.png`;
      writeFileSync(join(OUT_DIR, file), encodePNG(imgW, imgH, imgPx));
      expected[name][view] = {
        file,
        width: bbox[2] - bbox[0] + 1,
        height: bbox[3] - bbox[1] + 1,
        area: count,
        // bbox 用保存后图像坐标：裁剪过的就是 [0,0,w-1,h-1]；tiny 保留画布坐标
        bbox: spec.keep ? bbox : [0, 0, imgW - 1, imgH - 1],
      };
    }
  }
  writeFileSync(join(OUT_DIR, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');

  // ---------------- 自检 1：每个 PNG 都能被自己的解码器读回，且前景像素数与 expected 一致
  let totalFg = 0;
  for (const [name, views] of Object.entries(expected)) {
    for (const [view, exp] of Object.entries(views)) {
      const buf = readFileSync(join(OUT_DIR, exp.file));
      assert(buf.length > 0, `${exp.file} 为空文件`);
      const img = decodePNG(buf);
      // 图像尺寸：tiny 保留整张 200×200 画布，其余已裁到内容框
      const spec = SHAPES[name][view];
      const savedW = spec.keep ? spec.w : exp.width;
      const savedH = spec.keep ? spec.h : exp.height;
      assert.strictEqual(img.width, savedW, `${exp.file} 宽度不符`);
      assert.strictEqual(img.height, savedH, `${exp.file} 高度不符`);
      let fg = 0;
      for (let i = 0; i < img.pixels.length; i++) {
        if (img.pixels[i] === 0) fg++;
      }
      assert.strictEqual(fg, exp.area, `${exp.file} 前景像素数 ${fg} != expected ${exp.area}`);
      totalFg += fg;
    }
  }
  assert.strictEqual(totalFg, Object.values(expected).reduce(
    (a, v) => a + Object.values(v).reduce((b, e) => b + e.area, 0), 0));

  // ---------------- 自检 2：box 三视图内容框尺寸（容差 1px）
  const bx = expected.box;
  assert(Math.abs(bx.front.width - 120) <= 1 && Math.abs(bx.front.height - 60) <= 1, 'box front 应为 120×60');
  assert(Math.abs(bx.side.width - 40) <= 1 && Math.abs(bx.side.height - 60) <= 1, 'box side 应为 40×60');
  assert(Math.abs(bx.top.width - 120) <= 1 && Math.abs(bx.top.height - 40) <= 1, 'box top 应为 120×40');

  // ---------------- 自检 3：tiny 内容框在画布正中（中心差 ≤ 2px）
  const CANVAS_C = 99.5; // 200×200 像素网格中心
  for (const view of ['front', 'side', 'top']) {
    const bb = expected.tiny[view].bbox;
    const cx = (bb[0] + bb[2]) / 2;
    const cy = (bb[1] + bb[3]) / 2;
    assert(Math.abs(cx - CANVAS_C) <= 2 && Math.abs(cy - CANVAS_C) <= 2,
      `tiny ${view} 内容框不在画布正中：中心 (${cx}, ${cy})`);
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  const pngCount = Object.values(expected).reduce(
    (a, v) => a + Object.keys(v).length, 0);
  console.log(`OK 生成 ${pngCount} 张 PNG + expected.json，耗时 ${elapsed}ms`);
  console.log(`产物目录：${OUT_DIR}`);
}

try {
  main();
} catch (err) {
  console.error(`夹具生成失败：${err.message}`);
  process.exit(1);
}
