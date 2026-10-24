import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared/sensitive.js';

const S = globalThis.SnapSensitive;
const kinds = (text, opts) => S.findMatches(text, opts).map((m) => `${m.kind}:${text.slice(m.start, m.end)}`);

test('finds emails, phone numbers, IPs and card numbers', () => {
  assert.deepEqual(kinds('Contact jane.doe@acme.co.uk or +1 (555) 010-4477.'), ['email:jane.doe@acme.co.uk', 'phone:+1 (555) 010-4477']);
  assert.deepEqual(kinds('Server 10.20.30.40 is down'), ['ipv4:10.20.30.40']);
  assert.deepEqual(kinds('Card 4111 1111 1111 1111 on file'), ['card:4111 1111 1111 1111']);
});

test('ignores dates, ticket numbers, invalid cards and lower-case hex sys_ids', () => {
  assert.deepEqual(kinds('Opened 2026-10-24 10:30:00 as INC0012345'), []);
  assert.deepEqual(kinds('Card 4111 1111 1111 1112'), []);
  assert.deepEqual(kinds('sys_id 9d385017c611228701d22104cc95c371'), []);
  assert.deepEqual(kinds('Version 1.2.3'), []);
});

test('finds tokens and keys', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.deepEqual(kinds(`Bearer ${jwt}`).map((k) => k.split(':')[0]), ['token']);
  assert.deepEqual(kinds('key AKIAIOSFODNN7EXAMPLE here'), ['token:AKIAIOSFODNN7EXAMPLE']);
  assert.deepEqual(kinds('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['token:ghp_abcdefghijklmnopqrstuvwxyz0123456789']);
});

test('only the enabled patterns run, plus valid custom ones', () => {
  assert.deepEqual(kinds('jane@acme.com 10.0.0.1', { patterns: ['ipv4'] }), ['ipv4:10.0.0.1']);
  assert.deepEqual(kinds('Employee E123456 and EMP-99', { patterns: [], custom: ['E\\d{6}', '(unclosed'] }), ['custom:E123456']);
});

test('overlapping matches keep the longest', () => {
  assert.deepEqual(kinds('mail 5550104477@carrier.example.com'), ['email:5550104477@carrier.example.com']);
});

test('Luhn check', () => {
  assert.equal(S.luhn('4111111111111111'), true);
  assert.equal(S.luhn('4111111111111112'), false);
});
