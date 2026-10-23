// Generates icons/{16,32,48,128}.png with no dependencies (procedural drawing + zlib PNG encoder).
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape functions in unit space [0,1]². Returns [r,g,b,a] or null.
function sample(x, y) {
  const r = 0.2; // rounded square
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return null;
  // Gradient background
  const t = (x + y) / 2;
  let col = [37 + t * 20, 99 - t * 30, 235 - t * 40];
  // Viewfinder corners
  const inBand = (v, a, b) => v >= a && v <= b;
  const m = 0.2, len = 0.2, w = 0.075;
  const corner =
    ((inBand(x, m, m + len) || inBand(x, 1 - m - len, 1 - m)) && (inBand(y, m, m + w) || inBand(y, 1 - m - w, 1 - m))) ||
    ((inBand(y, m, m + len) || inBand(y, 1 - m - len, 1 - m)) && (inBand(x, m, m + w) || inBand(x, 1 - m - w, 1 - m)));
  if (corner) col = [255, 255, 255];
  // Red record dot
  if (Math.hypot(x - 0.5, y - 0.5) < 0.13) col = [255, 92, 92];
  return [...col, 255];
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (s) { r += s[0]; g += s[1]; b += s[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  writeFileSync(join(root, 'icons', `${size}.png`), png(size, buf));
}
console.log('icons written');
