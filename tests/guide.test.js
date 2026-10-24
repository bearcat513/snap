import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoTimeOf, stepText, guideSteps, frameTimeFor } from '../src/shared/guide.js';

test('wall-clock clicks map to video time, minus pauses', () => {
  const pauses = [[2000, 5000], [8000, 9000]];
  assert.equal(videoTimeOf(1500, 1000, pauses), 500);
  assert.equal(videoTimeOf(3000, 1000, pauses), null, 'during a pause');
  assert.equal(videoTimeOf(6000, 1000, pauses), 2000);
  assert.equal(videoTimeOf(10_000, 1000, pauses), 5000);
  assert.equal(videoTimeOf(9500, 1000, [[9000, null]]), null, 'still paused');
  assert.equal(videoTimeOf(500, 1000), null, 'before the start');
});

test('step wording follows the role', () => {
  assert.equal(stepText({ label: 'Resolve', role: 'button' }), 'Click “Resolve”');
  assert.equal(stepText({ label: 'Docs', role: 'link' }), 'Open “Docs”');
  assert.equal(stepText({ label: 'Short description', role: 'field' }), 'Click the “Short description” field');
  assert.equal(stepText({ label: 'Notes', role: 'tab' }), 'Open the “Notes” tab');
  assert.equal(stepText({ label: 'Urgent', role: 'checkbox' }), 'Select “Urgent”');
  assert.equal(stepText({ role: 'element' }), 'Click here');
});

test('guide steps stay in range and collapse double clicks', () => {
  const clicks = [
    { t: 100, label: 'A', role: 'button' }, { t: 1000, label: 'Save', role: 'button' }, { t: 1300, label: 'Save', role: 'button' },
    { t: 2500, label: 'Save', role: 'button' }, { t: 9000, label: 'Late', role: 'link' },
  ];
  const steps = guideSteps(clicks, [500, 5000]);
  assert.deepEqual(steps.map((s) => [s.timeMs, s.text]), [[1000, 'Click “Save”'], [2500, 'Click “Save”']]);
  assert.equal(frameTimeFor({ timeMs: 1000 }, 500), 850);
  assert.equal(frameTimeFor({ timeMs: 520 }, 500), 500);
});
