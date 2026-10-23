import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, wrapText, toWinAnsi } from '../src/editor/export/pdf.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// Smallest valid-ish JPEG header bytes are enough: the writer embeds them verbatim.
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function checkXref(bytes) {
  const s = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const count = Number(/xref\n0 (\d+)\n/.exec(s.slice(startxref))[1]);
  const entries = s.slice(startxref).split('\n').slice(3, 3 + count - 1);
  entries.forEach((line, i) => {
    const off = Number(line.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset`);
  });
  return s;
}

test('builds a structurally valid PDF with image and link', () => {
  const bytes = buildPdf({
    blocks: [
      { type: 'title', text: 'INC0012345 (incident)' },
      { type: 'meta', text: 'acme.service-now.com · incident · Chrome 130' },
      { type: 'field', label: 'Description', text: 'Field should be read-only after Resolve (it isn’t)' },
      { type: 'link', label: 'Record', url: 'https://acme.service-now.com/incident.do?sys_id=abc' },
      { type: 'image', jpeg: fakeJpeg, width: 1600, height: 900 },
    ],
    title: 'Test',
  });
  const s = checkXref(bytes);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.match(s, /\/Subtype \/Link/);
  assert.match(s, /\/Filter \/DCTDecode/);
  assert.match(s, /\/Count 1/);
});

test('paginates long content', () => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of notes`).join('\n');
  const bytes = buildPdf({ blocks: [{ type: 'field', label: 'Notes', text: long }, { type: 'image', jpeg: fakeJpeg, width: 800, height: 3000 }] });
  const s = checkXref(bytes);
  const count = Number(/\/Count (\d+)/.exec(s)[1]);
  assert.ok(count >= 5, `expected several pages, got ${count}`);
});

test('wraps and maps characters to WinAnsi', () => {
  assert.equal(toWinAnsi('a’b—c日'), 'a\x92b\x97c?');
  const lines = wrapText('word '.repeat(100), 10, 200);
  assert.ok(lines.length > 5);
  assert.ok(wrapText('x'.repeat(500), 10, 100).length > 1, 'breaks long words');
});

test('numbered list block renders each item', () => {
  const s = Buffer.from(buildPdf({ blocks: [{ type: 'list', label: 'Steps to reproduce', items: ['Open the record', '', 'Click Resolve'] }] })).toString('latin1');
  assert.match(s, /STEPS TO REPRODUCE/);
  assert.match(s, /\(1\.\) Tj/);
  assert.match(s, /\(2\.\) Tj/);
  assert.doesNotMatch(s, /\(3\.\) Tj/, 'blank items are skipped');
  assert.match(s, /\(Click Resolve\) Tj/);
});
