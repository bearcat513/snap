// Animated GIF encoder (§6 GIF export). No dependencies; runs in Node for tests.
// One global 256-colour palette (median cut over sampled pixels of every frame), nearest-colour
// mapping through a 15-bit cache, LZW-compressed frames, looping forever.

/** Median-cut palette from RGBA pixel arrays. Returns Uint8Array(256 * 3). */
export function buildPalette(frames, maxSamples = 120_000) {
  const total = frames.reduce((n, f) => n + f.length / 4, 0);
  const step = Math.max(1, Math.floor(total / maxSamples));
  const samples = [];
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4 * step) samples.push((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]);
  }
  const boxes = [samples];
  while (boxes.length < 256) {
    // Split the box with the widest channel range.
    let best = -1;
    let bestRange = 0;
    let bestShift = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (const shift of [16, 8, 0]) {
        let lo = 255;
        let hi = 0;
        for (const c of box) { const v = (c >> shift) & 255; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = b; bestShift = shift; }
      }
    }
    if (best < 0 || bestRange === 0) break;
    const box = boxes[best].sort((a, b) => ((a >> bestShift) & 255) - ((b >> bestShift) & 255));
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let r = 0; let g = 0; let b = 0;
    for (const c of box) { r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255; }
    const n = box.length || 1;
    palette.set([Math.round(r / n), Math.round(g / n), Math.round(b / n)], i * 3);
  });
  return palette;
}

/** Map RGBA pixels to palette indexes (alpha ignored). `cache` is shared across frames. */
export function indexPixels(rgba, palette, cache = new Int16Array(32768).fill(-1)) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i]; const g = rgba[i + 1]; const b = rgba[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx < 0) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < 256; j++) {
        const dr = r - palette[j * 3]; const dg = g - palette[j * 3 + 1]; const db = b - palette[j * 3 + 2];
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bestD) { bestD = d; best = j; }
      }
      idx = cache[key] = best;
    }
    out[p] = idx;
  }
  return out;
}

/** GIF LZW compression of 8-bit indexes. Returns the sub-block-wrapped image data (min code size byte first). */
export function lzwEncode(indexes, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes = [];
  let cur = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  const write = (code) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { bytes.push(cur & 255); cur >>>= 8; bits -= 8; }
  };
  let dict = new Map();
  let next = eoi + 1;
  write(clear);
  let prefix = indexes[0];
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i];
    const key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    write(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      write(clear);
      dict = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    }
    prefix = k;
  }
  write(prefix);
  write(eoi);
  if (bits > 0) bytes.push(cur & 255);
  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/** Streaming writer: frames are compressed as they're added, so only the output is kept in memory. */
export class GifEncoder {
  constructor(width, height, palette) {
    this.width = width;
    this.height = height;
    this.palette = palette;
    this.cache = new Int16Array(32768).fill(-1);
    this.parts = [];
    this.push([...'GIF89a'].map((c) => c.charCodeAt(0)), u16(width), u16(height), 0xf7, 0, 0); // global table, 256 colours
    this.parts.push(palette);
    this.push(0x21, 0xff, 11, [...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, u16(0), 0); // loop forever
  }

  push(...b) {
    this.parts.push(Uint8Array.from(b.flat()));
  }

  addFrame(rgba, delayMs) {
    this.push(0x21, 0xf9, 4, 0x04, u16(Math.max(2, Math.round(delayMs / 10))), 0, 0); // keep previous frame
    this.push(0x2c, u16(0), u16(0), u16(this.width), u16(this.height), 0);
    this.parts.push(Uint8Array.from(lzwEncode(indexPixels(rgba, this.palette, this.cache))));
  }

  /** Returns the finished GIF as a Uint8Array. */
  finish() {
    this.push(0x3b);
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const u16 = (n) => [n & 255, (n >> 8) & 255];

/**
 * frames: [{ rgba: Uint8ClampedArray, delayMs }] all `width`×`height`.
 * Returns Uint8Array of a looping GIF89a.
 */
export function encodeGif(frames, width, height) {
  const enc = new GifEncoder(width, height, buildPalette(frames.map((f) => f.rgba)));
  for (const f of frames) enc.addFrame(f.rgba, f.delayMs);
  return enc.finish();
}
