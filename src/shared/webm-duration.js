// MediaRecorder WebM output has no Duration in Segment/Info, which breaks seeking in many players.
// Insert one (EBML float64) so the file is seekable. Only the header region is rewritten.

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const HEAD_BYTES = 1024 * 1024;

function vintLength(first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

function readId(b, pos) {
  const len = vintLength(b[pos]);
  if (!len || len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}

function readSize(b, pos) {
  const len = vintLength(b[pos]);
  if (!len || pos + len > b.length) return null;
  let value = b[pos] & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

function encodeSize8(value) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = value;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function readUint(b, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return v;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Returns a new Blob with Duration set, or the original blob if it can't (or needn't) be patched. */
export async function fixWebmDuration(blob, durationMs) {
  if (!durationMs || durationMs <= 0) return blob;
  const headLen = Math.min(blob.size, HEAD_BYTES);
  const b = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
  const patched = patchHeader(b, durationMs);
  if (!patched) return blob;
  return new Blob([patched, blob.slice(headLen)], { type: blob.type });
}

/** Pure function over the header bytes; exported for tests. Returns patched bytes or null. */
export function patchHeader(b, durationMs) {
  let pos = 0;
  const ebml = readId(b, pos);
  if (!ebml || ebml.id !== ID_EBML) return null;
  pos += ebml.len;
  const ebmlSize = readSize(b, pos);
  if (!ebmlSize || ebmlSize.unknown) return null;
  pos += ebmlSize.len + ebmlSize.value;

  const seg = readId(b, pos);
  if (!seg || seg.id !== ID_SEGMENT) return null;
  const segSizePos = pos + seg.len;
  const segSize = readSize(b, segSizePos);
  if (!segSize) return null;
  pos = segSizePos + segSize.len;

  while (pos < b.length) {
    const el = readId(b, pos);
    if (!el) return null;
    const sizePos = pos + el.len;
    const size = readSize(b, sizePos);
    if (!size) return null;
    const dataStart = sizePos + size.len;
    if (el.id === ID_CLUSTER) return null;
    if (el.id === ID_INFO) {
      if (size.unknown) return null;
      const dataEnd = dataStart + size.value;
      if (dataEnd > b.length) return null;
      let scale = 1000000;
      let p = dataStart;
      while (p < dataEnd) {
        const c = readId(b, p);
        if (!c) return null;
        const cs = readSize(b, p + c.len);
        if (!cs) return null;
        const cData = p + c.len + cs.len;
        if (c.id === ID_DURATION) {
          const view = new DataView(b.buffer, b.byteOffset + cData, cs.value);
          const existing = cs.value === 8 ? view.getFloat64(0) : cs.value === 4 ? view.getFloat32(0) : 0;
          if (existing > 0) return null; // already has a duration
        }
        if (c.id === ID_TIMECODE_SCALE) scale = readUint(b, cData, cs.value) || scale;
        p = cData + cs.value;
      }
      const durationElem = new Uint8Array(11);
      durationElem.set([0x44, 0x89, 0x88]);
      new DataView(durationElem.buffer).setFloat64(3, (durationMs * 1e6) / scale);

      const newInfoSize = encodeSize8(size.value + durationElem.length);
      const growth = newInfoSize.length - size.len + durationElem.length;
      const parts = [];
      if (segSize.unknown) {
        parts.push(b.subarray(0, sizePos));
      } else {
        // Known-size segment: its content grows by `growth` bytes.
        parts.push(b.subarray(0, segSizePos), encodeSize8(segSize.value + growth));
        parts.push(b.subarray(segSizePos + segSize.len, sizePos));
      }
      parts.push(newInfoSize, b.subarray(dataStart, dataEnd), durationElem, b.subarray(dataEnd));
      return concat(parts);
    }
    if (size.unknown) return null;
    pos = dataStart + size.value;
  }
  return null;
}
