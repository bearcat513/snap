// End-to-end test for Snap Lite: headless Chrome with no extension, the mock ServiceNow instance
// serving the built bundle as its snap_lite UI Script, and the real /snap-lite loader command.
//   npm run test:e2e:lite      (CHROME=/path/to/chrome to override)
// --auto-accept-this-tab-capture answers the share picker; CDP's userGesture stands in for the
// slash command's keypress.
import { launch, sleep, waitFor } from './cdp.mjs';
import { startServer } from './server.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execFileSync('node', [join(ROOT, 'scripts/build-lite.mjs')], { stdio: 'inherit' });
const scratch = mkdtempSync(join(tmpdir(), 'snap-lite-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'),
  '-days', '1', '-subj', '/CN=acme.service-now.com', '-addext', 'subjectAltName=DNS:acme.service-now.com'], { stdio: 'ignore' });
const PORT = 8444;
const srv = startServer({ port: PORT, snapCommandPath: join(ROOT, 'snutils/snap-lite-command.js'), certDir: scratch, liteBundlePath: join(ROOT, 'dist/snap-lite.js') });
const b = await launch({ scratch, extraArgs: [
  `--host-resolver-rules=MAP acme.service-now.com:443 127.0.0.1:${PORT}`, '--ignore-certificate-errors',
] });

const errors = [];
b.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};

const { targetId } = await b.send('Target.createTarget', { url: 'https://acme.service-now.com/incident.do?sys_id=x' });
const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true });
await b.send('Runtime.enable', {}, s);
await b.send('Page.enable', {}, s);
const evalIn = async (expression, userGesture = false) => {
  const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, s);
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
const inLite = (body) => evalIn(`(() => { const root = document.querySelector('[data-snap-lite]')?.shadowRoot; if (!root) return null; const $ = (id) => root.getElementById(id); ${body} })()`);
const setValue = (id, value) => inLite(`const e = $(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
async function mouse(x1, y1, x2, y2) {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 }, s);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 }, s);
  for (let i = 1; i <= 5; i++) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 5, y: y1 + ((y2 - y1) * i) / 5, button: 'left', buttons: 1 }, s);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }, s);
}
const alerts = () => evalIn('window.__events.filter((e) => e.type === "alert").map((e) => e.msg)');

try {
  await waitFor(() => evalIn('typeof window.runSnap === "function"'), { label: 'mock record page' });
  srv.state.liteConfig = {
    workNote: true,
    templates: [{ id: 'inc', name: 'Incident bug', tables: ['incident'], tags: ['bug'], placeholders: { description: 'What broke?' },
      fields: [{ label: 'Expected', type: 'textarea', required: true }, { label: 'Severity', type: 'select', options: ['Low', 'High'], default: 'High' }] }],
  };

  // ---- /snap-lite: screenshot of the tab → editor ----
  await evalIn('window.runSnap("")', true);
  const opened = await waitFor(() => inLite('return $("canvas")?.width ? { w: $("canvas").width, h: $("canvas").height } : null'), { label: 'Snap Lite editor', timeout: 15000 }).catch(() => null);
  check('loader fetches the UI Script and opens the editor with a tab frame', !!opened && opened.w > 600, JSON.stringify({ opened, alerts: await alerts() }));
  if (!opened) throw new Error('editor did not open');

  const ui = await inLite(`return {
    banner: !$('suggest-banner').hidden, text: $('suggest-text').textContent,
    template: $('btn-template').textContent, desc: $('ctx-description').placeholder,
    expected: !!$('cf-expected'), severity: $('cf-severity')?.value, tags: [...root.querySelectorAll('#tags .chip')].map((c) => c.firstChild.textContent),
    workNote: $('work-note').checked,
  }`);
  check('sensitive scan suggests redacting the caller email', ui.banner && /Found/.test(ui.text), JSON.stringify(ui));
  check('table template auto-applies with its own fields, defaults and placeholders',
    ui.template.startsWith('Incident bug') && ui.desc === 'What broke?' && ui.expected && ui.severity === 'High' && ui.tags.includes('bug'), JSON.stringify(ui));
  check('snap_lite.config turns on the work note', ui.workNote === true);

  await inLite('$("btn-suggest-all").click(); return true;');
  // SNAP_E2E_SHOTS=/some/dir saves the editor, as the extension's e2e run does.
  if (process.env.SNAP_E2E_SHOTS) {
    await sleep(200);
    const { data } = await b.send('Page.captureScreenshot', { format: 'png' }, s);
    writeFileSync(join(process.env.SNAP_E2E_SHOTS, 'snap-lite-editor.png'), Buffer.from(data, 'base64'));
  }
  check('Redact all hides the banner', await inLite('return $("suggest-banner").hidden'));

  // Required template field blocks attaching.
  await setValue('ctx-description', 'Field is editable after resolve');
  await inLite('$("btn-attach").click(); return true;');
  await sleep(300);
  const blocked = await inLite('return { status: $("status").textContent, invalid: $("cf-expected").classList.contains("invalid") }');
  check('a required template field blocks attaching', blocked.invalid && /Expected/.test(blocked.status) && srv.uploads.length === 0, JSON.stringify(blocked));

  // Draw a box, fill the field, attach.
  const box = await inLite('const r = $("canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };');
  await inLite('root.querySelector(\'[data-tool="rect"]\').click(); return true;');
  await mouse(box.x + 40, box.y + 40, box.x + 200, box.y + 120);
  check('drawing adds an undoable shape', await inLite('return !$("btn-undo").disabled'));
  await setValue('cf-expected', 'Read-only once resolved');
  await inLite('$("btn-attach").click(); return true;');
  await waitFor(() => srv.uploads.length >= 2 && srv.state.notes.length >= 1, { label: 'uploads + work note', timeout: 15000 }).catch(() => {});
  const [pdf, png] = [srv.uploads.find((u) => u.name.endsWith('.pdf')), srv.uploads.find((u) => u.name.endsWith('.png'))];
  check('attaches a PDF and a PNG to the record with the session token',
    pdf && png && [pdf, png].every((u) => u.table === 'incident' && u.sysId === srv.sysId && u.token === 'TOKEN123'), JSON.stringify(srv.uploads.map(({ text, ...u }) => u)));
  check('file names follow {table}_{label}_{timestamp}', /^incident_INC0012345_\d{8}-\d{6}\.pdf$/.test(pdf?.name || ''), pdf?.name);
  check('PDF has the description and template fields', pdf?.head.startsWith('%PDF') && /Field is editable after resolve/.test(pdf.text) && /EXPECTED/.test(pdf.text) && /Read-only once resolved/.test(pdf.text) && /SEVERITY/.test(pdf.text));
  check('PNG is a PNG', png?.head.startsWith('\x89PNG'));
  check('posts a work note naming the files', /attached 2 files/.test(srv.state.notes[0]?.note || ''), JSON.stringify(srv.state.notes));
  await waitFor(async () => !(await evalIn('!!document.querySelector("[data-snap-lite]")')), { label: 'editor closed', timeout: 5000 }).catch(() => {});
  check('editor closes after a full success', !(await evalIn('!!document.querySelector("[data-snap-lite]")')));

  // ---- /snap-lite region ----
  srv.state.liteConfig = null;
  await evalIn('window.runSnap("region")', true);
  await sleep(1500); // share + overlay
  await mouse(100, 100, 400, 300);
  const region = await waitFor(() => inLite('return $("canvas")?.width ? { w: $("canvas").width, h: $("canvas").height, tpl: $("btn-template").textContent } : null'), { label: 'region editor', timeout: 10000 }).catch(() => null);
  const ratio = region ? region.w / region.h : 0;
  check('region mode crops to the dragged rectangle', region && Math.abs(ratio - 1.5) < 0.05, JSON.stringify(region));
  check('without snap_lite.config, the built-in templates are offered and none auto-applies', region?.tpl === 'Template ▾', region?.tpl);
  await inLite('$("btn-cancel").click(); return true;');
  check('Cancel closes without attaching', !(await evalIn('!!document.querySelector("[data-snap-lite]")')) && srv.uploads.length === 2);

  check('no alerts', !(await alerts()).length, JSON.stringify(await alerts()));
  check('no page errors', !errors.length, errors.join('\n'));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  b.close();
  srv.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
