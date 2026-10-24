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
for (const p of ['manifest.json', 'managed_schema.json', '_locales', 'icons', 'src', 'snutils']) cpSync(join(ROOT, p), join(EXT, p), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>');
manifest.permissions.push('debugger'); // viewport + console/network capture (normally an optional grant)
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
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type) && m.params.args[0]?.value !== 'boom-e2e') errors.push(`[${tag} console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
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

    // Smart redaction: the page's "jane.doe@example.com" is suggested, then accepted.
    const suggest = await evalIn(ed, `({ shown: !document.getElementById('suggest-banner').hidden, text: document.getElementById('suggest-text').textContent })`);
    check('sensitive text found at capture time is suggested', suggest.shown && /1 email address/.test(suggest.text), JSON.stringify(suggest));
    await evalIn(ed, `document.getElementById('btn-suggest-all').click()`);
    await sleep(600);
    const accepted = await evalIn(ed, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const cap = await getCapture(new URLSearchParams(location.search).get('capture'));
      const b = cap.annotations.shapes.at(-1); return { types: cap.annotations.shapes.map(s => s.type), box: b.props, w: canvas.width, h: canvas.height, reviewed: !!cap.suggestionsReviewed, banner: !document.getElementById('suggest-banner').hidden }; })()`);
    check('accepting suggestions adds redactions inside the image', accepted.types.length === 4 && accepted.types[3] === 'blur' && accepted.box.w > 40 && accepted.box.x + accepted.box.w <= accepted.w && accepted.reviewed && !accepted.banner, JSON.stringify(accepted));

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

      // GIF of the trimmed, redacted range; Chrome must be able to decode it.
      await exportAndWait('gif', 90000);
      const gifFile = newestDownload('.gif');
      const gif = gifFile ? readFileSync(gifFile) : Buffer.alloc(0);
      const decoded = gif.length ? await evalIn(vS, `(async () => { const img = new Image(); img.src = 'data:image/gif;base64,${gif.toString('base64')}'; await img.decode(); return [img.naturalWidth, img.naturalHeight]; })()`) : null;
      check('GIF export decodes, at most 800 px wide', gif.subarray(0, 6).toString() === 'GIF89a' && decoded && decoded[0] > 100 && decoded[0] <= 800, `${gifFile} ${gif.length} bytes ${JSON.stringify(decoded)}`);

      // Guide from recorded clicks (tab recordings store them; injected here since tabCapture needs a real gesture).
      await evalIn(vS, `(async () => { const { updateCapture } = await import('/src/shared/db.js');
        await updateCapture(new URLSearchParams(location.search).get('capture'), (c) => { c.clicks = [
          { t: 800, fx: 0.2, fy: 0.3, label: 'Resolve', role: 'button' }, { t: 900, fx: 0.2, fy: 0.3, label: 'Resolve', role: 'button' },
          { t: 2000, fx: 0.6, fy: 0.5, label: 'Close notes', role: 'field' }, { t: 3500, fx: 0.5, fy: 0.5, label: 'After trim', role: 'link' }]; }); })()`);
      await evalIn(vS, 'location.reload()');
      await sleep(1500);
      await waitFor(() => evalIn(vS, `!document.getElementById('btn-guide').hidden`).catch(() => false), { label: 'guide button', timeout: 15000 });
      await evalIn(vS, `document.getElementById('btn-guide').click()`);
      await sleep(400);
      await evalIn(vS, `document.querySelector('#confirm-dialog [value="ok"]').click()`); // replace the two keyframes
      await sleep(1200);
      const guide = await evalIn(vS, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const c = await getCapture(new URLSearchParams(location.search).get('capture'));
        return { steps: c.context.steps, keys: c.keyframes.map(k => [k.timeMs, k.step && k.step.n]) }; })()`);
      check('guide: one step per click inside the trim, double click merged', JSON.stringify(guide.steps) === JSON.stringify(['Click “Resolve”', 'Click the “Close notes” field']) && JSON.stringify(guide.keys) === '[[650,1],[1850,2]]', JSON.stringify(guide));
      await exportAndWait('pdf', 30000);
      const guidePdf = readFileSync(newestDownload('.pdf')).toString('latin1');
      check('guide PDF captions each step', guidePdf.includes('Step 1: Click') && guidePdf.includes('Step 2: Click the'), guidePdf.match(/Step \d[^)]*/g)?.join(' | '));
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

  // ---------------- §5/§6 additions: element, session (+limits, work note), trackers + retry, compare,
  // viewports, console/network capture, side panel, storage meter, diagnostics, i18n.
  if (only === 'all' || only === 'extras') {
    const msg = await evalIn(swS, `chrome.i18n.getMessage('popup_delay_tip', ['3'])`);
    check('localized message with a substitution', msg === 'Captures 3s after you click', msg);
    const tabId = await evalIn(swS, `chrome.tabs.query({ url: 'https://acme.service-now.com/*' }).then(t => t[0].id)`);
    // Editor tabs that exist before an action, so the next wait only matches the tab it opens.
    const editorIds = async () => new Set((await targets()).filter((t) => t.url.includes('editor.html?capture=')).map((t) => t.targetId));
    const newEditor = (label, before) => findTarget((t) => t.type === 'page' && t.url.includes('editor.html?capture=') && !before.has(t.targetId), label);
    const capField = (s, expr) => evalIn(s, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const c = await getCapture(new URLSearchParams(location.search).get('capture')); return ${expr}; })()`);

    // Element capture through /snap: hover the <h1>, click it.
    await b.send('Target.activateTarget', { targetId: snTarget });
    let before = await editorIds();
    await evalIn(sn, `window.scrollTo(0, 0); window.__events = []; runSnap('element')`);
    await sleep(2000);
    const h1 = await center(sn, 'h1');
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h1.x, y: h1.y }, sn);
    await sleep(200);
    await click(sn, h1.x, h1.y);
    const elT = await newEditor('element editor', before);
    const elS = await attach(elT.targetId, 'editor-element');
    await waitFor(() => evalIn(elS, `!document.getElementById('canvas-wrap').hidden`), { label: 'element canvas', timeout: 15000 });
    const edpr = await evalIn(sn, 'devicePixelRatio');
    const edims = await evalIn(elS, `({ w: canvas.width, h: canvas.height })`);
    check('element capture is the element plus padding', Math.abs(edims.h - (h1.h + 16) * edpr) <= 2 && edims.w <= (h1.w + 16) * edpr + 2 && edims.w > h1.w * edpr * 0.9, `${JSON.stringify(edims)} h1 ${h1.w}×${h1.h}`);

    // Session through /snap, with attachment limits read from the instance and a work note.
    srv.state.limits = { max: '1', ext: 'pdf,png' };
    await evalIn(swS, `chrome.storage.sync.set({ 'servicenow.workNote': true }).then(() => true)`);
    const { targetId: spT } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/sidepanel/sidepanel.html` });
    const sp = await attach(spT, 'sidepanel');
    await b.send('Target.activateTarget', { targetId: snTarget });
    await evalIn(sn, `window.__events = []; runSnap('session')`);
    await waitFor(() => evalIn(swS, `chrome.storage.session.get('session').then(r => !!r.session)`), { label: 'session started' });
    for (let i = 0; i < 2; i++) {
      await evalIn(sp, `chrome.runtime.sendMessage({ type: 'capture:start', mode: 'visible', tabId: ${tabId}, delaySeconds: 0 })`);
      await waitFor(() => evalIn(swS, `chrome.storage.session.get('session').then(r => r.session.captureIds.length === ${i + 1})`), { label: `session capture ${i + 1}`, timeout: 10000 });
    }
    const sbadge = await evalIn(swS, `chrome.action.getBadgeText({})`);
    check('captures join the open session (badge counts them)', sbadge === 'S2', sbadge);
    before = await editorIds();
    await evalIn(sp, `chrome.runtime.sendMessage({ type: 'session:finish', tabId: ${tabId} })`);
    const ssT = await newEditor('session editor', before);
    const ss = await attach(ssT.targetId, 'editor-session');
    await b.send('Target.activateTarget', { targetId: ssT.targetId });
    await waitFor(() => evalIn(ss, `document.querySelectorAll('#session-list li').length === 2 && document.querySelectorAll('#destinations .dest').length >= 3`).catch(() => false), { label: 'session editor', timeout: 15000 });
    const sdest = await evalIn(ss, `[...document.querySelectorAll('#destinations .dest')].map(d => d.innerText.replace(/\\n/g, ' ') + (d.classList.contains('on') ? ' [on]' : ''))`);
    check('session report: ServiceNow on, instance limits shown', sdest.some((d) => d.includes('INC0012345') && d.includes('up to 1 MB per file; types: pdf, png') && d.endsWith('[on]')), sdest.join(' | '));
    await evalIn(ss, `(() => { const d = document.getElementById('ctx-description'); d.value = 'Two-step repro'; d.dispatchEvent(new Event('input')); const f = document.getElementById('cf-environment'); f.value = 'Dev'; f.dispatchEvent(new Event('input')); })()`);
    const uploadsBefore = srv.uploads.length;
    await evalIn(ss, `document.getElementById('btn-save').click()`);
    await sleep(800);
    await evalIn(ss, `document.querySelector('#confirm-dialog[open] [value="ok"]')?.click()`); // unreviewed suggested redactions
    await waitFor(() => srv.uploads.length > uploadsBefore, { label: 'session upload', timeout: 30000 });
    await waitFor(() => srv.state.notes.length > 0, { label: 'work note', timeout: 10000 }).catch(() => {});
    const spdf = srv.uploads.at(-1);
    check('session attaches one PDF with a section per capture', spdf.name.endsWith('.pdf') && (spdf.text.match(/\/Subtype \/Image/g) || []).length === 2 && spdf.text.includes('(1. ') && spdf.text.includes('(2. '), spdf.name);
    check('work note posted after attaching', srv.state.notes.length === 1 && /Snap Companion attached 1 file/.test(srv.state.notes[0].note) && srv.state.notes[0].token === 'TOKEN123', JSON.stringify(srv.state.notes));
    srv.state.limits = null;

    // Issue trackers + webhook (all served by the mock), webhook failing once, then retried from the library.
    srv.state.failHook = 1;
    await evalIn(swS, `Promise.all([
      chrome.storage.sync.set({ 'webhook.url': 'https://acme.service-now.com/hook', 'jira.baseUrl': 'https://acme.service-now.com/jira', 'jira.projectKey': 'APP', 'jira.email': 'qa@example.com',
        'github.repo': 'acme/app', 'github.apiUrl': 'https://acme.service-now.com/gh' }),
      chrome.storage.local.set({ 'webhook.token': 'hook-secret', 'jira.apiToken': 'jira-secret', 'github.token': 'gh-secret' }),
    ]).then(() => true)`);
    await evalIn(elS, 'location.reload()');
    await sleep(1500);
    await waitFor(() => evalIn(elS, `document.querySelectorAll('#destinations .dest').length === 6`).catch(() => false), { label: 'tracker destinations', timeout: 15000 });
    await evalIn(elS, `(() => { for (const id of ['jira', 'github', 'webhook']) { const cb = document.getElementById('dest-' + id); if (!cb.checked) cb.click(); }
      for (const id of ['servicenow', 'download']) { const cb = document.getElementById('dest-' + id); if (cb.checked) cb.click(); }
      const d = document.getElementById('ctx-description'); d.value = 'Header overlaps the form'; d.dispatchEvent(new Event('input'));
      const f = document.getElementById('cf-environment'); f.value = 'Prod'; f.dispatchEvent(new Event('input')); })()`);
    await evalIn(elS, `document.getElementById('save-status').textContent = ''; document.getElementById('btn-save').click()`);
    await sleep(600);
    await evalIn(elS, `document.querySelector('#confirm-dialog[open] [value="ok"]')?.click()`);
    await waitFor(() => evalIn(elS, `/Saved \\d|failed/.test(document.getElementById('save-status').textContent)`), { label: 'tracker save', timeout: 30000 })
      .catch(async (e) => { console.log('DEBUG', await evalIn(elS, `JSON.stringify({ status: document.getElementById('save-status').textContent, toast: document.getElementById('toast').textContent, dlg: !!document.querySelector('dialog[open]'), dests: [...document.querySelectorAll('#destinations .dest')].map(d => d.innerText) })`)); throw e; });
    const jira = srv.state.jira;
    check('Jira: issue created with the description, the PNG attached', jira.issues.length === 1 && jira.issues[0].fields.summary === 'Header overlaps the form' && jira.issues[0].fields.project.key === 'APP'
      && jira.issues[0].auth.startsWith('Basic ') && jira.attachments.length === 1 && jira.attachments[0].file.endsWith('.png') && jira.attachments.every((a) => a.xsrf === 'no-check' && a.key === 'APP-1'), JSON.stringify({ issues: jira.issues.map((i) => i.fields.summary), att: jira.attachments }));
    check('Jira description converted to wiki markup', /^h1\. /.test(jira.issues[0]?.fields.description || '') && jira.issues[0].fields.description.includes('*Instance:*'), (jira.issues[0]?.fields.description || '').slice(0, 80));
    const gh = srv.state.gh.issues;
    check('GitHub: issue created (no attachments branch) with a bearer token', gh.length === 1 && gh[0].title === 'Header overlaps the form' && gh[0].auth === 'Bearer gh-secret' && gh[0].body.includes('## Description') && gh[0].body.includes('APP-1'), JSON.stringify(gh.map((i) => i.title)));
    const elSaves = await capField(elS, `c.saves.map(s => s.adapter + ':' + s.ok)`);
    check('first webhook attempt fails and is recorded', elSaves.includes('webhook:false') && srv.state.hooks.length === 0, JSON.stringify(elSaves));
    const diag = await evalIn(swS, `chrome.storage.local.get('diagnostics.errors').then(r => (r['diagnostics.errors'] || []).map(e => e.source + ': ' + e.message))`);
    check('diagnostics recorded the failure (no tokens)', diag.some((d) => d.startsWith('save:webhook') && d.includes('HTTP 500')) && !JSON.stringify(diag).includes('secret'), JSON.stringify(diag.slice(-3)));

    const { targetId: lib2T } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/editor/editor.html?view=library` });
    const lib2 = await attach(lib2T, 'library-2');
    await b.send('Target.activateTarget', { targetId: lib2T });
    await waitFor(() => evalIn(lib2, `document.querySelectorAll('.lib-grid .card').length > 0`).catch(() => false), { label: 'library cards' });
    const meter = await evalIn(lib2, `({ meter: !!document.querySelector('.storage .meter'), text: document.querySelector('.storage p')?.textContent || '' })`);
    check('library shows a storage meter', meter.meter && /of 1\.0 GB library limit/.test(meter.text), meter.text);
    await evalIn(lib2, `document.getElementById('lib-failed').click()`);
    const failedCards = await evalIn(lib2, `[...document.querySelectorAll('.lib-grid .card')].filter(c => !c.hidden).length`);
    check('"Failed saves" filter shows the failing capture', failedCards === 1, String(failedCards));
    await evalIn(lib2, `(() => { const card = [...document.querySelectorAll('.lib-grid .card')].find(c => !c.hidden); card.querySelector('.card-more').click();
      [...card.querySelectorAll('.card-menu button')].find(b => b.textContent.startsWith('Retry failed saves')).click(); })()`);
    await waitFor(() => srv.state.hooks.length > 0, { label: 'webhook retry', timeout: 20000 }).catch(() => {});
    const hook = srv.state.hooks[0];
    check('retry from the library re-sends only the failed webhook save', !!hook && hook.auth === 'Bearer hook-secret' && hook.metadata && hook.files.length === 1 && hook.files[0].endsWith('.png')
      && srv.state.jira.issues.length === 1 && srv.state.gh.issues.length === 1, JSON.stringify(hook));

    // Before/after compare of two screenshots.
    await evalIn(lib2, `location.reload()`);
    await waitFor(() => evalIn(lib2, `document.querySelectorAll('.lib-grid .card').length > 0`).catch(() => false), { label: 'library reload' });
    await evalIn(lib2, `document.getElementById('btn-compare').click()`);
    await sleep(500);
    await evalIn(lib2, `(() => { const cards = [...document.querySelectorAll('.lib-grid .card:not(.dim)')].slice(0, 2); cards.forEach(c => c.querySelector('.card-open').click()); })()`);
    await sleep(300);
    await evalIn(lib2, `(async () => { const c = [...document.querySelectorAll('.lib-grid .card:not(.dim)')]; if (document.querySelectorAll('.card.picked').length < 2) c[1].querySelector('.card-open').click(); })()`);
    await sleep(300);
    await evalIn(lib2, `[...document.querySelectorAll('.compare-bar button')].find(b => b.textContent === 'Side by side').click()`);
    await waitFor(() => evalIn(lib2, `location.search.includes('capture=')`).catch(() => false), { label: 'compare editor', timeout: 15000 });
    await waitFor(() => evalIn(lib2, `!document.getElementById('canvas-wrap').hidden && canvas.width > 0`).catch(() => false), { label: 'compare canvas', timeout: 15000 });
    const cmp = await evalIn(lib2, `({ title: document.getElementById('title').value, w: canvas.width, h: canvas.height })`);
    check('before/after comparison becomes a new screenshot', cmp.title.startsWith('Before / after') && cmp.w > cmp.h, JSON.stringify(cmp));

    // Viewports (DevTools emulation) as a session of three widths.
    await b.send('Target.activateTarget', { targetId: snTarget });
    before = await editorIds();
    await evalIn(sp, `chrome.runtime.sendMessage({ type: 'capture:viewports', tabId: ${tabId} })`);
    const vpT = await newEditor('viewports editor', before);
    const vp = await attach(vpT.targetId, 'editor-viewports');
    await waitFor(() => evalIn(vp, `document.querySelectorAll('#session-list li').length === 3`).catch(() => false), { label: 'viewports session', timeout: 30000 });
    const widths = await evalIn(vp, `(async () => { const { getCapture } = await import('/src/shared/db.js'); const s = await getCapture(new URLSearchParams(location.search).get('capture'));
      const out = []; for (const id of s.members) { const m = await getCapture(id); out.push(m.source.width); } return out; })()`);
    check('viewport capture: one screenshot per configured width', JSON.stringify(widths) === '[375,768,1280]', JSON.stringify(widths));

    // Console + network capture for the ServiceNow tab.
    const dtStart = await evalIn(sp, `chrome.runtime.sendMessage({ type: 'devtools:start', tabId: ${tabId} })`);
    await b.send('Target.activateTarget', { targetId: snTarget });
    await evalIn(sn, `console.error('boom-e2e', 42); fetch('/missing-e2e?token=abc123').catch(() => {}); true`);
    await sleep(1500);
    before = await editorIds();
    await evalIn(sp, `chrome.runtime.sendMessage({ type: 'capture:start', mode: 'visible', tabId: ${tabId}, delaySeconds: 0 })`);
    const dtT = await newEditor('devtools editor', before);
    const dtS = await attach(dtT.targetId, 'editor-devtools');
    await waitFor(() => evalIn(dtS, `!document.getElementById('canvas-wrap').hidden`).catch(() => false), { label: 'devtools capture', timeout: 15000 });
    const dt = await capField(dtS, `c.devtools`);
    const req = dt?.network?.find((r) => r.url.includes('/missing-e2e'));
    check('console errors and failed requests are attached to the capture', dt && dtStart?.ok && dt.console.some((e) => e.text.includes('boom-e2e 42')) && req?.status === 404, JSON.stringify(dt)?.slice(0, 300));
    check('request URLs keep parameter names only', req && req.url.endsWith('/missing-e2e?token=…') && !JSON.stringify(dt).includes('abc123'), req?.url);
    await evalIn(sp, `chrome.runtime.sendMessage({ type: 'devtools:stop', tabId: ${tabId} })`);

    // Side panel lists recent captures, ready to drag.
    await evalIn(sp, 'location.reload()');
    await waitFor(() => evalIn(sp, `document.querySelectorAll('#list .item').length > 0`).catch(() => false), { label: 'side panel items', timeout: 10000 });
    const items = await evalIn(sp, `[...document.querySelectorAll('#list .item')].map(i => i.getAttribute('draggable'))`);
    check('side panel lists recent captures as draggable items', items.length >= 3 && items.every((d) => d === 'true'), JSON.stringify(items.length));

    // Options: new tabs, diagnostics, file-name tokens. Popup: localized, no errors.
    const { targetId: optT } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/options/options.html#about` });
    const opt = await attach(optT, 'options');
    await waitFor(() => evalIn(opt, `document.querySelectorAll('#diag-list li').length > 0`).catch(() => false), { label: 'options diagnostics', timeout: 10000 });
    const o = await evalIn(opt, `({ tabs: [...document.querySelectorAll('#tabs [role=tab]')].map(t => t.textContent), diag: document.getElementById('diag-list').textContent,
      jira: document.querySelector('[data-key="jira.baseUrl"]').value, token: document.querySelector('[data-key="jira.apiToken"]').type })`);
    check('options: issue trackers and diagnostics tabs, settings filled in', o.tabs.includes('Issue trackers') && o.tabs.includes('About & diagnostics') && o.diag.includes('save:webhook')
      && o.jira === 'https://acme.service-now.com/jira' && o.token === 'password', JSON.stringify(o).slice(0, 300));
    await b.send('Target.activateTarget', { targetId: optT });
    await evalIn(opt, `(() => { location.hash = 'saving'; const f = document.getElementById('pattern-fallback'); f.focus(); f.value = 'shot_'; f.dispatchEvent(new Event('input')); f.setSelectionRange(5, 5);
      document.querySelector('[data-token="{title}"]').click(); })()`);
    await sleep(600);
    const pv = await evalIn(opt, `({ value: document.getElementById('pattern-fallback').value, preview: document.getElementById('fallback-preview').textContent })`);
    check('file-name tokens insert at the cursor and preview', pv.value === 'shot_{title}' && pv.preview === 'shot_Example.png', JSON.stringify(pv));
    await evalIn(opt, `chrome.storage.sync.remove(['fallbackFileNamePattern', 'fileNamePattern']).then(() => true)`); // back to the defaults
    const { targetId: popT } = await b.send('Target.createTarget', { url: `chrome-extension://${id}/src/popup/popup.html` });
    const pop = await attach(popT, 'popup');
    await waitFor(() => evalIn(pop, `document.querySelectorAll('#recent li').length > 0`).catch(() => false), { label: 'popup recent', timeout: 10000 });
    const p = await evalIn(pop, `({ lang: document.documentElement.lang, h2: document.querySelector('[data-i18n="popup_screenshot"]').textContent, element: !!document.querySelector('[data-capture="element"]'), session: document.getElementById('btn-session-start').hidden })`);
    check('popup renders localized, with element and session controls', p.lang && p.h2 === 'Screenshot' && p.element && p.session === false, JSON.stringify(p));
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
