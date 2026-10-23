import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planParts, validatePresign, MIN_PART } from '../src/storage/s3-plan.js';

test('plans parts with a short last part', () => {
  const parts = planParts(48211533, 8388608);
  assert.equal(parts.length, 6);
  assert.deepEqual(parts[0], { partNumber: 1, start: 0, end: 8388608 });
  assert.equal(parts[5].end, 48211533);
  for (const p of parts.slice(0, -1)) assert.ok(p.end - p.start >= MIN_PART);
});

test('rejects parts under 5 MiB', () => {
  assert.throws(() => planParts(10, 1024));
});

test('validates presign responses', () => {
  assert.doesNotThrow(() => validatePresign({ upload: { type: 'single', url: 'https://x' } }, 10));
  assert.throws(() => validatePresign({ upload: { type: 'multipart', partSize: 8388608, partUrls: ['a'], completeUrl: 'c' } }, 20_000_000), /part URLs/);
  assert.throws(() => validatePresign({}, 1), /upload/);
});
