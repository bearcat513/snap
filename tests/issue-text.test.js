import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToJira, issueSummary, existingIssue, originPattern } from '../src/storage/issue-text.js';

test('sidecar Markdown converts to Jira wiki markup', () => {
  const md = '# Title\n\n- **Instance:** acme\n\n## Steps to reproduce\n\n1. Open [the record](https://acme/x)\n2. Save';
  assert.equal(markdownToJira(md), 'h1. Title\n\n* *Instance:* acme\n\nh2. Steps to reproduce\n\n# Open [the record|https://acme/x]\n# Save');
});

test('issue summary prefers the description and is capped', () => {
  assert.equal(issueSummary({ title: 'T', context: { description: '  Field   is editable ' } }), 'Field is editable');
  assert.equal(issueSummary({ title: 'Only a title' }), 'Only a title');
  assert.equal(issueSummary({ title: 'x'.repeat(300) }, 10), `${'x'.repeat(9)}…`);
});

test('retries reuse the issue a tracker created before', () => {
  const capture = { saves: [
    { adapter: 'jira', ok: true, name: 'a.issue', issue: 'APP-1', location: 'https://j/browse/APP-1' },
    { adapter: 'jira', ok: false, name: 'a.pdf' },
    { adapter: 'github', ok: false, name: 'a.issue' },
  ] };
  assert.deepEqual(existingIssue(capture, 'jira'), { id: 'APP-1', url: 'https://j/browse/APP-1' });
  assert.equal(existingIssue(capture, 'github'), null);
});

test('only https origins (or localhost) get host access', () => {
  assert.equal(originPattern('https://acme.atlassian.net/'), 'https://acme.atlassian.net/*');
  assert.equal(originPattern('http://localhost:8080/hook'), 'http://localhost:8080/*');
  assert.equal(originPattern('http://example.com'), null);
  assert.equal(originPattern(''), null);
});
