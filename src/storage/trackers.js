// Issue-tracker destinations (§6): a generic webhook, Jira and GitHub Issues. Each runs in the
// editor page with the extension's host access to the configured origin (asked for on Save), so no
// CORS rules are needed on the tracker. Tokens live in chrome.storage.local, never in sync.
//
// The virtual "issue" format means "the issue itself"; other formats are files attached to it.

import { getBlob } from '../shared/db.js';
import { destinationAllowed } from '../shared/settings.js';
import { bytesToBase64 } from '../shared/util.js';
import { markdownToJira, issueSummary, existingIssue, originPattern, httpError } from './issue-text.js';

const fail = (adapter, name, error) => ({ adapter, ok: false, name, error });

async function blobsFor(files) {
  const out = [];
  for (const f of files) {
    const blob = await getBlob(f.blobId);
    if (!blob) throw new Error(`File data missing for ${f.name}`);
    out.push({ ...f, blob });
  }
  return out;
}

const issueName = (ctx) => `${ctx.factory.base}.issue`;

// ---------------------------------------------------------------- webhook

export const webhookAdapter = {
  id: 'webhook',
  label: 'Webhook',
  permissionOrigin: (s) => originPattern(s['webhook.url']),

  async isAvailable({ settings: s }) {
    if (!destinationAllowed('webhook', s)) return { available: false, configured: false, reason: 'Disabled by your organization.' };
    if (!s['webhook.url']) return { available: false, configured: false, reason: 'Not configured (Settings → Issue trackers).' };
    if (!originPattern(s['webhook.url'])) return { available: false, reason: 'The webhook URL must be https://.' };
    return { available: true };
  },

  /** One multipart POST: a "metadata" JSON part plus each file as "file". */
  async saveAll(files, ctx) {
    const s = ctx.settings;
    try {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ ...ctx.factory.json(ctx.links || []), files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.size })) })], { type: 'application/json' }), 'metadata.json');
      for (const f of await blobsFor(files)) form.append('file', f.blob, f.name);
      const res = await fetch(s['webhook.url'], {
        method: 'POST',
        credentials: 'omit',
        headers: s['webhook.token'] ? { Authorization: `Bearer ${s['webhook.token']}` } : {},
        body: form,
      });
      if (!res.ok) {
        const error = await httpError(res, 'Webhook');
        return files.map((f) => fail('webhook', f.name, error));
      }
      const reply = await res.json().catch(() => ({}));
      const location = typeof reply.url === 'string' && /^https?:\/\//.test(reply.url) ? reply.url : new URL(s['webhook.url']).host;
      return files.map((f) => ({ adapter: 'webhook', ok: true, name: f.name, location, link: reply.url, linkLabel: 'Webhook' }));
    } catch (err) {
      return files.map((f) => fail('webhook', f.name, err.message));
    }
  },
};

// ---------------------------------------------------------------- Jira

function jiraAuth(s) {
  // Jira Cloud: email + API token (Basic). Server / Data Center: a personal access token (Bearer).
  return s['jira.email'] ? `Basic ${btoa(`${s['jira.email']}:${s['jira.apiToken']}`)}` : `Bearer ${s['jira.apiToken']}`;
}

const jiraBase = (s) => String(s['jira.baseUrl'] || '').replace(/\/+$/, '');

export const jiraAdapter = {
  id: 'jira',
  label: 'Jira',
  permissionOrigin: (s) => originPattern(s['jira.baseUrl']),

  async isAvailable({ settings: s }) {
    if (!destinationAllowed('jira', s)) return { available: false, configured: false, reason: 'Disabled by your organization.' };
    if (!s['jira.baseUrl'] || !s['jira.projectKey']) return { available: false, configured: false, reason: 'Not configured (Settings → Issue trackers).' };
    if (!originPattern(s['jira.baseUrl'])) return { available: false, reason: 'The Jira URL must be https://.' };
    if (!s['jira.apiToken']) return { available: false, reason: 'Add a Jira API token in Settings → Issue trackers.' };
    return { available: true };
  },

  async saveAll(files, ctx) {
    const s = ctx.settings;
    const base = jiraBase(s);
    const headers = { Authorization: jiraAuth(s), Accept: 'application/json' };
    const all = [issueName(ctx), ...files.map((f) => f.name)];
    try {
      // Retries attach to the issue made the first time.
      let issue = existingIssue(ctx.capture, 'jira');
      const results = [];
      if (!issue) {
        const description = markdownToJira(await ctx.factory.issueMarkdown(ctx.links || []));
        const res = await fetch(`${base}/rest/api/2/issue`, {
          method: 'POST',
          credentials: 'omit',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { project: { key: s['jira.projectKey'] }, issuetype: { name: s['jira.issueType'] || 'Bug' }, summary: issueSummary(ctx.capture), description } }),
        });
        if (!res.ok) { const error = await httpError(res, 'Creating the Jira issue'); return all.map((n) => fail('jira', n, error)); }
        const { key } = await res.json();
        issue = { id: key, url: `${base}/browse/${key}` };
        results.push({ adapter: 'jira', ok: true, name: issueName(ctx), location: issue.url, issue: key, link: issue.url, linkLabel: key });
      }
      for (const f of await blobsFor(files)) {
        const form = new FormData();
        form.append('file', f.blob, f.name);
        const res = await fetch(`${base}/rest/api/2/issue/${encodeURIComponent(issue.id)}/attachments`, {
          method: 'POST', credentials: 'omit', headers: { ...headers, 'X-Atlassian-Token': 'no-check' }, body: form,
        });
        results.push(res.ok
          ? { adapter: 'jira', ok: true, name: f.name, location: issue.url, issue: issue.id }
          : fail('jira', f.name, await httpError(res, `Attaching ${f.name}`)));
      }
      return results;
    } catch (err) {
      return all.map((n) => fail('jira', n, err.message));
    }
  },
};

// ---------------------------------------------------------------- GitHub Issues

const ghBase = (s) => String(s['github.apiUrl'] || 'https://api.github.com').replace(/\/+$/, '');
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const githubAdapter = {
  id: 'github',
  label: 'GitHub',
  permissionOrigin: (s) => originPattern(ghBase(s)),
  /** Issues can't hold attachments through the API, so files need a branch to be committed to. */
  canAttach: (s) => !!s['github.attachmentsBranch'],

  async isAvailable({ settings: s }) {
    if (!destinationAllowed('github', s)) return { available: false, configured: false, reason: 'Disabled by your organization.' };
    if (!s['github.repo']) return { available: false, configured: false, reason: 'Not configured (Settings → Issue trackers).' };
    if (!REPO.test(s['github.repo'])) return { available: false, reason: 'The repository must look like owner/name.' };
    if (!originPattern(ghBase(s))) return { available: false, reason: 'The GitHub API URL must be https://.' };
    if (!s['github.token']) return { available: false, reason: 'Add a GitHub token in Settings → Issue trackers.' };
    return { available: true };
  },

  async saveAll(files, ctx) {
    const s = ctx.settings;
    const api = `${ghBase(s)}/repos/${s['github.repo']}`;
    const headers = { Authorization: `Bearer ${s['github.token']}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    const results = [];
    const links = [...(ctx.links || [])];
    try {
      // Files first (committed to the attachments branch), so the issue can link and embed them.
      const dir = `snap/${ctx.factory.base}`;
      for (const f of await blobsFor(files)) {
        const content = bytesToBase64(new Uint8Array(await f.blob.arrayBuffer()));
        const res = await fetch(`${api}/contents/${dir}/${encodeURIComponent(f.name)}`, {
          method: 'PUT', credentials: 'omit', headers,
          body: JSON.stringify({ message: `Snap Companion: ${f.name}`, content, branch: s['github.attachmentsBranch'] }),
        });
        if (!res.ok) { results.push(fail('github', f.name, await httpError(res, `Committing ${f.name}`))); continue; }
        const { content: meta } = await res.json();
        const url = meta?.html_url || '';
        results.push({ adapter: 'github', ok: true, name: f.name, location: url });
        if (url) links.push({ label: f.name, url, image: /^image\//.test(f.mimeType) });
      }
      const prior = existingIssue(ctx.capture, 'github');
      const md = await ctx.factory.issueMarkdown(links.map(({ label, url }) => ({ label, url })));
      const images = links.filter((l) => l.image).map((l) => `![${l.label}](${l.url}?raw=true)`);
      const body = [md, ...images].join('\n');
      const res = prior
        ? await fetch(`${api}/issues/${prior.id}/comments`, { method: 'POST', credentials: 'omit', headers, body: JSON.stringify({ body }) })
        : await fetch(`${api}/issues`, { method: 'POST', credentials: 'omit', headers, body: JSON.stringify({ title: issueSummary(ctx.capture, 256), body }) });
      if (!res.ok) {
        results.unshift(fail('github', issueName(ctx), await httpError(res, prior ? 'Commenting on the GitHub issue' : 'Creating the GitHub issue')));
        return results;
      }
      const issue = await res.json();
      const number = prior ? prior.id : issue.number;
      const url = prior ? issue.html_url || prior.url : issue.html_url;
      results.unshift({ adapter: 'github', ok: true, name: issueName(ctx), location: url, issue: number, link: url, linkLabel: `#${number}` });
      return results;
    } catch (err) {
      return [fail('github', issueName(ctx), err.message), ...files.filter((f) => !results.some((r) => r.name === f.name)).map((f) => fail('github', f.name, err.message)), ...results];
    }
  },
};
