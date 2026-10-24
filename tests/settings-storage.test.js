import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSettings, setSettings, migrateSettings, syncItemBytes, templateForTable, normalizeTemplates, normalizeViewports, DEFAULTS,
} from '../src/shared/settings.js';

// In-memory chrome.storage with sync's per-item quota (QUOTA_BYTES_PER_ITEM = 8192).
function area({ itemLimit = Infinity } = {}) {
  const data = {};
  const pick = (keys) => {
    if (keys === null || keys === undefined) return structuredClone(data);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
  };
  return {
    data,
    async get(keys) { return pick(keys); },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (syncItemBytes(k, v) > itemLimit) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      }
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}

let storage;
beforeEach(() => {
  storage = { sync: area({ itemLimit: 8192 }), local: area(), managed: area() };
  globalThis.chrome = { storage };
});

const bigTemplates = (n) => Array.from({ length: n }, (_, i) => ({
  id: `t${i}`, name: `Template ${i}`, description: 'Something went wrong on the form',
  notes: 'Expected:\n\nActual:\n\nSeverity:\n'.repeat(4), steps: ['Open the record', 'Change the state', 'Save'], tags: ['bug', 'forms'],
}));

test('50 templates save (they live in local storage, not sync)', async () => {
  await setSettings({ templates: bigTemplates(50) });
  assert.ok(syncItemBytes('templates', bigTemplates(50)) > 8192, 'fixture is larger than one sync item');
  assert.equal((await getSettings()).templates.length, 50);
  assert.equal(storage.sync.data.templates, undefined);
  assert.equal(storage.local.data.templates.length, 50);
});

test('credentials never go to sync', async () => {
  await setSettings({ 'github.token': 'ghp_secret', 'github.repo': 'acme/app' });
  assert.equal(storage.local.data['github.token'], 'ghp_secret');
  assert.equal(storage.sync.data['github.token'], undefined);
  assert.equal(storage.sync.data['github.repo'], 'acme/app');
});

test('an oversized sync value is rejected with a clear message', async () => {
  const palette = Array.from({ length: 2000 }, () => '#123456');
  await assert.rejects(setSettings({ 'editor.palette': palette }), /too large to sync/);
});

test('migration moves old sync copies to local, keeping a newer local value', async () => {
  storage.sync.data.customFields = [{ label: 'Env' }];
  storage.sync.data.templates = [{ name: 'Old' }];
  storage.local.data.templates = [{ name: 'New' }];
  await migrateSettings();
  assert.deepEqual(storage.local.data.customFields, [{ label: 'Env' }]);
  assert.deepEqual(storage.local.data.templates, [{ name: 'New' }]);
  assert.equal(storage.sync.data.customFields, undefined);
  assert.equal(storage.sync.data.templates, undefined);
});

test('unmigrated sync values are still read', async () => {
  storage.sync.data.customFields = [{ label: 'Environment', type: 'text' }];
  assert.equal((await getSettings()).customFields[0].label, 'Environment');
});

test('Cognito mode is gone: any stored or managed value reads as presign', async () => {
  storage.sync.data['s3.mode'] = 'cognito';
  assert.equal((await getSettings())['s3.mode'], 'presign');
});

test('templates keep their auto-apply tables, lower-cased', () => {
  const [t] = normalizeTemplates([{ name: 'Bug', tables: 'Incident, problem' }]);
  assert.deepEqual(t.tables, ['incident', 'problem']);
  assert.equal(templateForTable([t], 'PROBLEM').name, 'Bug');
  assert.equal(templateForTable([t], 'change_request'), null);
  assert.equal(templateForTable([t], ''), null);
});

test('viewport widths are clamped, sorted and de-duplicated', () => {
  assert.deepEqual(normalizeViewports('1280, 375, 375, 99999, abc'), [375, 1280]);
  assert.deepEqual(normalizeViewports([]), DEFAULTS['capture.viewports']);
});
