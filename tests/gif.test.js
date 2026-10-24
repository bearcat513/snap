import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lzwEncode, encodeGif, buildPalette, indexPixels } from '../src/editor/export/gif.js';

// Reference GIF LZW decoder (no early change), for round-trip checks.
function lzwDecode(data) {
  const min = data[0];
  const bytes = [];
  for (let i = 1; data[i] !== 0; i += data[i] + 1) bytes.push(...data.slice(i + 1, i + 1 + data[i]));
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict;
  let next;
  const reset = () => { dict = Array.from({ length: clear }, (_, i) => [i]); dict[clear] = []; dict[eoi] = []; next = eoi + 1; size = min + 1; };
  reset();
  const out = [];
  let pos = 0;
  let prev = null;
  const read = () => {
    let code = 0;
    for (let b = 0; b < size; b++, pos++) code |= ((bytes[pos >> 3] >> (pos & 7)) & 1) << b;
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    if (prev === null) { out.push(...dict[code]); prev = code; continue; }
    const entry = code < next ? dict[code] : [...dict[prev], dict[prev][0]];
    if (next < 4096) dict[next++] = [...dict[prev], entry[0]];
    out.push(...entry);
    prev = code;
    if (next === 1 << size && size < 12) size++;
  }
  return out;
}

test('LZW round-trips through a reference decoder, across code-size changes and dictionary resets', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cases = [
    [5],
    Array(1000).fill(3),
    Array.from({ length: 50_000 }, () => Math.floor(rand() * 256)), // forces resets at 4096 codes
    Array.from({ length: 20_000 }, (_, i) => (i >> 4) & 7), // runs
  ];
  for (const input of cases) {
    const decoded = lzwDecode(lzwEncode(Uint8Array.from(input)));
    assert.equal(decoded.length, input.length);
    assert.ok(decoded.every((v, i) => v === input[i]), 'content matches');
  }
});

test('palette and mapping keep distinct colours distinct', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const palette = buildPalette([rgba]);
  const idx = indexPixels(rgba, palette);
  assert.equal(new Set(idx).size, 4);
  for (let p = 0; p < 4; p++) {
    assert.deepEqual([...palette.slice(idx[p] * 3, idx[p] * 3 + 3)], [...rgba.slice(p * 4, p * 4 + 3)]);
  }
});

test('encodes a looping GIF89a with one image block per frame', () => {
  const w = 4;
  const h = 2;
  const frame = (v) => ({ rgba: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : v)), delayMs: 100 });
  const gif = encodeGif([frame(0), frame(128), frame(255)], w, h);
  const s = Buffer.from(gif).toString('latin1');
  assert.equal(s.slice(0, 6), 'GIF89a');
  assert.equal(gif[6] | (gif[7] << 8), w);
  assert.ok(s.includes('NETSCAPE2.0'));
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.equal((s.match(/\x21\xf9\x04/g) || []).length, 3, 'one graphic control extension per frame');
});
