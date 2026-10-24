import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vttTime, buildVtt, cuesInRange, transcriptText, cueFor } from '../src/shared/captions.js';

const cues = [
  { startMs: 0, endMs: 1500, text: 'Open the incident' },
  { startMs: 2000, endMs: 4000, text: 'then set the state --> resolved' },
  { startMs: 9000, endMs: 10_000, text: 'outside' },
];

test('VTT timestamps', () => {
  assert.equal(vttTime(0), '00:00:00.000');
  assert.equal(vttTime(3_723_045), '01:02:03.045');
});

test('cues are clipped and shifted to the exported range', () => {
  assert.deepEqual(cuesInRange(cues, [1000, 5000]), [
    { startMs: 0, endMs: 500, text: 'Open the incident' },
    { startMs: 1000, endMs: 3000, text: 'then set the state --> resolved' },
  ]);
  assert.equal(transcriptText(cues, [0, 5000]), 'Open the incident then set the state --> resolved');
});

test('WebVTT output is well-formed and escapes the cue arrow', () => {
  const vtt = buildVtt(cues, [0, 5000]);
  assert.ok(vtt.startsWith('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nOpen the incident\n'));
  assert.ok(vtt.includes('then set the state → resolved'));
  assert.ok(!vtt.includes('outside'));
});

test('cue timing estimates from word count, after the previous cue', () => {
  assert.deepEqual(cueFor('one two three four five', 10_000, 0), { startMs: 8100, endMs: 10_000, text: 'one two three four five' });
  assert.deepEqual(cueFor('hi', 10_000, 9800), { startMs: 9800, endMs: 10_300, text: 'hi' });
});
