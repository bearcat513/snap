import { listCaptures, getBlob } from '../shared/db.js';
import { isCapturableUrl, formatDuration } from '../shared/util.js';
import { getSettings, setSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const urls = [];

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const capturable = tab && (!tab.url || isCapturableUrl(tab.url));

let delay = 0;
function renderDelay() {
  document.querySelectorAll('[data-delay]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.delay) === delay)));
  document.querySelectorAll('[data-capture]').forEach((b) => { b.title = delay ? `Captures ${delay}s after you click` : ''; });
}
document.querySelectorAll('[data-delay]').forEach((b) => b.addEventListener('click', async () => {
  delay = Number(b.dataset.delay);
  renderDelay();
  await setSettings({ 'capture.delaySeconds': delay });
}));

async function init() {
  delay = (await getSettings())['capture.delaySeconds'] || 0;
  renderDelay();
  const cmds = await chrome.commands.getAll();
  document.querySelectorAll('kbd[data-cmd]').forEach((k) => {
    k.textContent = cmds.find((c) => c.name === k.dataset.cmd)?.shortcut || '';
  });

  if (!capturable) {
    $('restricted').hidden = false;
    document.querySelectorAll('[data-capture], #btn-rec-tab').forEach((b) => { b.disabled = true; });
  }

  const state = await send({ type: 'popup:state', tabId: tab?.id });
  if (state?.lastError) {
    $('error').textContent = state.lastError;
    $('error').hidden = false;
  }
  if (state?.quotaBlocked) {
    $('quota').hidden = false;
    $('btn-rec-tab').disabled = true;
    $('btn-rec-window').disabled = true;
  }
  if (state?.pending) {
    const p = state.pending;
    $('pending').hidden = false;
    $('pending-text').textContent = `${p.servicenow?.label || 'Record'}: ${p.mode === 'record-tab' ? 'start the tab recording' : 'take the screenshot'}`;
  }
  renderRecording(state?.recording);
  await renderRecent();
}

let timer = null;
function renderRecording(rec) {
  clearInterval(timer);
  $('recording').hidden = !rec;
  $('actions').hidden = !!rec;
  if (!rec) return;
  $('recording').classList.toggle('paused', rec.paused);
  $('rec-label').textContent = rec.paused ? 'Paused' : rec.kind === 'tab' ? 'Recording tab' : 'Recording window';
  $('btn-pause').hidden = rec.paused;
  $('btn-resume').hidden = !rec.paused;
  const tick = () => {
    const now = rec.paused ? rec.pausedAt : Date.now();
    $('rec-time').textContent = formatDuration(now - rec.startedAt - (rec.pausedTotal || 0));
  };
  tick();
  if (!rec.paused) timer = setInterval(tick, 500);
}

async function renderRecent() {
  const list = $('recent');
  const captures = await listCaptures(5);
  $('recent-empty').hidden = captures.length > 0;
  for (const c of captures) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const thumb = await getBlob(c.thumbnailBlobId);
    if (thumb) {
      const img = document.createElement('img');
      const u = URL.createObjectURL(thumb);
      urls.push(u);
      img.src = u;
      img.alt = '';
      btn.append(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'ph';
      ph.textContent = c.kind === 'recording' ? '▶' : '▣';
      btn.append(ph);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.title;
    const sub = document.createElement('span');
    sub.className = 'muted small';
    sub.textContent = `${c.kind === 'recording' ? 'Recording' : 'Screenshot'} · ${new Date(c.createdAt).toLocaleString()}`;
    meta.append(title, sub);
    btn.append(meta);
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/editor.html?capture=${c.id}`) });
      window.close();
    });
    li.append(btn);
    list.append(li);
  }
}

document.querySelectorAll('[data-capture]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await send({ type: 'capture:start', mode: btn.dataset.capture, tabId: tab.id, delaySeconds: delay });
    window.close();
  });
});

$('btn-rec-tab').addEventListener('click', async () => {
  await send({ type: 'record:tab:start', tabId: tab.id });
  window.close();
});
$('btn-rec-window').addEventListener('click', async () => {
  const res = await send({ type: 'record:window:open' });
  if (res && !res.ok) {
    $('error').textContent = res.error;
    $('error').hidden = false;
    return;
  }
  window.close();
});
$('btn-pending').addEventListener('click', async () => {
  await send({ type: 'bridge:run-pending', tabId: tab.id });
  window.close();
});
$('btn-pause').addEventListener('click', async () => { await send({ type: 'record:pause' }); refreshState(); });
$('btn-resume').addEventListener('click', async () => { await send({ type: 'record:resume' }); refreshState(); });
$('btn-stop').addEventListener('click', async () => { await send({ type: 'record:stop' }); window.close(); });
$('btn-library').addEventListener('click', () => { send({ type: 'open:library' }); window.close(); });
$('btn-options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
$('btn-shortcuts').addEventListener('click', () => { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); window.close(); });

async function refreshState() {
  const state = await send({ type: 'popup:state', tabId: tab?.id });
  renderRecording(state?.recording);
}

window.addEventListener('unload', () => urls.forEach((u) => URL.revokeObjectURL(u)));
init();
