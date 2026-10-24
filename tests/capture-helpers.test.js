import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestionsToImage } from '../src/background/capture.js';
import { compareLayout } from '../src/editor/compare.js';
import { safeUrl, entryFor } from '../src/background/devtools.js';

test('scan rects map into image pixels, offset and clipped to the selection', () => {
  const scan = { rects: [{ x: 110, y: 120, w: 50, h: 10, kind: 'email' }, { x: 10, y: 10, w: 20, h: 10, kind: 'phone' }, { x: 380, y: 150, w: 100, h: 10, kind: 'ipv4' }] };
  assert.deepEqual(suggestionsToImage(scan, { scale: 2, ox: 100, oy: 100, clip: { w: 300, h: 200 } }), [
    { x: 20, y: 40, w: 100, h: 20, kind: 'email' },
    { x: 560, y: 100, w: 40, h: 20, kind: 'ipv4' }, // cut at the clip's right edge
  ]);
  assert.deepEqual(suggestionsToImage(null, { scale: 1, clip: { w: 1, h: 1 } }), []);
});

test('full-page scans shift by the scroll offset', () => {
  const scan = { rects: [{ x: 10, y: 50, w: 40, h: 10, kind: 'email' }] };
  // scroller at client y=60, scrolled 400 px when scanned → image y = 50 − 60 + 400 = 390
  assert.deepEqual(suggestionsToImage(scan, { scale: 1, ox: 0, oy: 60 - 400, clip: { w: 800, h: 3000 } }), [{ x: 10, y: 390, w: 40, h: 10, kind: 'email' }]);
});

test('compare layouts never upscale', () => {
  const side = compareLayout({ width: 1000, height: 500 }, { width: 800, height: 400 }, 'side');
  assert.equal(side.boxes[0].h, 400);
  assert.equal(side.boxes[0].w, 800);
  assert.equal(side.boxes[1].w, 800);
  const stacked = compareLayout({ width: 1000, height: 500 }, { width: 800, height: 400 }, 'stacked');
  assert.equal(stacked.boxes[0].w, 800);
  assert.equal(stacked.boxes[0].h, 400);
  assert.ok(stacked.boxes[1].y > stacked.boxes[0].y + stacked.boxes[0].h);
});

test('devtools URLs keep origin, path and parameter names only', () => {
  assert.equal(safeUrl('https://acme.service-now.com/api/now/table/incident?sysparm_query=x&token=abc#frag'), 'https://acme.service-now.com/api/now/table/incident?sysparm_query=…&token=…');
  assert.equal(safeUrl('data:text/plain,secret'), 'data:…');
  assert.equal(safeUrl('not a url'), '');
});

test('console events become log entries; other levels are ignored', () => {
  const [kind, e] = entryFor('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Failed' }, { type: 'number', value: 3, description: '3' }], stackTrace: { callFrames: [{ url: 'https://a.example/app.js?v=1', lineNumber: 9 }] } }, 1);
  assert.equal(kind, 'console');
  assert.deepEqual(e, { at: 1, level: 'error', text: 'Failed 3', source: 'https://a.example/app.js?v=…:10' });
  assert.equal(entryFor('Runtime.consoleAPICalled', { type: 'log', args: [] }), null);
  assert.equal(entryFor('Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'x' } }), null);
  assert.equal(entryFor('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: boom' } } }, 2)[1].text, 'TypeError: boom');
});
