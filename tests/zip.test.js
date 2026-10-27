import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, buildZip, uniqueName } from '../src/shared/zip.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test('uniqueName suffixes clashes case-insensitively', () => {
  const taken = new Set();
  assert.equal(uniqueName('a.png', taken), 'a.png');
  assert.equal(uniqueName('A.png', taken), 'A-2.png');
  assert.equal(uniqueName('a.png', taken), 'a-3.png');
  assert.equal(uniqueName('README', taken), 'README');
});

test('buildZip writes a valid stored archive', async () => {
  const zip = await buildZip([
    { name: 'hello.txt', data: 'hello', date: new Date(2026, 9, 23, 14, 15, 2) },
    { name: 'bytes.bin', data: new Blob([new Uint8Array([0, 1, 2, 255])]) },
    { name: 'empty.md', data: new Uint8Array() },
  ]);
  assert.equal(zip.type, 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3);

  let unzip = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { unzip = false; }
  if (!unzip) return;
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  writeFileSync(join(dir, 'a.zip'), bytes);
  execFileSync('unzip', ['-tq', join(dir, 'a.zip')]);
  execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')]);
  assert.equal(readFileSync(join(dir, 'out', 'hello.txt'), 'utf8'), 'hello');
  assert.deepEqual([...readFileSync(join(dir, 'out', 'bytes.bin'))], [0, 1, 2, 255]);
});
