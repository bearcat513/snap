import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared/protocol.js';

const P = globalThis.SnapProtocol;
const loc = { host: 'acme.service-now.com', origin: 'https://acme.service-now.com' };
const win = {};
const sysId = '9d385017c611228701d22104cc95c371';
const request = (over = {}) => ({
  ns: 'snap-companion', v: 1, type: 'snap:request', requestId: '6f1c2a9e-0d1b-4e7a-9a59-0a7a4c3f2b11',
  payload: {
    mode: 'screenshot', deliver: ['pdf'],
    context: { instance: loc.host, table: 'incident', sysId, label: 'INC0012345', recordUrl: `${loc.origin}/incident.do?sys_id=${sysId}`, user: 'jdoe' },
  },
  ...over,
});
const evt = (data, over = {}) => ({ source: win, origin: loc.origin, data, ...over });

test('accepts a well-formed request', () => {
  const r = P.validatePageMessage(evt(request()), win, loc);
  assert.equal(r.ok, true);
  assert.equal(r.msg.payload.context.label, 'INC0012345');
});

test('ignores messages from other frames or origins (forged postMessage)', () => {
  assert.equal(P.validatePageMessage(evt(request(), { source: {} }), win, loc), null);
  assert.equal(P.validatePageMessage(evt(request(), { origin: 'https://evil.example' }), win, loc), null);
});

test('ignores foreign namespaces, versions and extension→page types', () => {
  assert.equal(P.validatePageMessage(evt({ ...request(), ns: 'other' }), win, loc), null);
  assert.equal(P.validatePageMessage(evt({ ...request(), v: 2 }), win, loc), null);
  assert.equal(P.validatePageMessage(evt({ ...request(), type: 'snap:file' }), win, loc), null);
});

test('rejects context that does not match the page', () => {
  const bad = request();
  bad.payload.context.instance = 'other.service-now.com';
  assert.equal(P.validatePageMessage(evt(bad), win, loc).ok, false);
  const bad2 = request();
  bad2.payload.context.recordUrl = 'https://evil.example/incident.do';
  assert.equal(P.validatePageMessage(evt(bad2), win, loc).ok, false);
  const bad3 = request();
  bad3.payload.context.sysId = 'nope';
  assert.equal(P.validatePageMessage(evt(bad3), win, loc).ok, false);
});

test('rejects unknown modes and formats', () => {
  const bad = request();
  bad.payload.mode = 'silent-capture';
  assert.equal(P.validatePageMessage(evt(bad), win, loc).ok, false);
  const bad2 = request();
  bad2.payload.deliver = ['exe'];
  assert.equal(P.validatePageMessage(evt(bad2), win, loc).ok, false);
});

test('validates upload results', () => {
  const m = { ns: 'snap-companion', v: 1, type: 'snap:uploaded', requestId: 'abcdef12-3456', payload: { results: [{ name: 'a.pdf', ok: true, sysId }] } };
  assert.equal(P.validatePageMessage(evt(m), win, loc).ok, true);
  const bad = { ...m, payload: { results: [{ name: 'a.pdf', ok: 'yes' }] } };
  assert.equal(P.validatePageMessage(evt(bad), win, loc).ok, false);
});
