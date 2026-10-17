/**
 * 最小 PNG 编解码器（零依赖，只用 node:zlib）。
 *
 * 为什么自己写：host 侧跑在 Node 里，没有 canvas / sharp 可用；而 host 要做两件事
 *   - 读用户给的三视图 PNG（解出灰度/彩色像素喂给雕刻算法）
 *   - 把重建结果的切片写回 PNG（给人和视觉模型看）
 * 只需要灰度(0) / 灰度+alpha(4) / RGB(2) / RGBA(6) 这四种、8bit、非隔行，
 * 覆盖截图与导出图的绝大多数情况。碰到不支持的组合会明确报错，而不是给错数据。
 */

import zlib from 'node:zlib'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {{width:number,height:number,channels:number,rgba:Uint8Array}}
 *          rgba 统一成 4 通道（灰度会展开，缺 alpha 补 255）
 */
export function decodePNG(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  for (let i = 0; i < 8; i++) {
    if (b[i] !== SIG[i]) throw new Error('不是 PNG：签名不匹配')
  }

  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []

  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > b.length) throw new Error(`PNG 损坏：${type} 块越界`)

    if (type === 'IHDR') {
      width = b.readUInt32BE(dataStart)
      height = b.readUInt32BE(dataStart + 4)
      bitDepth = b[dataStart + 8]
      colorType = b[dataStart + 9]
      interlace = b[dataStart + 12]
    } else if (type === 'IDAT') {
      idat.push(b.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    off = dataEnd + 4 // 跳过 CRC
  }

  if (!width || !height) throw new Error('PNG 缺少 IHDR')
  if (bitDepth !== 8) throw new Error(`只支持 8bit PNG，这张是 ${bitDepth}bit`)
  if (interlace !== 0) throw new Error('不支持隔行(interlaced) PNG')

  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = CH[colorType]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}（支持 0/2/4/6）`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  const BPP = channels

  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const a = x >= BPP ? cur[x - BPP] : 0
      const bb = prev ? prev[x] : 0
      const c = prev && x >= BPP ? prev[x - BPP] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + bb) & 0xff; break
        case 3: v = (v + ((a + bb) >> 1)) & 0xff; break
        case 4: v = (v + paeth(a, bb, c)) & 0xff; break
        default: throw new Error(`PNG 未知滤波器 ${filter}`)
      }
      cur[x] = v
    }
  }

  // 统一成 RGBA
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels
    const d = i * 4
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = 255
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = out[s + 1]
    } else if (channels === 3) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]
      rgba[d + 3] = 255
    } else {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]
    }
  }

  return { width, height, channels, rgba }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// ---------------------------------------------------------------------------
// 编码（灰度 8bit）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 灰度（或按 alpha 合成到浅色底）PNG。
 * @param {Uint8Array|Uint8ClampedArray} gray 长度 width*height，0=黑 255=白
 * @param {number} width @param {number} height
 * @returns {Buffer}
 */
export function encodeGrayPNG(gray, width, height) {
  if (gray.length < width * height) throw new Error('encodeGrayPNG: 像素数不足')
  const stride = width
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    for (let x = 0; x < width; x++) raw[y * (stride + 1) + 1 + x] = gray[y * width + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 0   // color type: grayscale
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  return Buffer.concat([
    Buffer.from(SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 从 RGBA 画一张"剪影对照图"：左=输入剪影，右=重投影，中间分隔线。
 * 给人和视觉模型一眼看出重建是否忠实。
 */
export function sideBySide(aMask, aw, ah, bMask, bw, bh, gap = 8) {
  const W = aw + gap + bw
  const H = Math.max(ah, bh)
  const out = new Uint8Array(W * H).fill(24)
  const put = (mask, w, h, ox) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) out[y * W + ox + x] = 235
      }
    }
  }
  put(aMask, aw, ah, 0)
  put(bMask, bw, bh, aw + gap)
  for (let y = 0; y < H; y++) {
    for (let g = 0; g < gap; g++) out[y * W + aw + g] = 90
  }
  return { gray: out, width: W, height: H }
}
