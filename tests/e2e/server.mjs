// Mock ServiceNow instance: a form page running the real /snap command, plus the attachment API.
import https from 'node:https';
import { readFileSync } from 'node:fs';

export function startServer({ port, snapCommandPath, certDir }) {
  const uploads = [];
  // Extra mocks: attachment limits (sys_properties), work notes, a webhook, Jira and GitHub.
  const state = { limits: null, notes: [], hooks: [], failHook: 0, jira: { issues: [], attachments: [] }, gh: { issues: [] } };
  const sysId = '9d385017c611228701d22104cc95c371';
  const cmd = readFileSync(snapCommandPath, 'utf8').replace(/\$table/g, 'incident').replace(/\$sysid/g, sysId);
  const page = `<!doctype html><html><head><title>INC0012345 | Incident</title></head>
<body style="font:14px sans-serif;margin:0">
<header style="position:sticky;top:0;background:#293e40;color:#fff;padding:12px">ServiceNow mock header</header>
<form style="padding:16px"><h1>INC0012345</h1><label>Short description <input value="Field is editable after resolve" size="60"></label>
<p>Caller email: jane.doe@example.com</p>${'<p>Lorem ipsum dolor sit amet, filler paragraph for scrolling.</p>'.repeat(60)}</form>
<script>
  window.g_ck = 'TOKEN123';
  window.g_form = { getValue: (f) => f === 'number' ? 'INC0012345' : '' };
  window.g_user = { userName: 'jdoe' };
  window.__events = [];
  window.addEventListener('message', (e) => { const m = e.data; if (m && m.ns === 'snap-companion') window.__events.push({ type: m.type, requestId: m.requestId, origin: e.origin, files: m.payload && m.payload.files ? m.payload.files.map(f => ({ name: f.name, size: f.blob.size, isBlob: f.blob instanceof Blob })) : undefined, payload: m.type === 'snap:file' ? undefined : m.payload }); });
  window.alert = (msg) => window.__events.push({ type: 'alert', msg });
  window.runSnap = (mode) => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(cmd)}.split('String.raw\`$0\`').join('String.raw\`' + mode + '\`'); document.head.appendChild(s); };
</script></body></html>`;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const server = https.createServer({ key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) }, async (req, res) => {
    if (req.url.startsWith('/incident.do')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
    if (req.url.startsWith('/api/now/table/sys_properties')) {
      const l = state.limits;
      json(res, 200, { result: l ? [{ name: 'com.glide.attachment.max_size', value: l.max }, { name: 'glide.attachment.extensions', value: l.ext }] : [] });
      return;
    }
    if (req.url.startsWith('/api/now/table/incident/') && req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      state.notes.push({ token: req.headers['x-usertoken'], note: body.work_notes });
      json(res, 200, { result: { sys_id: sysId } });
      return;
    }
    if (req.url === '/hook' && req.method === 'POST') {
      const body = (await readBody(req)).toString('latin1');
      if (state.failHook > 0) { state.failHook--; json(res, 500, { message: 'hook down' }); return; }
      state.hooks.push({ auth: req.headers.authorization, type: req.headers['content-type'], metadata: body.includes('name="metadata"'), files: [...body.matchAll(/name="file"; filename="([^"]+)"/g)].map((m) => m[1]) });
      json(res, 200, { url: 'https://acme.service-now.com/hook/received/1' });
      return;
    }
    if (req.url === '/jira/rest/api/2/issue' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const key = `APP-${state.jira.issues.length + 1}`;
      state.jira.issues.push({ key, auth: req.headers.authorization, fields: body.fields });
      json(res, 201, { key, self: `https://acme.service-now.com/jira/rest/api/2/issue/${key}` });
      return;
    }
    const att = /^\/jira\/rest\/api\/2\/issue\/([A-Z]+-\d+)\/attachments$/.exec(req.url);
    if (att && req.method === 'POST') {
      const body = (await readBody(req)).toString('latin1');
      state.jira.attachments.push({ key: att[1], xsrf: req.headers['x-atlassian-token'], file: /filename="([^"]+)"/.exec(body)?.[1] });
      json(res, 200, [{ id: '1' }]);
      return;
    }
    if (req.url === '/gh/repos/acme/app/issues' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const number = state.gh.issues.length + 1;
      state.gh.issues.push({ number, auth: req.headers.authorization, ...body });
      json(res, 201, { number, html_url: `https://github.example/acme/app/issues/${number}` });
      return;
    }
    if (req.url.startsWith('/api/now/attachment/file') && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'https://x');
        uploads.push({ name: u.searchParams.get('file_name'), table: u.searchParams.get('table_name'), sysId: u.searchParams.get('table_sys_id'),
          token: req.headers['x-usertoken'], type: req.headers['content-type'], size: body.length, head: body.subarray(0, 8).toString('latin1'),
          text: u.searchParams.get('file_name').endsWith('.pdf') ? body.toString('latin1') : undefined });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { sys_id: 'a'.repeat(32) } }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port);
  return { uploads, sysId, state, close: () => server.close() };
}
