// Editor page (§7): annotation, context, destinations, save. Also hosts the library view.

import { getSettings } from '../shared/settings.js';
import { getCapture, updateCapture, getBlob, putBlob, del, listCaptures } from '../shared/db.js';
import { getJob } from '../shared/jobs.js';
import { thumbnailFromSource } from '../shared/image.js';
import { formatBytes, formatDuration } from '../shared/util.js';
import { Annotator } from './canvas.js';
import { ExportFactory } from './export/files.js';
import { ContextForm } from './context-form.js';
import { VideoEditor } from './video-editor.js';
import { renderLibrary } from './library.js';
import { toast, confirmDialog, el } from './ui.js';
import { getAdapter, SAVE_ORDER } from '../storage/adapter.js';
import { ensureS3Permission } from '../storage/s3.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const settings = await getSettings();

let capture = null;
let annotator = null;
let videoEditor = null;
let contextForm = null;
let job = null;
let busy = false;
const dest = {}; // id → { on, formats: Set, available, reason, touched }

const DEST_DISPLAY_ORDER = ['servicenow', 's3', 'download'];
const FORMAT_LABELS = { png: 'PNG', pdf: 'PDF report', video: 'Video', sidecar: '.md + .json' };
const FORMATS = {
  screenshot: { download: ['png', 'pdf'], s3: ['png', 'pdf'], servicenow: ['pdf', 'png'] },
  recording: { download: ['video', 'pdf', 'sidecar'], s3: ['video', 'pdf', 'sidecar'], servicenow: ['pdf', 'video'] },
};

// ---------------------------------------------------------------- views

function showLibrary() {
  $('editor-view').hidden = true;
  $('library-view').hidden = false;
  document.title = 'Library — Snap Companion';
  history.replaceState(null, '', '?view=library');
  renderLibrary($('library-view'), { onOpen: (id) => { location.href = `?capture=${encodeURIComponent(id)}`; } });
}

$('btn-library').addEventListener('click', async () => {
  await persist();
  showLibrary();
});

// ---------------------------------------------------------------- load

async function openCapture(id) {
  capture = await getCapture(id);
  if (!capture) {
    toast('That capture no longer exists.');
    showLibrary();
    return;
  }
  job = capture.jobId ? await getJob(capture.jobId) : null;
  $('editor-view').hidden = false;
  document.title = `${capture.title} — Snap Companion`;
  $('title').value = capture.title;
  const knownTags = (await listCaptures()).flatMap((c) => c.context?.tags || []);
  contextForm = new ContextForm({ settings, knownTags });
  contextForm.set(capture.context || {});
  contextForm.addEventListener('change', schedulePersist);
  renderEnvironment();
  if (capture.warnings?.length) {
    $('warnings').hidden = false;
    $('warnings').textContent = capture.warnings.join(' ');
  }
  document.querySelectorAll('[data-kind]').forEach((b) => { b.hidden = b.dataset.kind !== capture.kind; });

  if (capture.kind === 'screenshot') await setupImage();
  else await setupVideo();
  $('loading').hidden = true;

  await setupDestinations();
  renderSaves();
}

function renderEnvironment() {
  const e = capture.environment || {};
  const rows = [
    ['Instance', e.instance], ['Table', e.table], ['Record', e.label], ['Browser', e.browser],
    ['Viewport', e.viewport], ['Pixel ratio', e.dpr && e.dpr !== 1 ? `${Math.round(e.dpr * 100) / 100}×` : ''],
    ['Captured', e.capturedAt && new Date(e.capturedAt).toLocaleString()], ['Captured by', e.capturedBy],
    ['Source', capture.source?.url],
  ].filter(([, v]) => v);
  $('env').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

// ---------------------------------------------------------------- image editing

async function setupImage() {
  const blob = await getBlob(capture.originalBlobId);
  if (!blob) {
    toast('The image data for this capture is missing.');
    return;
  }
  const bmp = await createImageBitmap(blob);
  $('canvas-wrap').hidden = false;
  annotator = new Annotator($('canvas'), bmp, { doc: capture.annotations, unit: capture.source?.dpr || 1 });
  annotator.addEventListener('change', () => { syncToolState(); schedulePersist(); });
  annotator.addEventListener('select', syncToolState);
  annotator.addEventListener('text-request', (e) => openTextInput(e.detail));
  annotator.addEventListener('text-edit', (e) => openTextInput(e.detail));
  setTool('arrow');
  setColor('#e5484d');
  setWidth(4);
  setBlurMode('pixelate');
  syncToolState();
}

function setTool(tool) {
  if (!annotator) return;
  commitText();
  annotator.setTool(tool);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}
function setColor(color) {
  annotator?.setColor(color);
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
}
function setWidth(w) {
  annotator?.setStrokeWidth(w);
  document.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === w));
}
function setBlurMode(mode) {
  annotator?.setBlurMode(mode);
  document.querySelectorAll('[data-blur]').forEach((b) => b.classList.toggle('active', b.dataset.blur === mode));
}

function syncToolState() {
  if (!annotator) return;
  $('btn-undo').disabled = !annotator.canUndo;
  $('btn-redo').disabled = !annotator.canRedo;
  $('btn-delete').disabled = !annotator.selected;
  $('btn-clear-crop').disabled = !annotator.doc.crop;
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
document.querySelectorAll('[data-width]').forEach((b) => b.addEventListener('click', () => setWidth(Number(b.dataset.width))));
document.querySelectorAll('[data-blur]').forEach((b) => b.addEventListener('click', () => { setBlurMode(b.dataset.blur); setTool('blur'); }));
$('btn-undo').addEventListener('click', () => annotator?.undo());
$('btn-redo').addEventListener('click', () => annotator?.redo());
$('btn-delete').addEventListener('click', () => annotator?.deleteSelected());
$('btn-clear-crop').addEventListener('click', () => annotator?.clearCrop());
$('btn-zoom').addEventListener('click', () => {
  const wrap = $('canvas-wrap');
  const actual = wrap.classList.toggle('actual');
  const dpr = capture?.source?.dpr || 1;
  $('canvas').style.width = actual ? `${$('canvas').width / dpr}px` : '';
  $('btn-zoom').querySelector('span').textContent = actual ? '1:1' : 'Fit';
});

// Text annotations are typed into a textarea laid over the canvas.
let textState = null;

function openTextInput({ id, x, y, text = '', size, color }) {
  commitText();
  const ta = $('text-input');
  const c = annotator.toClient({ x, y });
  const canvas = $('canvas');
  const fontPx = Math.max(12, (size || 18 * annotator.unit) * c.scale);
  textState = { id, x, y };
  ta.value = text;
  ta.style.left = `${canvas.offsetLeft + c.x}px`;
  ta.style.top = `${canvas.offsetTop + c.y}px`;
  ta.style.fontSize = `${fontPx}px`;
  ta.style.color = '#111';
  ta.style.borderColor = color || annotator.color;
  ta.hidden = false;
  autosize();
  setTimeout(() => ta.focus(), 0);
}

function autosize() {
  const ta = $('text-input');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
  ta.style.width = 'auto';
  ta.style.width = `${Math.max(120, ta.scrollWidth + 8)}px`;
}

function commitText(cancel = false) {
  const ta = $('text-input');
  if (!textState || ta.hidden) return;
  const { id, x, y } = textState;
  textState = null;
  ta.hidden = true;
  if (cancel) return;
  if (id) annotator.updateText(id, ta.value);
  else annotator.addText(x, y, ta.value);
}

$('text-input').addEventListener('input', autosize);
$('text-input').addEventListener('blur', () => commitText());
$('text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
  if (e.key === 'Escape') { e.preventDefault(); commitText(true); }
  e.stopPropagation();
});

const KEY_TOOLS = { v: 'select', c: 'crop', a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', h: 'highlight', n: 'step', b: 'blur' };

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (!typing && videoEditor && !mod) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && videoEditor.deleteSelected()) e.preventDefault();
    if (e.key === 'Escape') videoEditor.setRedactMode(false);
    if (e.key === 'k') videoEditor.addKeyframe();
    if (e.key === '[') videoEditor.setIn(videoEditor.nowMs);
    if (e.key === ']') videoEditor.setOut(videoEditor.nowMs);
    return;
  }
  if (typing || !annotator) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) annotator.redo(); else annotator.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); annotator.redo(); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); annotator.deleteSelected(); return; }
  if (e.key === 'Escape') { setTool('select'); return; }
  const tool = KEY_TOOLS[e.key.toLowerCase()];
  if (tool) setTool(tool);
});

// ---------------------------------------------------------------- video

async function setupVideo() {
  $('tools').hidden = true;
  document.querySelector('.layout').classList.add('mode-video');
  const blob = await getBlob(capture.originalBlobId);
  if (!blob) {
    toast('The video data for this capture is missing.');
    return;
  }
  $('video-wrap').hidden = false;
  const dur = capture.source?.durationMs ? formatDuration(capture.source.durationMs) : '';
  $('video-meta').textContent = [dur && `original ${dur}`, formatBytes(blob.size), (capture.source?.mimeType || blob.type).split(';')[0]].filter(Boolean).join(' · ');
  videoEditor = new VideoEditor({ capture, blob });
  await videoEditor.init();
  videoEditor.addEventListener('change', () => { schedulePersist(); scheduleVideoThumbnail(); });
}

let videoThumbTimer = null;
function scheduleVideoThumbnail() {
  clearTimeout(videoThumbTimer);
  videoThumbTimer = setTimeout(async () => {
    try {
      const frame = await videoEditor.thumbnail();
      const id = await putBlob(await thumbnailFromSource(await createImageBitmap(frame)));
      const old = capture.thumbnailBlobId;
      capture = (await updateCapture(capture.id, (c) => { c.thumbnailBlobId = id; })) || capture;
      if (old) await del('blobs', old);
    } catch { /* cosmetic */ }
  }, 1500);
}

// ---------------------------------------------------------------- persistence

let persistTimer = null;

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 500);
  $('save-status').textContent = 'Editing…';
}

async function persist() {
  clearTimeout(persistTimer);
  if (!capture) return;
  commitText();
  const title = $('title').value.trim() || capture.title;
  const context = { ...capture.context, ...contextForm.get() };
  const annotations = annotator ? annotator.toDoc() : undefined;
  const video = videoEditor ? videoEditor.state() : undefined;
  // Re-read first so results the service worker wrote (ServiceNow saves) aren't clobbered.
  const updated = await updateCapture(capture.id, (c) => {
    c.title = title;
    c.context = context;
    if (annotations) c.annotations = annotations;
    if (video) {
      if (video.trim) c.trim = video.trim; else delete c.trim;
      c.videoRedactions = video.videoRedactions;
      c.keyframes = video.keyframes;
    }
  });
  if (updated) capture = updated;
  document.title = `${capture.title} — Snap Companion`;
  $('save-status').textContent = 'Saved locally';
}

for (const id of ['title', 'ctx-recordUrl', 'ctx-description', 'ctx-notes']) $(id).addEventListener('input', schedulePersist);
window.addEventListener('pagehide', () => videoEditor?.dispose());
$('ctx-description').addEventListener('input', () => $('ctx-description').classList.remove('invalid'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

// ---------------------------------------------------------------- destinations

const adapterCtx = () => ({
  settings,
  capture,
  snContext: capture.servicenow
    ? { instance: capture.servicenow.instance, table: capture.servicenow.table, sysId: capture.servicenow.sysId, label: capture.servicenow.label }
    : undefined,
});

function snDefaultFormats() {
  const allowed = FORMATS[capture.kind].servicenow;
  if (capture.kind === 'recording' && dest.s3?.on) return ['pdf']; // hybrid: video → S3, PDF → record
  const requested = (job?.deliver || []).filter((f) => allowed.includes(f));
  if (requested.length) return requested;
  return allowed.includes(settings.snDefaultFormat) ? [settings.snDefaultFormat] : ['pdf'];
}

function defaultFormats(id) {
  if (id === 'servicenow') return snDefaultFormats();
  if (capture.kind === 'screenshot') return ['png'];
  return id === 's3' ? ['video', 'sidecar'] : ['video'];
}

async function setupDestinations() {
  const defaults = new Set(capture.kind === 'screenshot' ? settings.defaultScreenshotDestinations : settings.defaultRecordingDestinations);
  if (capture.servicenow) defaults.add('servicenow');
  for (const id of ['s3', 'download', 'servicenow']) { // S3 first: SN defaults depend on it
    const av = await getAdapter(id).isAvailable(adapterCtx()).catch((err) => ({ available: false, reason: err.message }));
    dest[id] = { on: av.available && defaults.has(id), available: av.available, reason: av.reason, touched: false };
    dest[id].formats = new Set(defaultFormats(id));
  }
  renderDestinations();
}

async function refreshSnAvailability() {
  if (!dest.servicenow) return;
  const av = await getAdapter('servicenow').isAvailable(adapterCtx()).catch((err) => ({ available: false, reason: err.message }));
  dest.servicenow.available = av.available;
  dest.servicenow.reason = av.reason;
  if (!av.available) dest.servicenow.on = false;
  renderDestinations();
}
window.addEventListener('focus', () => { if (capture?.servicenow && !busy) refreshSnAvailability(); });

function renderDestinations() {
  const root = $('destinations');
  root.replaceChildren();
  for (const id of DEST_DISPLAY_ORDER) {
    const d = dest[id];
    const adapter = getAdapter(id);
    const label = id === 'servicenow' && capture.servicenow ? `Record ${capture.servicenow.label}` : adapter.label;
    const toggle = el('input', { type: 'checkbox', checked: d.on, disabled: !d.available || busy, id: `dest-${id}` });
    toggle.addEventListener('change', () => {
      d.on = toggle.checked;
      if (id === 's3' && capture.kind === 'recording' && dest.servicenow && !dest.servicenow.touched) {
        dest.servicenow.formats = new Set(snDefaultFormats());
      }
      renderDestinations();
    });
    const box = el('div', { class: `dest${d.on ? ' on' : ''}${d.available ? '' : ' unavailable'}` },
      el('label', { class: 'dest-head', for: `dest-${id}` }, toggle, label));
    if (!d.available && d.reason) box.append(el('div', { class: 'dest-reason', text: d.reason }));
    if (id === 'servicenow' && !d.available && capture.servicenow && dest.download.available) {
      box.append(el('button', {
        class: 'link-btn',
        onclick: () => {
          dest.download.on = true;
          for (const f of d.formats) if (FORMATS[capture.kind].download.includes(f)) dest.download.formats.add(f);
          renderDestinations();
        },
      }, 'Download these files instead'));
    }
    if (d.on) {
      const formats = el('div', { class: 'dest-formats' });
      for (const f of FORMATS[capture.kind][id]) {
        const cb = el('input', { type: 'checkbox', checked: d.formats.has(f), disabled: busy });
        cb.addEventListener('change', () => {
          if (cb.checked) d.formats.add(f); else d.formats.delete(f);
          d.touched = true;
        });
        formats.append(el('label', {}, cb, FORMAT_LABELS[f]));
      }
      box.append(formats);
    }
    root.append(box);
  }
  $('desc-required').hidden = !dest.servicenow?.on;
}

// ---------------------------------------------------------------- saving

function setBusy(on, status = '') {
  busy = on;
  $('btn-save').disabled = on;
  $('btn-export').disabled = on;
  $('save-status').textContent = status;
  renderDestinations();
}

function hasRedaction() {
  return capture.kind === 'screenshot' ? !!annotator?.hasRedaction() : !!videoEditor?.redactions.length;
}

function needsRedactionReminder(plan) {
  return settings.redactionReminder && !hasRedaction() && plan.some((p) => p.id === 's3' || p.id === 'servicenow');
}

/** plan: [{ id, formats: [] }] in SAVE_ORDER. Defaults to the destinations panel. */
async function save(plan) {
  if (busy || !capture) return;
  plan = plan || SAVE_ORDER
    .filter((id) => dest[id]?.on && dest[id].available && dest[id].formats.size)
    .map((id) => ({ id, formats: [...dest[id].formats] }));
  if (!plan.length) { toast('Choose at least one destination and file format.'); return; }
  const blocked = plan.find((p) => !dest[p.id]?.available);
  if (blocked) { toast(dest[blocked.id]?.reason || 'That destination is unavailable.'); return; }

  // Permission prompt must come first, while we still hold the click's user gesture.
  if (plan.some((p) => p.id === 's3') && !(await ensureS3Permission(settings))) {
    toast('Access to the S3 presign endpoint was not granted.');
    return;
  }
  if (plan.some((p) => p.id === 'servicenow') && !$('ctx-description').value.trim()) {
    $('ctx-description').classList.add('invalid');
    $('ctx-description').focus();
    toast('Add a one-line description before attaching to ServiceNow.');
    return;
  }
  const missing = plan.some((p) => p.id !== 'download') ? contextForm.missingRequired() : [];
  if (missing.length) {
    contextForm.markMissing(missing);
    toast(`Fill in ${missing.map((f) => f.label).join(', ')} before saving to ${plan.some((p) => p.id === 'servicenow') ? 'ServiceNow' : 'S3'}.`);
    return;
  }
  if (needsRedactionReminder(plan)) {
    const ok = await confirmDialog({
      title: 'Check for personal data',
      message: `This ${capture.kind === 'screenshot' ? 'screenshot' : 'recording'} has no redaction (blur/pixelate) regions. Make sure it contains no personal or sensitive data before it leaves this device.`,
      ok: 'Save anyway',
      cancel: 'Go back',
    });
    if (!ok) return;
  }

  await persist();
  setBusy(true, 'Preparing files…');
  const factory = new ExportFactory({ capture, annotator, settings, onProgress: (msg) => { $('save-status').textContent = msg; } });
  const links = [];
  const results = [];
  const now = () => new Date().toISOString();
  try {
    for (const step of plan) {
      const adapter = getAdapter(step.id);
      const ctx = adapterCtx();
      if (adapter.saveAll) {
        const files = [];
        for (const f of step.formats) files.push(...(await factory.get(f, links)));
        setBusy(true, `Sending to ${adapter.label}…`);
        results.push(...(await adapter.saveAll(files, ctx)));
        continue;
      }
      // PDF last, so it can cite the links of files uploaded just before it.
      const ordered = [...step.formats].sort((a, b) => (a === 'pdf') - (b === 'pdf'));
      for (const f of ordered) {
        for (const file of await factory.get(f, links)) {
          setBusy(true, `${adapter.label}: ${file.name}`);
          const r = await adapter.save(file, ctx, (p) => setBusy(true, `${adapter.label}: ${file.name} ${Math.round(p * 100)}%`));
          r.at = now();
          results.push(r);
          if (step.id === 's3' && r.ok && /^https?:\/\//.test(r.location || '')) links.push({ label: `S3: ${file.name}`, url: r.location });
        }
      }
    }
  } catch (err) {
    results.push({ adapter: 'editor', ok: false, name: '', error: err.message, at: now() });
  } finally {
    setBusy(false);
  }

  const mine = results.filter((r) => !r.persisted).map(({ adapter, ok, name, location, error, at, downloadId }) => ({
    adapter, ok, name, location, error, at: at || now(), downloadId,
  }));
  capture = (await updateCapture(capture.id, (c) => { c.saves = [...(c.saves || []), ...mine]; })) || capture;
  await refreshThumbnail();
  renderSaves();
  if (dest.servicenow && capture.servicenow) await refreshSnAvailability();

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    $('save-status').textContent = `Saved ${results.length} file${results.length === 1 ? '' : 's'}`;
    toast(factory.warnings.length ? `Saved. ${factory.warnings.join(' ')}` : 'Saved.', factory.warnings.length ? 6000 : 3500);
  } else {
    $('save-status').textContent = `${failed.length} of ${results.length} failed`;
    toast(`${failed.length} save${failed.length === 1 ? '' : 's'} failed: ${failed[0].error}`, 6000);
  }
}

async function refreshThumbnail() {
  if (!annotator) return;
  try {
    const thumb = await thumbnailFromSource(await createImageBitmap(annotator.exportCanvas()));
    const id = await putBlob(thumb);
    const old = capture.thumbnailBlobId;
    capture = (await updateCapture(capture.id, (c) => { c.thumbnailBlobId = id; })) || capture;
    if (old) await del('blobs', old);
  } catch { /* cosmetic */ }
}

const ADAPTER_NAMES = { download: 'Downloaded', s3: 'S3', servicenow: 'ServiceNow', editor: 'Editor' };

function renderSaves() {
  const saves = capture.saves || [];
  $('saves-section').hidden = !saves.length;
  $('saves').replaceChildren(...saves.slice().reverse().map((s) => {
    let detail;
    if (!s.ok) detail = el('span', { class: 'detail error', text: s.error || 'Failed' });
    else if (s.adapter === 'download' && s.downloadId) {
      detail = el('span', { class: 'detail' }, el('a', { href: '#', onclick: (e) => { e.preventDefault(); chrome.downloads.show(s.downloadId); }, text: 'Show in folder' }));
    } else if (/^https?:\/\//.test(s.location || '')) {
      detail = el('span', { class: 'detail' }, el('a', { href: s.location, target: '_blank', rel: 'noopener', text: s.location }));
    } else detail = el('span', { class: 'detail', text: s.location || '' });
    return el('li', {},
      el('span', { class: `st ${s.ok ? 'ok' : 'fail'}`, text: s.ok ? '✓' : '✕' }),
      el('span', {}, el('strong', { text: ADAPTER_NAMES[s.adapter] || s.adapter }), ` ${s.name || ''}`,
        el('span', { class: 'muted', text: ` · ${new Date(s.at).toLocaleTimeString()}` })),
      detail);
  }));
}

// Results can arrive while the tab is in the background (ServiceNow upload done by the page).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'sn:result' && capture && msg.captureId === capture.id) {
    getCapture(capture.id).then((c) => { if (c) { capture = c; renderSaves(); } });
  }
});

$('btn-save').addEventListener('click', () => save());

// Export menu: one-off downloads.
const menu = $('export-menu');
$('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('btn-export').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', () => { menu.hidden = true; $('btn-export').setAttribute('aria-expanded', 'false'); });
menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
  menu.hidden = true;
  const fmt = b.dataset.export;
  if (fmt === 'clipboard') {
    try {
      const blob = await new Promise((r) => annotator.exportCanvas().toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied to the clipboard.');
    } catch (err) {
      toast(`Copy failed: ${err.message}`);
    }
    return;
  }
  save([{ id: 'download', formats: [fmt] }]);
}));

// ---------------------------------------------------------------- boot

if (params.get('capture') && params.get('view') !== 'library') {
  openCapture(params.get('capture')).catch((err) => { console.error(err); toast(err.message, 8000); });
} else {
  showLibrary();
}
