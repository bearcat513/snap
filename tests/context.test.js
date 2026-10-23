import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, normalizeCustomFields, DEFAULTS } from '../src/shared/settings.js';
import { matches, searchText } from '../src/editor/library.js';

test('templates fill empty fields, append notes, union tags', () => {
  const tpl = { description: 'Bug: ', notes: 'Expected:\nActual:', steps: ['Open the record'], tags: ['bug', 'uat'] };
  const out = applyTemplate({ description: '', notes: 'Seen twice', steps: [], tags: ['uat'] }, tpl);
  assert.equal(out.description, 'Bug: ');
  assert.equal(out.notes, 'Seen twice\n\nExpected:\nActual:');
  assert.deepEqual(out.steps, ['Open the record']);
  assert.deepEqual(out.tags, ['uat', 'bug']);
  const kept = applyTemplate({ description: 'Mine', steps: ['Mine'] }, tpl);
  assert.equal(kept.description, 'Mine');
  assert.deepEqual(kept.steps, ['Mine']);
});

test('default templates are well-formed', () => {
  for (const t of DEFAULTS.templates) assert.ok(t.id && t.name && Array.isArray(t.steps) && Array.isArray(t.tags));
});

test('custom fields get stable unique ids and sane types', () => {
  const f = normalizeCustomFields([
    { label: 'Environment', type: 'select', options: 'Dev, Test ,Prod', required: true },
    { label: 'Environment' },
    { label: 'Ticket #', type: 'bogus' },
    { type: 'text' },
  ]);
  assert.deepEqual(f.map((x) => x.id), ['environment', 'environment_', 'ticket']);
  assert.deepEqual(f[0].options, ['Dev', 'Test', 'Prod']);
  assert.equal(f[2].type, 'text');
  assert.equal(f[0].required, true);
});

const cap = (over) => ({
  kind: 'screenshot', title: 'INC0012345 (incident)', saves: [],
  context: { description: 'Field editable after resolve', notes: '', steps: ['Resolve the incident'], tags: ['bug'], custom: { env: 'Prod' } },
  servicenow: { label: 'INC0012345', table: 'incident', instance: 'acme.service-now.com' },
  source: { url: 'https://acme.service-now.com/incident.do' },
  ...over,
});

test('library search matches across fields, all words required', () => {
  const c = cap();
  assert.ok(searchText(c).includes('resolve the incident'));
  const f = { q: '', kind: 'all', unsaved: false, tag: '' };
  assert.ok(matches(c, { ...f, q: 'editable prod' }));
  assert.ok(matches(c, { ...f, q: 'INC0012345' }));
  assert.ok(!matches(c, { ...f, q: 'editable nope' }));
});

test('library filters: kind, tag, unsaved', () => {
  const f = { q: '', kind: 'all', unsaved: false, tag: '' };
  assert.ok(!matches(cap(), { ...f, kind: 'recording' }));
  assert.ok(matches(cap(), { ...f, tag: 'bug' }));
  assert.ok(!matches(cap(), { ...f, tag: 'uat' }));
  assert.ok(matches(cap(), { ...f, unsaved: true }));
  assert.ok(!matches(cap({ saves: [{ ok: true }] }), { ...f, unsaved: true }));
});
