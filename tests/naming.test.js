import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileName, sanitize, captureBaseName, extensionForMime } from '../src/shared/naming.js';
import { DEFAULTS } from '../src/shared/settings.js';

const date = new Date(2026, 9, 23, 14, 15, 2);

test('default pattern matches the design doc example', () => {
  const name = buildFileName(DEFAULTS.fileNamePattern, { table: 'incident', label: 'INC0012345' }, date, 'pdf');
  assert.equal(name, 'incident_INC0012345_20261023-141502.pdf');
});

test('unsafe characters become underscores', () => {
  assert.equal(sanitize('a b/c\\d:e*?"<>|'), 'a_b_c_d_e');
  assert.equal(buildFileName('{title}', { title: '../../etc/passwd' }, date, 'png'), 'etc_passwd.png');
});

test('missing tokens collapse cleanly', () => {
  assert.equal(buildFileName('{table}_{label}_{yyyyMMdd}', { table: '', label: 'X' }, date, 'png'), 'X_20261023.png');
  assert.equal(buildFileName('{nope}', {}, date, 'png'), 'capture.png');
});

test('fallback pattern outside ServiceNow uses host', () => {
  const capture = { kind: 'screenshot', createdAt: date.toISOString(), source: { url: 'https://example.com/a?b' }, title: 't' };
  assert.equal(captureBaseName(capture, DEFAULTS), 'example.com_20261023-141502');
});

test('ServiceNow captures use the record pattern', () => {
  const capture = {
    kind: 'recording', createdAt: date.toISOString(), source: { url: '' }, title: 't',
    servicenow: { table: 'incident', label: 'INC0012345', instance: 'acme.service-now.com' },
  };
  assert.equal(captureBaseName(capture, DEFAULTS), 'incident_INC0012345_20261023-141502');
});

test('mime → extension', () => {
  assert.equal(extensionForMime('video/mp4;codecs=avc1,mp4a.40.2'), 'mp4');
  assert.equal(extensionForMime('video/webm;codecs=vp9,opus'), 'webm');
});
