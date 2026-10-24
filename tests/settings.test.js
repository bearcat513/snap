import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePalette, recordingQuality, DEFAULTS } from '../src/shared/settings.js';

test('palette keeps valid #rrggbb colors, lower-cased and de-duplicated', () => {
  assert.deepEqual(normalizePalette(['#FF0000', '#ff0000', 'red', '#abc', ' #00ff00 ']), ['#ff0000', '#00ff00']);
  assert.equal(normalizePalette(Array.from({ length: 20 }, (_, i) => `#0000${String(i).padStart(2, '0')}`)).length, 16);
});

test('an empty or invalid palette falls back to the defaults', () => {
  assert.deepEqual(normalizePalette([]), DEFAULTS['editor.palette']);
  assert.deepEqual(normalizePalette('nope'), DEFAULTS['editor.palette']);
});

test('recording quality presets map to capture constraints and bitrate', () => {
  assert.deepEqual(recordingQuality(DEFAULTS), { maxWidth: 1920, maxHeight: 1080, fps: 30, videoBitsPerSecond: 2_500_000 });
  const q = recordingQuality({ 'recording.quality': '720p', 'recording.fps': '60', 'recording.bitrateMbps': 8 });
  assert.deepEqual(q, { maxWidth: 1280, maxHeight: 720, fps: 60, videoBitsPerSecond: 8_000_000 });
});

test('recording quality clamps bad values', () => {
  const q = recordingQuality({ 'recording.quality': '8k', 'recording.fps': 144, 'recording.bitrateMbps': 500 });
  assert.equal(q.maxWidth, 1920);
  assert.equal(q.fps, 30);
  assert.equal(q.videoBitsPerSecond, 50_000_000);
});
