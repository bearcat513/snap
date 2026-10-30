import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsExport, parseSettingsImport, DEFAULTS } from '../src/shared/settings.js';

const settings = { ...DEFAULTS, 'jira.apiToken': 'secret', 'github.token': 'secret', 'webhook.token': 'secret', 'jira.email': 'me@example.com', snHosts: ['mine.example.com', 'corp.example.com'], managedSnHosts: ['corp.example.com'], locked: ['recording.maxMinutes'] };

test('exports leave out credentials, personal details and policy values', () => {
  const out = settingsExport(settings, '1.2.3').settings;
  for (const k of ['jira.apiToken', 'github.token', 'webhook.token', 'jira.email', 'recording.maxMinutes']) assert.equal(k in out, false, k);
  assert.deepEqual(out.snHosts, ['mine.example.com']);
  assert.ok(Array.isArray(out.templates));
});

test('an export can be imported again', () => {
  const { patch, ignored } = parseSettingsImport(JSON.stringify(settingsExport(settings)));
  assert.deepEqual(ignored, []);
  assert.equal(patch['ui.theme'], 'system');
});

test('imports ignore unknown keys, wrong types, secrets and bad patterns', () => {
  const file = { format: 'snap-companion-settings', settings: { nope: 1, 'library.maxItems': 'many', 'github.token': 'x', 'gif.fps': 5, 'redaction.custom': ['ok', '('] } };
  const { patch, ignored } = parseSettingsImport(JSON.stringify(file));
  assert.deepEqual(patch, { 'gif.fps': 5, 'redaction.custom': ['ok'] });
  assert.deepEqual(ignored.sort(), ['github.token', 'library.maxItems', 'nope']);
});

test('imports reject anything that is not a settings file', () => {
  assert.throws(() => parseSettingsImport('{oops'), /not valid JSON/);
  assert.throws(() => parseSettingsImport('{"a":1}'), /not a Snap Companion settings file/);
});
