// Mock ServiceNow instance: a form page running the real /snap command, plus the attachment API.
import https from 'node:https';
import { readFileSync } from 'node:fs';

export function startServer({ port, snapCommandPath, certDir }) {
  const uploads = [];
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
  const server = https.createServer({ key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) }, (req, res) => {
    if (req.url.startsWith('/incident.do')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
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
  return { uploads, sysId, close: () => server.close() };
}
