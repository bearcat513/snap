import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingFailures, retryPlan, formatForFile, shareLink } from '../src/shared/saves.js';
import { attachmentProblem, describeLimits, workNoteText, canRedeliver } from '../src/shared/sn.js';

const at = (m) => `2026-10-24T10:${String(m).padStart(2, '0')}:00.000Z`;

test('file names map back to export formats', () => {
  assert.equal(formatForFile('incident_INC1_20261024-101500.pdf'), 'pdf');
  assert.equal(formatForFile('x.webm'), 'video');
  assert.equal(formatForFile('x_frames.zip'), 'frames');
  assert.equal(formatForFile('x.json'), 'sidecar');
  assert.equal(formatForFile('x.vtt'), 'sidecar');
  assert.equal(formatForFile('x.gif'), 'gif');
  assert.equal(formatForFile(''), null);
});

test('a failure fixed by a later save is not pending', () => {
  const capture = { saves: [
    { adapter: 's3', ok: false, name: 'a.mp4', error: 'HTTP 500', at: at(1) },
    { adapter: 's3', ok: true, name: 'a.mp4', at: at(2) },
    { adapter: 'servicenow', ok: false, name: 'a.pdf', error: 'timed out', at: at(3) },
    { adapter: 'download', ok: true, name: 'a.pdf', at: at(3) },
    { adapter: 'editor', ok: false, name: '', error: 'boom', at: at(4) },
  ] };
  assert.deepEqual(pendingFailures(capture).map((f) => `${f.adapter}:${f.format}`), ['servicenow:pdf']);
});

test('the retry plan groups formats per destination in save order', () => {
  const capture = { saves: [
    { adapter: 'download', ok: false, name: 'a.png', at: at(1) },
    { adapter: 's3', ok: false, name: 'a.mp4', at: at(1) },
    { adapter: 's3', ok: false, name: 'a.md', at: at(1) },
    { adapter: 's3', ok: false, name: 'a.json', at: at(1) },
  ] };
  assert.deepEqual(retryPlan(capture, ['s3', 'servicenow', 'download']), [
    { id: 's3', formats: ['video', 'sidecar'] }, { id: 'download', formats: ['png'] },
  ]);
});

test('instance attachment limits catch oversized files and blocked types', () => {
  const limits = { maxBytes: 10 * 1024 * 1024, allowedExtensions: ['pdf', 'png', 'mp4'] };
  assert.equal(attachmentProblem({ name: 'a.pdf', size: 1000 }, limits), '');
  assert.match(attachmentProblem({ name: 'a.webm', size: 1000 }, limits), /doesn't accept \.webm/);
  assert.match(attachmentProblem({ name: 'a.mp4', size: 20 * 1024 * 1024 }, limits), /20 MB.*up to 10 MB/);
  assert.equal(attachmentProblem({ name: 'a.webm', size: 1 }, {}), '');
  assert.equal(attachmentProblem({ name: 'a.webm', size: 1 }, undefined), '');
  assert.equal(describeLimits(limits), 'This instance accepts up to 10 MB per file; types: pdf, png, mp4.');
  assert.equal(describeLimits({}), '');
});

test('work note names the files, the description and any links', () => {
  const note = workNoteText({
    capture: { context: { description: 'Field should be read-only' } },
    files: [{ name: 'a.pdf' }], links: [{ label: 'S3: a.mp4', url: 'https://s3.example/a.mp4' }],
  });
  assert.equal(note, 'Snap Companion attached 1 file: a.pdf\n\nField should be read-only\n\nS3: a.mp4: https://s3.example/a.mp4');
});

test('a delivery can be retried after a total failure or a timeout, not after success', () => {
  assert.equal(canRedeliver(null), true);
  assert.equal(canRedeliver({ state: 'done', results: [{ ok: false }, { ok: false }] }), true);
  assert.equal(canRedeliver({ state: 'done', results: [{ ok: true }, { ok: false }] }), false);
  assert.equal(canRedeliver({ state: 'claimed', at: 1000 }, 1000 + 60_000), false);
  assert.equal(canRedeliver({ state: 'claimed', at: 1000 }, 1000 + 6 * 60_000), true);
});

test('a step that failed before a file existed can still be retried', () => {
  const c = { saves: [{ adapter: 's3', ok: false, name: 'video', error: 'x', at: at(1) }] };
  assert.deepEqual(retryPlan(c, ['s3']), [{ id: 's3', formats: ['video'] }]);
});

test('shareLink prefers the newest issue, then the newest uploaded file', () => {
  const file = (location, ok = true) => ({ adapter: 's3', ok, location });
  assert.equal(shareLink({ saves: [] }), null);
  assert.equal(shareLink({ saves: [{ adapter: 'download', ok: true, location: '/Users/x/Snap/a.png' }] }), null);
  assert.equal(shareLink({ saves: [file('https://s3/a'), file('https://s3/b'), file('https://s3/c', false)] }), 'https://s3/b');
  assert.equal(shareLink({ saves: [{ adapter: 'jira', ok: true, location: 'https://jira/A-1', issue: 'A-1' }, file('https://s3/b')] }), 'https://jira/A-1');
});
