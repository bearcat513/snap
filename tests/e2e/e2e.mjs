// End-to-end tests (§18): headless Chrome + a mock ServiceNow instance served over TLS.
//   npm run test:e2e            (CHROME=/path/to/chrome to override; arg: all|bridge|fullpage|region|record)
// The test copy of the extension is granted <all_urls> so one-step /snap captures can run without a
// real keyboard shortcut (CDP can't trigger extension commands). Not covered here: the shortcut/popup
// gesture path and tab recording via tabCapture, both of which need a real user gesture.
import { launch, sleep, waitFor } from './cdp.mjs';
import { startServer } from './server.mjs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const only = process.argv[2] || 'all';
const scratch = mkdtempSync(join(tmpdir(), 'snap-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'),
  '-days', '1', '-subj', '/CN=acme.service-now.com', '-addext', 'subjectAltName=DNS:acme.service-now.com'], { stdio: 'ignore' });
const EXT = join(scratch, 'ext');
for (const p of ['manifest.json', 'managed_schema.json', 'icons', 'src', 'snutils']) cpSync(join(ROOT, p), join(EXT, p), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>');
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const PORT = 8443;
const srv = startServer({ port: PORT, snapCommandPath: join(ROOT, 'snutils/snap-command.js'), certDir: scratch });
const downloads = join(scratch, 'downloads');
mkdirSync(downloads, { recursive: true });
const b = await launch({ scratch, downloadDir: downloads, extraArgs: [
  `--host-resolver-rules=MAP acme.service-now.com:443 127.0.0.1:${PORT}`, '--ignore-certificate-errors',
  '--auto-select-tab-capture-source-by-title=INC0012345',
] });
const errors = [];
const sessions = new Map();
b.on((m) => {
  const tag = sessions.get(m.sessionId) || m.sessionId?.slice(0, 6);
  if (m.method === 'Runtime.exceptionThrown') errors.push(`[${tag}] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push(`[${tag} console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});
const evalIn = async (sessionId, expression) => {
  const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
async function attach(targetId, label) {
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  sessions.set(sessionId, label);
  await b.send('Runtime.enable', {}, sessionId);
  await b.send('Page.enable', {}, sessionId).catch(() => {});
  return sessionId;
}
const targets = async () => (await b.send('Target.getTargets')).targetInfos;
const findTarget = (pred, label) => waitFor(async () => (await targets()).find(pred), { label, timeout: 15000 });

async function click(sessionId, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  }
}
async function drag(sessionId, x1, y1, x2, y2) {
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 }, sessionId);
  for (let i = 1; i <= 5; i++) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 5, y: y1 + ((y2 - y1) * i) / 5, button: 'left', buttons: 1 }, sessionId);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }, sessionId);
}
const center = async (s, sel) => evalIn(s, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height, l: r.left, t: r.top }; })()`);

// SNAP_E2E_SHOTS=/some/dir saves screenshots of key screens for eyeballing.
const shot = async (sessionId, name) => {
  if (!process.env.SNAP_E2E_SHOTS) return;
  const { data } = await b.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(process.env.SNAP_E2E_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };

try {
  const { id } = await b.send('Extensions.loadUnpacked', { path: EXT });
  const sw = await findTarget((t) => t.type === 'service_worker' && t.url.includes(id), 'service worker');
  const swS = await attach(sw.targetId, 'sw');
  // A required custom field (§7.4) so the editor's validation and the PDF output can be checked.
  // The worker may still be starting when we attach; retry until chrome.* is available.
  await waitFor(() => evalIn(swS, `chrome.storage.sync.set({ customFields: [{ label: 'Environment', type: 'select', options: ['Dev', 'Prod'], required: true }] }).then(() => true)`).catch(() => false), { label: 'worker ready' });
  const newestDownload = (ext) => {
    const files = readdirSync(join(downloads, 'Snap')).filter((f) => f.endsWith(ext)).map((f) => ({ f, t: statSync(join(downloads, 'Snap', f)).mtimeMs }));
    files.sort((a, b) => b.t - a.t);
    return files[0] && join(downloads, 'Snap', files[0].f);
  };

  // ---------------- ServiceNow bridge: /snap screenshot → editor → attach PDF + download PNG
  const { targetId: snTarget } = await b.send('Target.createTarget', { url: `https://acme.service-now.com/incident.do?sys_id=${srv.sysId}` });
  const sn = await attach(snTarget, 'sn-page');
  await b.send('Target.activateTarget', { targetId: snTarget });
  await waitFor(() => evalIn(sn, 'document.documentElement && document.documentElement.dataset.snapCompanion').catch(() => false), { label: 'content script flag' });
  check('content script announces itself on ServiceNow host', true);

  if (only === 'all' || only === 'bridge') {
    await evalIn(sn, `runSnap('screenshot')`);
    await waitFor(() => evalIn(sn, `window.__events.some(e => e.type === 'snap:accepted' || e.type === 'snap:rejected' || e.type === 'alert')`), { label: 'accept' });
    const ev1 = await evalIn(sn, 'window.__events');
    check('bridge accepts snap:request', ev1.some((e) => e.type === 'snap:accepted'), JSON.stringify(ev1));

    const editorT = await findTarget((t) => t.type === 'page' && t.url.includes(`${id}/src/editor/editor.html?capture=`), 'editor tab');
    const ed = await attach(editorT.targetId, 'editor');
    await b.send('Target.activateTarget', { targetId: editorT.targetId });
    await waitFor(() => evalIn(ed, `!document.getElementById('canvas-wrap').hidden && document.getElementById('canvas').width > 0 && document.querySelectorAll('#destinations .dest').length === 3`), { label: 'editor ready' });
    const info = await evalIn(ed, `({ w: canvas.width, h: canvas.height, title: document.getElementById('title').value, url: document.getElementById('ctx-recordUrl').value,
      dests: [...document.querySelectorAll('#destinations .dest')].map(d => d.innerText.replace(/\\n/g,' ') + (d.classList.contains('on') ? ' [on]' : '')) })`);
    check('editor opened with the captured screenshot', info.w > 100 && info.h > 100, JSON.stringify(info));
    check('record URL pre-filled from the bridge', info.url === `https://acme.service-now.com/incident.do?sys_id=${srv.sysId}`);
    check('ServiceNow destination pre-selected', info.dests.some((d) => d.startsWith('Record INC0012345') && d.endsWith('[on]')), info.dests.join(' | '));

    // Annotate: redact (B) + arrow (A) + step (N), then undo/redo.
    const c = await center(ed, '#canvas');
    await evalIn(ed, `document.activeElement.blur()`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', text: 'b' }, ed);
    await drag(ed, c.l + 20, c.t + 20, c.l + 200, c.t + 80);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }, ed);
    await drag(ed, c.l + 300, c.t + 200, c.l + 220, c.t + 120);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', text: 'n' }, ed);
    await click(ed, c.l + 400, c.t + 150);
    await sleep(800);
    const shapes = await evalIn(ed, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const cap = await getCapture(new URLSearchParams(location.search).get('capture')); return cap.annotations.shapes.map(s => s.type); })()`);
    check('annotations persisted to the capture (blur, arrow, step)', JSON.stringify(shapes) === '["blur","arrow","step"]', JSON.stringify(shapes));

    // Verify pixels inside the blur region differ from the original (destructive redaction).
    const redacted = await evalIn(ed, `(async () => {
      const { getCapture, getBlob } = await import('/src/shared/db.js');
      const cap = await getCapture(new URLSearchParams(location.search).get('capture'));
      const blur = cap.annotations.shapes.find(s => s.type === 'blur').props;
      const orig = await createImageBitmap(await getBlob(cap.originalBlobId));
      const a = new OffscreenCanvas(orig.width, orig.height).getContext('2d'); a.drawImage(orig, 0, 0);
      const o = a.getImageData(blur.x, blur.y, blur.w, blur.h).data;
      const out = canvas.getContext('2d').getImageData(blur.x, blur.y, blur.w, blur.h).data;
      let diff = 0; for (let i = 0; i < o.length; i += 4) if (Math.abs(o[i]-out[i]) + Math.abs(o[i+1]-out[i+1]) + Math.abs(o[i+2]-out[i+2]) > 30) diff++;
      return { region: blur, changedPixels: diff, total: o.length / 4 };
    })()`);
    check('redaction changes underlying pixels', redacted.changedPixels > 0, JSON.stringify(redacted));

    // Save without description → blocked.
    await evalIn(ed, `document.getElementById('btn-save').click()`);
    await sleep(300);
    const invalid = await evalIn(ed, `document.getElementById('ctx-description').classList.contains('invalid')`);
    check('description required for ServiceNow', invalid);

    // Template, steps, tags (§7.4).
    await evalIn(ed, `document.getElementById('btn-template').click()`);
    await evalIn(ed, `document.querySelector('#template-menu button').click()`);
    await sleep(200);
    const afterTpl = await evalIn(ed, `({ notes: document.getElementById('ctx-notes').value, steps: [...document.querySelectorAll('#steps input')].map(i => i.value), tags: [...document.querySelectorAll('#tags .chip')].map(c => c.firstChild.textContent) })`);
    check('template pre-fills notes, steps and tags', afterTpl.notes.startsWith('Expected:') && afterTpl.steps[0] === 'Open the record' && afterTpl.tags.includes('bug'), JSON.stringify(afterTpl));
    await evalIn(ed, `(() => { const i = document.querySelectorAll('#steps input')[1]; i.value = 'Set State to Resolved'; i.dispatchEvent(new Event('input')); })()`);
    await evalIn(ed, `document.getElementById('tag-input').focus()`);
    await b.send('Input.insertText', { text: 'forms' }, ed);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, ed);
    await evalIn(ed, `(() => { const d = document.getElementById('ctx-description'); d.value = 'Expected: read-only after Resolve'; d.dispatchEvent(new Event('input')); })()`);
    await shot(ed, 'editor-context');
    const saveBtn = await center(ed, '#btn-save');
    await click(ed, saveBtn.x, saveBtn.y);
    await sleep(600);
    const cfInvalid = await evalIn(ed, `document.getElementById('cf-environment').classList.contains('invalid')`);
    check('required custom field blocks the ServiceNow save', cfInvalid && srv.uploads.length === 0);
    await evalIn(ed, `(() => { const s = document.getElementById('cf-environment'); s.value = 'Prod'; s.dispatchEvent(new Event('input')); })()`);
    await click(ed, saveBtn.x, saveBtn.y);
    await waitFor(() => srv.uploads.length > 0, { label: 'attachment upload', timeout: 20000 });
    await sleep(1500);
    console.log('uploads:', JSON.stringify(srv.uploads));
    const pdf = srv.uploads.find((u) => u.name.endsWith('.pdf'));
    check('PDF attached via page session token', pdf && pdf.head.startsWith('%PDF') && pdf.token === 'TOKEN123' && pdf.table === 'incident' && pdf.sysId === srv.sysId);
    check('file name follows pattern', pdf && /^incident_INC0012345_\d{8}-\d{6}\.pdf$/.test(pdf.name), pdf?.name);
    check('PDF includes steps, custom field and tags', pdf && ['STEPS TO REPRODUCE', '(Set State to Resolved) Tj', 'ENVIRONMENT', '(Prod) Tj', '(bug, forms) Tj'].every((x) => pdf.text.includes(x)));
    const ev2 = await evalIn(sn, 'window.__events');
    const fileEv = ev2.find((e) => e.type === 'snap:file' && e.origin === 'https://acme.service-now.com');
    check('page received Blobs from the extension on its own origin', fileEv && fileEv.origin === 'https://acme.service-now.com' && fileEv.files.every((f) => f.isBlob), JSON.stringify(fileEv));
    await waitFor(() => evalIn(ed, `[...document.querySelectorAll('#saves li')].length >= 2`), { label: 'saves list', timeout: 15000 }).catch(() => {});
    const saves = await evalIn(ed, `[...document.querySelectorAll('#saves li')].map(l => l.innerText.replace(/\\n/g, ' '))`);
    check('editor shows ServiceNow + Download results', saves.some((s) => s.startsWith('✓') && s.includes('ServiceNow')) && saves.some((s) => s.includes('Downloaded')), JSON.stringify(saves));
    await sleep(1000);
    const files = readdirSync(join(downloads, 'Snap')).filter((f) => !f.endsWith('.crdownload'));
    check('PNG downloaded to Snap/ subfolder', files.some((f) => f.endsWith('.png')), files.join(', '));
    const png = files.find((f) => f.endsWith('.png'));
    if (png) check('downloaded PNG is a PNG', readFileSync(join(downloads, 'Snap', png)).subarray(1, 4).toString() === 'PNG');

    // Second delivery for the same request must be refused (single-use requestId).
    const again = await evalIn(ed, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const cap = await getCapture(new URLSearchParams(location.search).get('capture')); return chrome.runtime.sendMessage({ type: 'bridge.deliver', jobId: cap.jobId, files: [] }); })()`);
    check('second delivery is refused', again && again.ok === false, JSON.stringify(again));

    // Replayed requestId from the page is rejected.
    const replay = await evalIn(sn, `(async () => {
      const id = 'replay-1234-5678';
      const send = () => window.postMessage({ ns: 'snap-companion', v: 1, type: 'snap:request', requestId: id, payload: { mode: 'record-tab', context: { instance: location.host, table: 'incident', sysId: '${srv.sysId}', label: 'X' } } }, location.origin);
      send(); await new Promise(r => setTimeout(r, 800)); send(); await new Promise(r => setTimeout(r, 800));
      return window.__events.filter(e => e.payload && (e.type === 'snap:accepted' || e.type === 'snap:rejected')).slice(-2).map(e => e.type + ':' + (e.payload.message || ''));
    })()`);
    check('replayed requestId rejected', replay.length === 2 && replay[0].startsWith('snap:accepted') && replay[1].includes('Duplicate'), JSON.stringify(replay));
    // Clean up the pending record-tab prompt.
    await evalIn(sn, `window.postMessage({ ns: 'snap-companion', v: 1, type: 'snap:cancelled', requestId: 'replay-1234-5678' }, location.origin)`);

    // Forged request from a cross-origin frame is ignored.
    const forged = await evalIn(sn, `(async () => {
      const n = window.__events.length;
      const f = document.createElement('iframe'); f.srcdoc = '<script>parent.postMessage({ ns: "snap-companion", v: 1, type: "snap:request", requestId: "forged-1234-5678", payload: { mode: "screenshot", context: {} } }, "*")<\\/script>';
      document.body.appendChild(f); await new Promise(r => setTimeout(r, 1000));
      return window.__events.slice(n).filter(e => e.requestId === 'forged-1234-5678' && e.type !== 'snap:request').map(e => e.type);
    })()`);
    check('forged postMessage from another frame ignored', forged.length === 0, JSON.stringify(forged));
  }

  // ---------------- Region + full page through the bridge (host-permission capture)
  if (only === 'all' || only === 'fullpage') {
    await b.send('Target.activateTarget', { targetId: snTarget });
    await evalIn(sn, `window.__events = []; runSnap('fullpage')`);
    const fp = await findTarget((t) => t.type === 'page' && t.url.includes('editor.html?capture=') && !sessions.has(t.targetId) && t.attached === false, 'full-page editor');
    const fpS = await attach(fp.targetId, 'editor-fullpage');
    await waitFor(() => evalIn(fpS, `!document.getElementById('canvas-wrap').hidden`), { label: 'full page canvas', timeout: 30000 });
    const dims = await evalIn(fpS, `({ w: canvas.width, h: canvas.height })`);
    const vh = await evalIn(sn, 'innerHeight * devicePixelRatio');
    check('full-page capture taller than viewport', dims.h > vh * 1.5, `${JSON.stringify(dims)} viewport ${vh}`);
  }

  if (only === 'all' || only === 'region') {
    await b.send('Target.activateTarget', { targetId: snTarget });
    await evalIn(sn, `window.__events = []; runSnap('region')`);
    await sleep(2000); // overlay injected
    await drag(sn, 100, 100, 500, 300);
    const rg = await findTarget((t) => t.type === 'page' && t.url.includes('editor.html?capture=') && !t.attached, 'region editor');
    const rgS = await attach(rg.targetId, 'editor-region');
    await waitFor(() => evalIn(rgS, `!document.getElementById('canvas-wrap').hidden`), { label: 'region canvas', timeout: 15000 });
    const dpr = await evalIn(sn, 'devicePixelRatio');
    const rdims = await evalIn(rgS, `({ w: canvas.width, h: canvas.height })`);
    check('region capture cropped to the dragged rectangle', Math.abs(rdims.w - 400 * dpr) <= 2 && Math.abs(rdims.h - 200 * dpr) <= 2, JSON.stringify(rdims));
    // Esc cancels and tells the page.
    await b.send('Target.activateTarget', { targetId: snTarget });
    await evalIn(sn, `window.__events = []; runSnap('region')`);
    await sleep(2000);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sn);
    await sleep(1000);
    const evs = await evalIn(sn, `window.__events.map(e => e.type)`);
    check('Esc cancels region select and notifies the page', evs.includes('snap:cancelled'), JSON.stringify(evs));
  }

  // ---------------- Window recording via recorder page (fake media, auto-selected tab)
  if (only === 'all' || only === 'record') {
    const { targetId: recT } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/recorder/recorder.html` });
    const rec = await attach(recT, 'recorder');
    await sleep(1000);
    await evalIn(rec, `document.getElementById('opt-countdown').checked = false`);
    const start = await center(rec, '#btn-start');
    await click(rec, start.x, start.y);
    await waitFor(() => evalIn(rec, `!document.getElementById('live').hidden || !document.getElementById('error').hidden`), { label: 'recording live', timeout: 15000 });
    const err = await evalIn(rec, `document.getElementById('error').hidden ? '' : document.getElementById('error').textContent`);
    check('window/screen recording started', !err, err);
    if (!err) {
      await sleep(4000);
      const state = await evalIn(rec, `chrome.storage.session.get('recording').then(r => r.recording)`);
      check('recording state tracked by worker', state && state.kind === 'window', JSON.stringify(state));
      await evalIn(rec, `chrome.runtime.sendMessage({ type: 'record:stop' })`);
      const vEd = await findTarget((t) => t.type === 'page' && t.url.includes('editor.html?capture=') && !t.attached, 'recording editor');
      const vS = await attach(vEd.targetId, 'editor-video');
      await b.send('Target.activateTarget', { targetId: vEd.targetId });
      await waitFor(() => evalIn(vS, `!document.getElementById('video-wrap').hidden && document.getElementById('time-label').textContent.length > 0`).catch(() => false), { label: 'video editor', timeout: 15000 });
      const dur = await evalIn(vS, `document.getElementById('video').duration`);
      check('recording finalized into a playable video', dur > 2 && Number.isFinite(dur), `duration ${dur}`);

      // Trim 0.5s → 3.0s, a redaction region from 1.0s, two keyframes.
      const seekTo = (s) => evalIn(vS, `new Promise(r => { const v = document.getElementById('video'); v.pause(); v.addEventListener('seeked', () => r(), { once: true }); v.currentTime = ${s}; })`);
      await seekTo(0.5);
      await evalIn(vS, `document.getElementById('btn-set-in').click()`);
      await seekTo(3.0);
      await evalIn(vS, `document.getElementById('btn-set-out').click()`);
      const trimLabel = await evalIn(vS, `document.getElementById('trim-label').textContent`);
      check('trim in/out set from the playhead', /00:00\.5 → 00:03\.0/.test(trimLabel), trimLabel);
      await seekTo(1.0);
      await evalIn(vS, `document.getElementById('btn-redact-video').click()`);
      const ov = await center(vS, '#video-overlay');
      await drag(vS, ov.l + ov.w * 0.05, ov.t + ov.h * 0.05, ov.l + ov.w * 0.6, ov.t + ov.h * 0.5);
      await evalIn(vS, `document.getElementById('btn-redact-video').click()`);
      await seekTo(1.2);
      await evalIn(vS, `document.getElementById('btn-add-key').click()`);
      await seekTo(2.5);
      await evalIn(vS, `document.getElementById('btn-add-key').click()`);
      await sleep(1200);

      // Keyboard transport: '.' steps one frame, Home jumps to the trim start.
      await seekTo(1.0);
      await evalIn(vS, `document.activeElement.blur()`);
      const now = () => evalIn(vS, `document.getElementById('video').currentTime`);
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '.', text: '.' }, vS);
      await sleep(300);
      const stepped = await now();
      check('"." steps one frame forward', stepped > 1.02 && stepped < 1.05, String(stepped));
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }, vS);
      await sleep(300);
      check('Home jumps to the trim start', Math.abs((await now()) - 0.5) < 0.01, String(await now()));

      await seekTo(1.5);
      await sleep(300);
      await shot(vS, 'video-editor');
      const saved = await evalIn(vS, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const c = await getCapture(new URLSearchParams(location.search).get('capture')); return { trim: c.trim, regions: (c.videoRedactions || []).map(r => [r.startMs, r.endMs, r.w > 0]), keys: (c.keyframes || []).map(k => k.timeMs) }; })()`);
      check('video edits persisted (trim, region, keyframes)', saved.trim?.startMs === 500 && saved.trim?.endMs === 3000 && saved.regions.length === 1 && saved.regions[0][0] === 1000 && saved.keys.length === 2, JSON.stringify(saved));

      // Export the video: re-rendered with trim + redaction.
      const exportAndWait = async (fmt, timeout) => {
        await evalIn(vS, `document.getElementById('save-status').textContent = ''; document.querySelector('[data-export="${fmt}"]').click()`);
        await waitFor(() => evalIn(vS, `/^Saved \\d|failed/.test(document.getElementById('save-status').textContent)`), { label: `${fmt} export`, timeout });
        await sleep(800);
      };
      await exportAndWait('video', 60000);
      const status = await evalIn(vS, `document.getElementById('save-status').textContent`);
      const rendered = await evalIn(vS, `(async () => {
        const { getCapture, getBlob } = await import('/src/shared/db.js');
        const { loadVideo, seek } = await import('/src/editor/video-tools.js');
        const c = await getCapture(new URLSearchParams(location.search).get('capture'));
        if (!c.rendered) return { error: 'no rendered blob' };
        const out = await loadVideo(await getBlob(c.rendered.blobId));
        const orig = await loadVideo(await getBlob(c.originalBlobId));
        const r = c.videoRedactions[0];
        const frame = async (v, t) => { await seek(v.video, t); const cv = new OffscreenCanvas(v.video.videoWidth, v.video.videoHeight); const x = cv.getContext('2d'); x.drawImage(v.video, 0, 0); return x; };
        const a = await frame(orig, 2.0), b2 = await frame(out, 1.5); // same moment: original 2.0s = rendered 1.5s
        // Detail = edge energy (sum of neighbour differences). Pixelation destroys it inside the region.
        const detail = (ctx, box) => { const d = ctx.getImageData(box.x, box.y, box.w, box.h).data; let e = 0; for (let y = 0; y < box.h; y++) for (let x = 1; x < box.w; x++) { const i = (y * box.w + x) * 4; e += Math.abs(d[i] - d[i - 4]); } return e; };
        const W = orig.video.videoWidth, H = orig.video.videoHeight;
        const outBox = { x: Math.round(W * 0.05), y: Math.round(H * 0.55), w: Math.round(W * 0.55), h: Math.round(H * 0.4) };
        const inside = detail(b2, r) / Math.max(1, detail(a, r));          // ≪ 1 when redacted
        const outside = detail(b2, outBox) / Math.max(1, detail(a, outBox)); // ≈ 1 elsewhere
        const res = { duration: out.video.duration, type: (await getBlob(c.rendered.blobId)).type, inside, outside };
        out.dispose(); orig.dispose();
        return res;
      })()`);
      check('rendered video is trimmed', rendered.duration > 2.0 && rendered.duration < 3.1, `${status} ${JSON.stringify(rendered)}`);
      check('rendered video redacts the region (and only it)', rendered.inside < 0.35 && rendered.outside > 0.6, JSON.stringify(rendered));
      const vfile = newestDownload('.mp4') || newestDownload('.webm');
      check('rendered video downloaded', !!vfile, vfile);

      // PDF with both keyframes, sidecar with trim info.
      await exportAndWait('pdf', 30000);
      const pdfText = readFileSync(newestDownload('.pdf')).toString('latin1');
      const images = (pdfText.match(/\/Subtype \/Image/g) || []).length;
      check('PDF report embeds both keyframes', images === 2 && pdfText.includes('(Keyframe at 00:00) Tj') === false && /Keyframe at 00:0[0-9]/.test(pdfText), `images=${images}`);
      await exportAndWait('sidecar', 15000);
      const md = readFileSync(newestDownload('.md'), 'utf8');
      check('sidecar records trim, redactions and keyframes', md.includes('**Trimmed:** 00:00.5–00:03.0') && md.includes('**Redacted regions:** 1') && md.includes('## Keyframes'), md.split('\n').filter((l) => /Trimmed|Redacted|Keyframes/.test(l)).join(' | '));
    }
  }

  // ---------------- Library: search, tag filter, quick re-export; delayed capture
  if (only === 'all' || only === 'library') {
    const { targetId: libT } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/editor/editor.html?view=library` });
    const lib = await attach(libT, 'library');
    await b.send('Target.activateTarget', { targetId: libT });
    await waitFor(() => evalIn(lib, `document.querySelectorAll('.lib-grid .card').length > 0`).catch(() => false), { label: 'library cards' });
    await sleep(500);
    await shot(lib, 'library');
    const visible = () => evalIn(lib, `[...document.querySelectorAll('.lib-grid .card')].filter(c => !c.hidden).length`);
    const total = await visible();
    await evalIn(lib, `(() => { const s = document.getElementById('lib-search'); s.value = 'read-only resolve'; s.dispatchEvent(new Event('input')); })()`);
    await sleep(400);
    const found = await visible();
    check('library search narrows results', found >= 1 && found < total, `${found} of ${total}`);
    await evalIn(lib, `(() => { const s = document.getElementById('lib-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    await evalIn(lib, `[...document.querySelectorAll('.tag-filter .chip')].find(c => c.textContent === '#forms').click()`);
    const tagged = await visible();
    check('library tag filter', tagged === 1, `${tagged}`);
    await evalIn(lib, `[...document.querySelectorAll('.tag-filter .chip')].find(c => c.textContent === '#forms').click()`);
    const before = readdirSync(join(downloads, 'Snap')).length;
    await evalIn(lib, `(() => { const card = [...document.querySelectorAll('.lib-grid .card')].find(c => !c.hidden && c.querySelector('.card-menu button').textContent === 'Download PNG'); card.querySelector('.card-more').click(); card.querySelector('.card-menu button').click(); })()`);
    await waitFor(() => readdirSync(join(downloads, 'Snap')).filter((f) => !f.endsWith('.crdownload')).length > before, { label: 'quick export', timeout: 15000 }).catch(() => {});
    check('library quick re-export downloads a PNG', readdirSync(join(downloads, 'Snap')).length > before);

    // Delayed capture of the ServiceNow tab, as triggered from the popup.
    await b.send('Target.activateTarget', { targetId: snTarget });
    const tabId = await evalIn(lib, `chrome.tabs.query({ url: 'https://acme.service-now.com/*' }).then(t => t[0].id)`);
    const editorsBefore = (await targets()).filter((t) => t.url.includes('editor.html?capture=')).length;
    const t0 = Date.now();
    await evalIn(lib, `chrome.runtime.sendMessage({ type: 'capture:start', mode: 'visible', tabId: ${tabId}, delaySeconds: 2 })`);
    const badge = await (async () => { await sleep(600); return evalIn(swS, `chrome.action.getBadgeText({})`); })();
    await waitFor(async () => (await targets()).filter((t) => t.url.includes('editor.html?capture=')).length > editorsBefore, { label: 'delayed capture', timeout: 10000 });
    const elapsed = Date.now() - t0;
    check('delayed capture waits and counts down on the badge', elapsed >= 2000 && /^[12]$/.test(badge), `${elapsed}ms, badge "${badge}"`);
  }
} catch (err) {
  console.log('FATAL', err.message);
  results.push({ name: 'fatal', ok: false });
} finally {
  console.log(errors.length ? `\nRUNTIME ERRORS:\n${errors.join('\n')}` : '\nno runtime errors');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  const exited = new Promise((r) => b.chrome.once('exit', r));
  b.close();
  srv.close();
  await Promise.race([exited, sleep(5000)]);
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp dir; OS will clean it */ }
  process.exit(failed ? 1 : 0);
}
