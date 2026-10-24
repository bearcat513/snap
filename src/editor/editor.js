// Editor page (§7): annotation, context, destinations, save. Also hosts the library view.

import { getSettings, templateForTable } from '../shared/settings.js';
import { getCapture, updateCapture, getBlob, putBlob, del, listCaptures } from '../shared/db.js';
import { getJob } from '../shared/jobs.js';
import { thumbnailFromSource } from '../shared/image.js';
import { formatBytes, formatDuration } from '../shared/util.js';
import { Annotator, TOOLS } from './canvas.js';
import { ExportFactory } from './export/files.js';
import { ContextForm } from './context-form.js';
import { VideoEditor } from './video-editor.js';
import { renderLibrary } from './library.js';
import { toast, confirmDialog, el } from './ui.js';
import { getAdapter, SAVE_ORDER, requestPlanOrigins } from '../storage/adapter.js';
import { runSavePlan } from './save-runner.js';
import { toSaveRecord } from '../shared/saves.js';
import { describeLimits } from '../shared/sn.js';
import '../ui/theme.js';
import { logError, installErrorLogging } from '../shared/diagnostics.js';

installErrorLogging('editor');

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

const DEST_DISPLAY_ORDER = ['servicenow', 'jira', 'github', 'webhook', 's3', 'download'];
const TRACKERS = new Set(['webhook', 'jira', 'github']); // shown only once configured
const FORMAT_LABELS = { issue: 'Issue', png: 'PNG', pdf: 'PDF report', video: 'Video', gif: 'GIF', sidecar: '.md + .json' };
const FORMATS = {
  screenshot: {
    download: ['png', 'pdf', 'sidecar'], s3: ['png', 'pdf', 'sidecar'], servicenow: ['pdf', 'png'],
    webhook: ['png', 'pdf', 'sidecar'], jira: ['issue', 'png', 'pdf'], github: ['issue', 'png', 'pdf'],
  },
  recording: {
    download: ['video', 'gif', 'pdf', 'sidecar'], s3: ['video', 'gif', 'pdf', 'sidecar'], servicenow: ['pdf', 'video', 'gif'],
    webhook: ['video', 'pdf', 'sidecar'], jira: ['issue', 'pdf', 'gif', 'video'], github: ['issue', 'gif', 'pdf'],
  },
  session: {
    download: ['pdf', 'png', 'video', 'sidecar'], s3: ['pdf', 'png', 'video', 'sidecar'], servicenow: ['pdf', 'png', 'video'],
    webhook: ['pdf', 'sidecar'], jira: ['issue', 'pdf'], github: ['issue', 'pdf'],
  },
};
// GitHub can only take files when an attachments branch is set (Settings → Issue trackers).
if (!getAdapter('github').canAttach(settings)) for (const k of Object.keys(FORMATS)) FORMATS[k].github = ['issue'];
let sessionMembers = []; // session view: member captures in report order

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
  if (params.get('session')) location.href = `?capture=${encodeURIComponent(params.get('session'))}`;
  else showLibrary();
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
  await autoApplyTemplate();
  renderEnvironment();
  if (capture.warnings?.length) {
    $('warnings').hidden = false;
    $('warnings').textContent = capture.warnings.join(' ');
  }
  document.querySelectorAll('[data-kind]').forEach((b) => { b.hidden = !b.dataset.kind.split(' ').includes(capture.kind); });
  if (params.get('session')) {
    $('btn-library').textContent = '◀ Session';
    $('btn-library').title = 'Back to the session report';
  }

  if (capture.kind === 'screenshot') await setupImage();
  else if (capture.kind === 'session') await setupSession();
  else await setupVideo();
  $('loading').hidden = true;

  await setupDestinations();
  renderSaves();
}

/** Templates can name ServiceNow tables; apply the match once, to a new /snap capture. */
async function autoApplyTemplate() {
  if (!capture.servicenow || capture.templateApplied) return;
  const t = templateForTable(settings.templates, capture.servicenow.table);
  if (!t) return;
  contextForm.apply(t);
  capture = (await updateCapture(capture.id, (c) => { c.templateApplied = t.id; })) || capture;
  toast(`Applied the “${t.name}” template for ${capture.servicenow.table} records.`);
}

function renderEnvironment() {
  const e = capture.environment || {};
  const rows = [
    ['Instance', e.instance], ['Table', e.table], ['Record', e.label], ['Browser', e.browser],
    ['Viewport', e.viewport], ['Pixel ratio', e.dpr && e.dpr !== 1 ? `${Math.round(e.dpr * 100) / 100}×` : ''],
    ['Captured', e.capturedAt && new Date(e.capturedAt).toLocaleString()], ['Captured by', e.capturedBy],
    ['Source', capture.source?.url],
    ['Console', capture.devtools && `${capture.devtools.console.length} error${capture.devtools.console.length === 1 ? '' : 's'} / warning${capture.devtools.console.length === 1 ? '' : 's'}`],
    ['Network', capture.devtools && `${capture.devtools.network.length} failed request${capture.devtools.network.length === 1 ? '' : 's'}`],
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
  const style = initialStyle();
  renderSwatches(style.color);
  setTool(style.tool);
  setColor(style.color);
  setWidth(style.width);
  setBlurMode(style.blurMode);
  syncToolState();
  annotator.addEventListener('hint-click', (e) => acceptSuggestions([e.detail.index]));
  renderSuggestions();
}

// ---------------------------------------------------------------- suggested redactions

const KIND_LABELS = {
  email: ['email address', 'email addresses'], phone: ['phone number', 'phone numbers'], ipv4: ['IP address', 'IP addresses'],
  card: ['card number', 'card numbers'], token: ['token or key', 'tokens or keys'], password: ['password field', 'password fields'],
  custom: ['match of your patterns', 'matches of your patterns'],
};

const pendingSuggestions = () => (capture?.suggestionsReviewed ? [] : capture?.suggestedRedactions || []);

function describeSuggestions(list) {
  const counts = new Map();
  for (const s of list) counts.set(s.kind, (counts.get(s.kind) || 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${(KIND_LABELS[k] || [k, k])[n === 1 ? 0 : 1]}`).join(', ');
}

let reviewing = false;

function renderSuggestions() {
  const list = pendingSuggestions();
  $('suggest-banner').hidden = !list.length || !annotator;
  if (!list.length) { reviewing = false; annotator?.setHints([]); return; }
  $('suggest-text').textContent = `Found ${list.length} thing${list.length === 1 ? '' : 's'} that look${list.length === 1 ? 's' : ''} sensitive: ${describeSuggestions(list)}. ${reviewing ? 'Click an outlined area to redact it.' : 'Nothing is hidden until you choose.'}`;
  $('btn-suggest-review').setAttribute('aria-pressed', String(reviewing));
  annotator.setHints(reviewing ? list : []);
}

async function updateSuggestions(remaining, reviewed = false) {
  capture = (await updateCapture(capture.id, (c) => {
    c.suggestedRedactions = remaining;
    if (reviewed || !remaining.length) c.suggestionsReviewed = true;
  })) || capture;
  renderSuggestions();
}

/** Turn the suggestions at `indexes` into blur/pixelate redactions (one undo step). */
async function acceptSuggestions(indexes) {
  const list = pendingSuggestions();
  const picked = new Set(indexes);
  annotator.addShapes(list.filter((_, i) => picked.has(i)).map(({ x, y, w, h }) => ({ type: 'blur', props: { x, y, w, h, mode: annotator.blurMode } })));
  await updateSuggestions(list.filter((_, i) => !picked.has(i)));
}

$('btn-suggest-all').addEventListener('click', () => acceptSuggestions(pendingSuggestions().map((_, i) => i)));
$('btn-suggest-review').addEventListener('click', () => { reviewing = !reviewing; renderSuggestions(); });
$('btn-suggest-dismiss').addEventListener('click', () => updateSuggestions([], true));

// Annotation style: Settings → Editor defaults, or the last style used when "remember" is on.
const STYLE_KEY = 'snap.editorStyle';

function initialStyle() {
  const style = {
    tool: settings['editor.defaultTool'],
    color: settings['editor.defaultColor'],
    width: Number(settings['editor.defaultWidth']),
    blurMode: settings['editor.defaultBlurMode'],
  };
  if (settings['editor.rememberStyle']) {
    try { Object.assign(style, JSON.parse(localStorage.getItem(STYLE_KEY) || '{}')); } catch { /* use defaults */ }
  }
  if (!TOOLS.includes(style.tool) || style.tool === 'crop') style.tool = 'arrow';
  if (![2, 4, 8].includes(style.width)) style.width = 4;
  if (!['pixelate', 'blur'].includes(style.blurMode)) style.blurMode = 'pixelate';
  if (!/^#[0-9a-f]{6}$/i.test(style.color || '')) style.color = settings['editor.palette'][0];
  return style;
}

function rememberStyle(patch) {
  if (!settings['editor.rememberStyle']) return;
  try {
    const cur = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    localStorage.setItem(STYLE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* convenience only */ }
}

function renderSwatches(extra) {
  const colors = settings['editor.palette'].includes(extra?.toLowerCase()) || !extra ? settings['editor.palette'] : [extra.toLowerCase(), ...settings['editor.palette']];
  $('swatches').replaceChildren(...colors.map((c) => el('button', {
    'data-color': c, title: c, 'aria-label': `Color ${c}`, style: `--c:${c}`, onclick: () => setColor(c),
  })));
}

function setTool(tool) {
  if (!annotator) return;
  commitText();
  annotator.setTool(tool);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'crop') rememberStyle({ tool });
}
function setColor(color) {
  annotator?.setColor(color);
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === color.toLowerCase()));
  rememberStyle({ color });
}
function setWidth(w) {
  annotator?.setStrokeWidth(w);
  document.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === w));
  rememberStyle({ width: w });
}
function setBlurMode(mode) {
  annotator?.setBlurMode(mode);
  document.querySelectorAll('[data-blur]').forEach((b) => b.classList.toggle('active', b.dataset.blur === mode));
  rememberStyle({ blurMode: mode });
}

function syncToolState() {
  if (!annotator) return;
  $('btn-undo').disabled = !annotator.canUndo;
  $('btn-redo').disabled = !annotator.canRedo;
  $('btn-delete').disabled = !annotator.selected;
  $('btn-clear-crop').disabled = !annotator.doc.crop;
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('[data-width]').forEach((b) => b.addEventListener('click', () => setWidth(Number(b.dataset.width))));
document.querySelectorAll('[data-blur]').forEach((b) => b.addEventListener('click', () => { setBlurMode(b.dataset.blur); setTool('blur'); }));
$('btn-undo').addEventListener('click', () => annotator?.undo());
$('btn-redo').addEventListener('click', () => annotator?.redo());
$('btn-delete').addEventListener('click', () => annotator?.deleteSelected());
$('btn-clear-crop').addEventListener('click', () => annotator?.clearCrop());

// Zoom: null = fit to the stage; otherwise a factor of the capture's CSS size (1 = 100%).
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
let zoom = null;

function currentZoom() {
  if (zoom) return zoom;
  const canvas = $('canvas');
  return canvas.getBoundingClientRect().width / (canvas.width / (capture?.source?.dpr || 1));
}

/** Set the zoom; `anchor` (client x/y) stays over the same image point, else the view center does. */
function setZoom(next, anchor) {
  if (!annotator) return;
  commitText();
  const stage = $('stage');
  const canvas = $('canvas');
  const before = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const ax = anchor?.x ?? sr.left + sr.width / 2;
  const ay = anchor?.y ?? sr.top + sr.height / 2;
  const fx = (ax - before.left) / before.width;
  const fy = (ay - before.top) / before.height;

  zoom = next === null ? null : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  const dpr = capture?.source?.dpr || 1;
  $('canvas-wrap').classList.toggle('actual', zoom !== null);
  stage.classList.toggle('zoomed', zoom !== null);
  canvas.style.width = zoom === null ? '' : `${(canvas.width / dpr) * zoom}px`;
  $('btn-zoom').querySelector('span').textContent = zoom === null ? 'Fit' : `${Math.round(zoom * 100)}%`;
  if (zoom === null) return;
  const after = canvas.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - ax;
  stage.scrollTop += after.top + fy * after.height - ay;
}

const zoomBy = (factor, anchor) => setZoom(currentZoom() * factor, anchor);

$('btn-zoom').addEventListener('click', () => setZoom(zoom === null ? 1 : null));
$('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
$('stage').addEventListener('wheel', (e) => {
  if (!annotator || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); // also stops the browser's page zoom (trackpad pinch arrives as ctrl+wheel)
  zoomBy(Math.exp(-e.deltaY / 300), { x: e.clientX, y: e.clientY });
}, { passive: false });

// ---------------------------------------------------------------- copy & help

async function copyImage() {
  if (!annotator) return;
  try {
    commitText();
    const blob = await new Promise((r) => annotator.exportCanvas().toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied to the clipboard.');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

$('btn-copy').addEventListener('click', copyImage);
$('btn-help').addEventListener('click', () => $('help-dialog').showModal());

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

const KEY_TOOLS = { v: 'select', c: 'crop', a: 'arrow', r: 'rect', e: 'ellipse', p: 'pen', t: 'text', h: 'highlight', n: 'step', b: 'blur' };

function videoKey(e) {
  const v = videoEditor;
  // The native player and the timeline handle Space/arrows themselves while focused.
  const own = document.activeElement === $('video') || document.activeElement === $('timeline');
  if ((e.key === 'Delete' || e.key === 'Backspace') && v.deleteSelected()) e.preventDefault();
  else if (e.key === 'Escape') v.setRedactMode(false);
  else if (e.key === 'k') v.addKeyframe();
  else if (e.key === '[') v.setIn(v.nowMs);
  else if (e.key === ']') v.setOut(v.nowMs);
  else if (e.key === ',' || e.key === '.') v.stepFrames(e.key === ',' ? -1 : 1);
  else if (e.key === 'Home') v.seekTo(v.range()[0]);
  else if (e.key === 'End') v.seekTo(v.range()[1]);
  else if (own) return;
  else if (e.key === ' ') v.togglePlay();
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') v.seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5000 : 1000));
  else return;
  e.preventDefault();
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing || $('help-dialog').open) return;
  if (e.key === '?') { e.preventDefault(); $('help-dialog').showModal(); return; }
  if (videoEditor && !mod) { videoKey(e); return; }
  if (!annotator) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) annotator.redo(); else annotator.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); annotator.redo(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(0.8); return; }
  if (mod && e.key === '0') { e.preventDefault(); setZoom(zoom === null ? 1 : null); return; }
  if (mod && e.key.toLowerCase() === 'c' && !e.shiftKey && !String(window.getSelection())) { e.preventDefault(); copyImage(); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); annotator.deleteSelected(); return; }
  if (e.key === 'Escape') { setTool('select'); return; }
  const tool = KEY_TOOLS[e.key.toLowerCase()];
  if (tool) setTool(tool);
});

// ---------------------------------------------------------------- session report

async function setupSession() {
  $('tools').hidden = true;
  document.querySelector('.layout').classList.add('mode-video', 'mode-session');
  $('session-wrap').hidden = false;
  sessionMembers = [];
  for (const id of capture.members || []) {
    const m = await getCapture(id);
    if (m) sessionMembers.push(m);
  }
  const kinds = new Set(sessionMembers.map((m) => m.kind));
  // Offer only the per-file formats this session has media for.
  for (const id of Object.keys(FORMATS.session)) {
    FORMATS.session[id] = FORMATS.session[id].filter((f) => (f !== 'png' || kinds.has('screenshot')) && (f !== 'video' || kinds.has('recording')));
  }
  document.querySelector('[data-export="png"]').hidden = !kinds.has('screenshot');
  document.querySelector('[data-export="video"]').hidden = !kinds.has('recording');
  await renderSessionList();
}

const sessionUrls = [];
async function renderSessionList() {
  sessionUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const move = async (i, d) => {
    const j = i + d;
    if (j < 0 || j >= sessionMembers.length) return;
    [sessionMembers[i], sessionMembers[j]] = [sessionMembers[j], sessionMembers[i]];
    await renderSessionList();
    schedulePersist();
  };
  const remove = async (i) => {
    const [m] = sessionMembers.splice(i, 1);
    await updateCapture(m.id, (c) => { delete c.sessionId; });
    await renderSessionList();
    schedulePersist();
  };
  const items = [];
  for (const [i, m] of sessionMembers.entries()) {
    const thumb = await getBlob(m.thumbnailBlobId);
    let media = el('span', { class: 'ph', text: m.kind === 'recording' ? '▶' : '▣' });
    if (thumb) {
      const u = URL.createObjectURL(thumb);
      sessionUrls.push(u);
      media = el('img', { src: u, alt: '' });
    }
    const pending = !m.suggestionsReviewed && m.suggestedRedactions?.length;
    items.push(el('li', {},
      media,
      el('div', { class: 'meta' },
        el('strong', { text: m.title }),
        el('span', { class: 'small muted', text: [m.kind === 'recording' ? 'Recording' : 'Screenshot', new Date(m.createdAt).toLocaleTimeString(), m.context?.description].filter(Boolean).join(' · ') }),
        pending ? el('div', { class: 'small warn-text', text: `${pending} suggested redaction${pending === 1 ? '' : 's'} to review` }) : null),
      el('span', { class: 'row-actions' },
        el('button', { class: 'small', onclick: async () => { await persist(); location.href = `?capture=${encodeURIComponent(m.id)}&session=${encodeURIComponent(capture.id)}`; } }, 'Open'),
        el('button', { class: 'ghost icon', title: 'Move up', 'aria-label': `Move ${m.title} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        el('button', { class: 'ghost icon', title: 'Move down', 'aria-label': `Move ${m.title} down`, disabled: i === sessionMembers.length - 1, onclick: () => move(i, 1) }, '↓'),
        el('button', { class: 'ghost icon', title: 'Remove from this report (stays in the library)', 'aria-label': `Remove ${m.title} from the report`, onclick: () => remove(i) }, '✕'))));
  }
  $('session-list').replaceChildren(...items);
  if (!items.length) $('session-list').append(el('li', { class: 'muted small', text: 'No captures left in this session.' }));
}

/** Members whose suggested redactions haven't been reviewed. */
const sessionPendingSuggestions = () => sessionMembers.filter((m) => !m.suggestionsReviewed && m.suggestedRedactions?.length);

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
  renderTranscript();
  $('btn-guide').addEventListener('click', async () => {
    const steps = await videoEditor.generateGuide();
    if (steps === null) return;
    if (!steps.length) { toast('No clicks were recorded inside the exported range.'); return; }
    contextForm.setSteps(steps);
    toast(`Guide: ${steps.length} step${steps.length === 1 ? '' : 's'} from the recorded clicks. Edit the wording under Steps.`, 5000);
  });
}

function renderTranscript() {
  const cues = capture.captions || [];
  $('transcript-panel').hidden = !cues.length;
  $('transcript').replaceChildren(...cues.map((c) => el('li', {}, el('button', { onclick: () => videoEditor.seekTo(c.startMs), title: 'Go to this point' },
    el('span', { class: 't', text: formatDuration(c.startMs) }), el('span', { text: c.text })))));
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
  const members = capture.kind === 'session' ? sessionMembers.map((m) => m.id) : undefined;
  // Re-read first so results the service worker wrote (ServiceNow saves) aren't clobbered.
  const updated = await updateCapture(capture.id, (c) => {
    c.title = title;
    c.context = context;
    if (annotations) c.annotations = annotations;
    if (members) c.members = members;
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
  if (id === 'jira' || id === 'github') return FORMATS[capture.kind][id].slice(0, 2); // the issue + the main file
  if (id === 'webhook') return [FORMATS[capture.kind].webhook[0]];
  if (capture.kind === 'session') return ['pdf'];
  if (capture.kind === 'screenshot') return ['png'];
  return id === 's3' ? ['video', 'sidecar'] : ['video'];
}

async function setupDestinations() {
  const defaults = new Set(capture.kind === 'screenshot' ? settings.defaultScreenshotDestinations : settings.defaultRecordingDestinations);
  if (capture.servicenow) defaults.add('servicenow');
  for (const id of ['s3', 'download', 'servicenow', 'webhook', 'jira', 'github']) { // S3 first: SN defaults depend on it
    const av = await getAdapter(id).isAvailable(adapterCtx()).catch((err) => ({ available: false, reason: err.message }));
    dest[id] = { on: av.available && defaults.has(id), available: av.available, configured: av.configured !== false, reason: av.reason, touched: false };
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
    if (!d || (TRACKERS.has(id) && !d.configured)) continue;
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
    const limits = id === 'servicenow' && d.available ? describeLimits(capture.servicenow?.limits) : '';
    if (limits) box.append(el('div', { class: 'dest-reason', text: limits }));
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
        if (f === 'issue') d.formats.add(f); // the issue is what this destination makes
        const cb = el('input', { type: 'checkbox', checked: d.formats.has(f), disabled: busy || f === 'issue' });
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
  if (capture.kind === 'session') return sessionMembers.some((m) => m.annotations?.shapes?.some((sh) => sh.type === 'blur') || m.videoRedactions?.length);
  return capture.kind === 'screenshot' ? !!annotator?.hasRedaction() : !!videoEditor?.redactions.length;
}

function needsRedactionReminder(plan) {
  return settings.redactionReminder && !hasRedaction() && plan.some((p) => p.id !== 'download');
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
  const access = await requestPlanOrigins(plan, settings);
  if (!access.ok) {
    toast(`Access to ${access.origins.map((o) => o.replace('/*', '')).join(', ')} was not granted.`);
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
    toast(`Fill in ${missing.map((f) => f.label).join(', ')} before saving to ${plan.filter((p) => p.id !== 'download').map((p) => getAdapter(p.id).label).join(' or ')}.`);
    return;
  }
  const leaves = plan.some((p) => p.id !== 'download');
  if (leaves && sessionPendingSuggestions().length) {
    const n = sessionPendingSuggestions().length;
    const ok = await confirmDialog({
      title: 'Suggested redactions not reviewed',
      message: `${n} capture${n === 1 ? ' in this session has' : 's in this session have'} suggested redactions you haven't reviewed. Open ${n === 1 ? 'it' : 'them'} to redact or dismiss the suggestions.`,
      ok: 'Save anyway',
      cancel: 'Go back',
    });
    if (!ok) return;
  } else if (leaves && pendingSuggestions().length) {
    const ok = await confirmDialog({
      title: 'Suggested redactions not applied',
      message: `${describeSuggestions(pendingSuggestions())} found in this screenshot ${pendingSuggestions().length === 1 ? 'is' : 'are'} not redacted.`,
      ok: 'Save anyway',
      cancel: 'Go back',
    });
    if (!ok) return;
  } else if (needsRedactionReminder(plan)) {
    const ok = await confirmDialog({
      title: 'Check for personal data',
      message: `This ${capture.kind === 'session' ? 'session' : capture.kind === 'screenshot' ? 'screenshot' : 'recording'} has no redaction (blur/pixelate) regions. Make sure it contains no personal or sensitive data before it leaves this device.`,
      ok: 'Save anyway',
      cancel: 'Go back',
    });
    if (!ok) return;
  }

  await persist();
  setBusy(true, 'Preparing files…');
  const factory = new ExportFactory({ capture, annotator, settings, onProgress: (msg) => { $('save-status').textContent = msg; } });
  let results;
  try {
    results = await runSavePlan({ plan, factory, ctx: adapterCtx, onStatus: (msg) => setBusy(true, msg) });
  } finally {
    setBusy(false);
  }

  const mine = results.filter((r) => !r.persisted).map(toSaveRecord);
  capture = (await updateCapture(capture.id, (c) => { c.saves = [...(c.saves || []), ...mine]; })) || capture;
  await refreshThumbnail();
  renderSaves();
  if (dest.servicenow && capture.servicenow) await refreshSnAvailability();

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) logError(`save:${r.adapter}`, r.error || 'Save failed', { file: r.name, kind: capture.kind });
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

const ADAPTER_NAMES = { download: 'Downloaded', s3: 'S3', servicenow: 'ServiceNow', webhook: 'Webhook', jira: 'Jira', github: 'GitHub', editor: 'Editor' };

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
  if (fmt === 'clipboard') { copyImage(); return; }
  save([{ id: 'download', formats: [fmt] }]);
}));

// ---------------------------------------------------------------- boot

if (params.get('capture') && params.get('view') !== 'library') {
  openCapture(params.get('capture')).catch((err) => { console.error(err); toast(err.message, 8000); });
} else {
  showLibrary();
}
