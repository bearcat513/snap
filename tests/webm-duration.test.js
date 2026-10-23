import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchHeader, fixWebmDuration } from '../src/shared/webm-duration.js';

// Minimal MediaRecorder-like WebM: EBML header, Segment (unknown size), Info (TimecodeScale), Cluster.
function sampleWebm() {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]; // scale 1e6
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00];
  return new Uint8Array([...ebml, ...segment, ...info, ...cluster]);
}

test('inserts a Duration element into Info', () => {
  const out = patchHeader(sampleWebm(), 12345);
  assert.ok(out);
  const hex = Buffer.from(out).toString('hex');
  const at = hex.indexOf('448988');
  assert.ok(at > 0, 'duration element present');
  const dur = Buffer.from(out).readDoubleBE(at / 2 + 3);
  assert.equal(dur, 12345);
  // Info size rewritten as an 8-byte vint covering old (7) + 11 bytes.
  assert.ok(hex.includes('1549a966' + '0100000000000012'));
  // Cluster still intact at the end.
  assert.ok(hex.endsWith('1f43b6758100'));
});

test('leaves non-webm and already-patched data alone', async () => {
  assert.equal(patchHeader(new Uint8Array([1, 2, 3]), 10), null);
  const once = patchHeader(sampleWebm(), 500);
  assert.equal(patchHeader(once, 500), null);
  const blob = new Blob([sampleWebm()], { type: 'video/webm' });
  const fixed = await fixWebmDuration(blob, 1000);
  assert.equal(fixed.size, blob.size + 11 + 7);
});
