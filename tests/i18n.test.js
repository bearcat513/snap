import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const messages = JSON.parse(readFileSync(join(ROOT, '_locales/en/messages.json'), 'utf8'));

function files(dir, ext) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

test('every message has text and a valid key', () => {
  for (const [key, m] of Object.entries(messages)) {
    assert.match(key, /^[a-z0-9_]+$/, key);
    assert.ok(typeof m.message === 'string' && m.message.length, key);
  }
});

test('every key used in HTML, scripts and the manifest exists', () => {
  const used = new Set();
  for (const f of files(join(ROOT, 'src'), '.html')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  for (const f of files(join(ROOT, 'src'), '.js')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:t|getMessage)\(\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of readFileSync(f, 'utf8').matchAll(/menu\('[a-z-]+', '([a-z0-9_]+)'\)/g)) used.add(m[1]);
  }
  for (const m of readFileSync(join(ROOT, 'manifest.json'), 'utf8').matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !messages[k]);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 50, `found ${used.size} keys`);
});

test('ternary message keys in scripts exist too', () => {
  // t(cond ? 'a' : 'b') — pick up every quoted message-looking key inside t(...).
  for (const f of files(join(ROOT, 'src'), '.js')) {
    for (const call of readFileSync(f, 'utf8').matchAll(/\bt\(([^;]*?)\)/g)) {
      for (const k of call[1].matchAll(/'((?:popup|common|recorder|sidepanel|menu|cmd)_[a-z0-9_]+)'/g)) assert.ok(messages[k[1]], `${k[1]} in ${f}`);
    }
  }
});
