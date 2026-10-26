// /snap-lite's editor: a full-screen modal in a shadow root over the ServiceNow page, built
// from the extension's Annotator and ContextForm. Resolves when the files are attached or the user
// cancels.

import { Annotator } from '../src/editor/canvas.js';
import { ContextForm } from '../src/editor/context-form.js';
import { el } from '../src/editor/ui.js';
import { applyTemplate, templateForTable } from '../src/shared/settings.js';
import { attachmentProblem, describeLimits, snErrorMessage, workNoteText } from '../src/shared/sn.js';
import { attach, addWorkNote } from './servicenow.js';
import { buildFiles } from './report.js';
import commonCss from '../src/ui/common.css';
import liteCss from './lite.css';

const TOOLS = [
  ['select', '⬉', 'Select', 'V'], ['crop', '⛶', 'Crop', 'C'], ['arrow', '↗', 'Arrow', 'A'], ['rect', '▭', 'Box', 'R'],
  ['ellipse', '◯', 'Ellipse', 'E'], ['pen', '✎', 'Pen', 'P'], ['text', 'T', 'Text', 'T'], ['highlight', '▮', 'Highlight', 'H'],
  ['step', '①', 'Step', 'N'], ['blur', '▒', 'Redact', 'B'],
];
const KEY_TOOLS = Object.fromEntries(TOOLS.map(([id, , , key]) => [key.toLowerCase(), id]));
const COLORS = ['#e5484d', '#f76b15', '#ffd60a', '#30a46c', '#2563eb', '#111111', '#ffffff'];
const WIDTHS = [2, 4, 8];

const MARKUP = `
  <div class="app" role="dialog" aria-modal="true" aria-label="Snap Lite">
    <header class="topbar">
      <input id="title" class="title-input" type="text" aria-label="Title">
      <span class="spacer"></span>
      <span id="status" class="small muted" role="status"></span>
      <button id="btn-cancel">Cancel</button>
      <button id="btn-attach" class="primary">Attach to record</button>
    </header>
    <div id="suggest-banner" class="suggest-banner" hidden>
      <span id="suggest-text"></span>
      <button id="btn-suggest-all" class="small">Redact all</button>
      <button id="btn-suggest-review" class="small" aria-pressed="false">Review</button>
      <button id="btn-suggest-dismiss" class="small ghost">Dismiss</button>
    </div>
    <div class="layout">
      <nav class="tools" aria-label="Tools">
        <div class="tool-group" id="tool-buttons"></div>
        <div class="tool-group swatches" id="swatches"></div>
        <div class="tool-group widths" id="widths"></div>
        <div class="tool-group">
          <button id="btn-undo" title="Undo (Ctrl+Z)">↶<span>Undo</span></button>
          <button id="btn-redo" title="Redo (Ctrl+Shift+Z)">↷<span>Redo</span></button>
          <button id="btn-delete" title="Delete selected (Del)">🗑<span>Delete</span></button>
        </div>
      </nav>
      <main class="stage" id="stage">
        <div class="canvas-wrap"><canvas id="canvas"></canvas></div>
        <textarea id="text-input" class="text-input" rows="1" hidden></textarea>
      </main>
      <aside class="sidebar">
        <section>
          <div class="section-head">
            <h2>Context</h2>
            <div class="menu">
              <button id="btn-template" class="small" aria-haspopup="true">Template ▾</button>
              <div id="template-menu" class="menu-list" role="menu" hidden></div>
            </div>
          </div>
          <label class="field"><span>Record URL</span><input id="ctx-recordUrl" type="url" placeholder="https://…"></label>
          <label class="field"><span>Description</span>
            <input id="ctx-description" type="text" placeholder="One line: what's wrong / what this shows"></label>
          <div class="field">
            <span class="field-label">Steps to reproduce</span>
            <ol id="steps" class="steps"></ol>
            <button id="btn-add-step" class="small">＋ Add step</button>
          </div>
          <label class="field"><span>Notes</span><textarea id="ctx-notes" rows="4" placeholder="Expected vs actual, anything else"></textarea></label>
          <div id="custom-fields"></div>
          <div class="field">
            <label for="tag-input" class="field-label">Tags</label>
            <div class="tag-box"><span id="tags" class="tags"></span><input id="tag-input" type="text" list="tag-suggestions" placeholder="Add tag…"></div>
            <datalist id="tag-suggestions"></datalist>
          </div>
        </section>
        <section>
          <h2>Attach</h2>
          <label class="check"><input id="fmt-pdf" type="checkbox" checked> PDF report</label>
          <label class="check"><input id="fmt-png" type="checkbox" checked> Annotated PNG</label>
          <label class="check"><input id="work-note" type="checkbox"> Post a work note</label>
          <p id="limits" class="small muted"></p>
          <ul id="results" class="results small"></ul>
        </section>
      </aside>
    </div>
  </div>`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * shot: { bitmap, suggestions, dpr } from capture(); record: { table, sysId, label, recordUrl, user,
 * token }; instance: { limits, settings } from readInstance(). Resolves true if anything was attached.
 */
export function openEditor({ shot, record, instance }) {
  const { settings, limits } = instance;
  const host = document.createElement('div');
  host.setAttribute('data-snap-lite', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${liteCss.replace('/* common.css */', commonCss.replace(/:root/g, ':host').replace(/html, body/g, ':host'))}</style>${MARKUP}`;
  const $ = (id) => root.getElementById(id);
  const createdAt = new Date();
  const restoreScroll = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.appendChild(host);

  const annotator = new Annotator($('canvas'), shot.bitmap, { unit: shot.dpr });
  const form = new ContextForm({ settings, root });
  let context = { recordUrl: record.recordUrl, description: '', notes: '', steps: [], tags: [], custom: {} };
  const auto = templateForTable(settings.templates, record.table);
  if (auto) context = applyTemplate(context, auto);
  form.set(context);
  $('title').value = `${record.label} (${record.table})`;
  $('work-note').checked = settings.workNote;
  $('limits').textContent = describeLimits(limits);

  // ---- tools ----
  $('tool-buttons').append(...TOOLS.map(([id, glyph, label, key]) => el('button', { 'data-tool': id, title: `${label} (${key})`, onclick: () => annotator.setTool(id) }, glyph, el('span', { text: label }))));
  $('swatches').append(...COLORS.map((c) => el('button', { 'data-color': c, style: `--c:${c}`, title: c, 'aria-label': `Color ${c}`, onclick: () => { annotator.setColor(c); sync(); } })));
  $('widths').append(...WIDTHS.map((w) => el('button', { 'data-width': w, title: `Width ${w}`, 'aria-label': `Stroke width ${w}`, onclick: () => { annotator.setStrokeWidth(w * annotator.unit); sync(); } }, el('i', { style: `height:${w}px` }))));
  annotator.setStrokeWidth(4 * annotator.unit);
  $('btn-undo').addEventListener('click', () => annotator.undo());
  $('btn-redo').addEventListener('click', () => annotator.redo());
  $('btn-delete').addEventListener('click', () => annotator.deleteSelected());

  function sync() {
    root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === annotator.tool));
    root.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === annotator.color));
    root.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) * annotator.unit === annotator.strokeWidth));
    $('btn-undo').disabled = !annotator.canUndo;
    $('btn-redo').disabled = !annotator.canRedo;
    $('btn-delete').disabled = !annotator.selected;
  }
  annotator.addEventListener('change', sync);
  annotator.addEventListener('select', sync);
  sync();

  // ---- text ----
  let textState = null;
  const ta = $('text-input');
  function openText({ id, x, y, text = '', size, color }) {
    commitText();
    const c = annotator.toClient({ x, y });
    const canvas = $('canvas');
    textState = { id, x, y };
    ta.value = text;
    ta.style.left = `${canvas.offsetLeft + canvas.parentElement.offsetLeft + c.x}px`;
    ta.style.top = `${canvas.offsetTop + canvas.parentElement.offsetTop + c.y}px`;
    ta.style.fontSize = `${Math.max(12, (size || 18 * annotator.unit) * c.scale)}px`;
    ta.style.borderColor = color || annotator.color;
    ta.hidden = false;
    autosize();
    setTimeout(() => ta.focus(), 0);
  }
  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    ta.style.width = 'auto';
    ta.style.width = `${Math.max(120, ta.scrollWidth + 8)}px`;
  }
  function commitText(cancel = false) {
    if (!textState || ta.hidden) return;
    const { id, x, y } = textState;
    textState = null;
    ta.hidden = true;
    if (cancel) return;
    if (id) annotator.updateText(id, ta.value);
    else annotator.addText(x, y, ta.value);
  }
  ta.addEventListener('input', autosize);
  ta.addEventListener('blur', () => commitText());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitText(true); }
  });
  annotator.addEventListener('text-request', (e) => openText(e.detail));
  annotator.addEventListener('text-edit', (e) => openText(e.detail));

  // ---- suggested redactions ----
  let suggestions = shot.suggestions || [];
  let reviewing = false;
  function renderSuggestions() {
    $('suggest-banner').hidden = !suggestions.length;
    if (!suggestions.length) { reviewing = false; annotator.setHints([]); return; }
    $('suggest-text').textContent = `Found ${plural(suggestions.length, 'thing')} that may be sensitive. ${reviewing ? 'Click an outlined area to redact it.' : 'Nothing is hidden until you choose.'}`;
    $('btn-suggest-review').setAttribute('aria-pressed', String(reviewing));
    annotator.setHints(reviewing ? suggestions : []);
  }
  function accept(indexes) {
    const picked = new Set(indexes);
    annotator.addShapes(suggestions.filter((_, i) => picked.has(i)).map(({ x, y, w, h }) => ({ type: 'blur', props: { x, y, w, h, mode: annotator.blurMode } })));
    suggestions = suggestions.filter((_, i) => !picked.has(i));
    renderSuggestions();
  }
  $('btn-suggest-all').addEventListener('click', () => accept(suggestions.map((_, i) => i)));
  $('btn-suggest-review').addEventListener('click', () => { reviewing = !reviewing; renderSuggestions(); });
  $('btn-suggest-dismiss').addEventListener('click', () => { suggestions = []; renderSuggestions(); });
  annotator.addEventListener('hint-click', (e) => accept([e.detail.index]));
  renderSuggestions();

  // ---- keys: handled here, and kept away from the page's own shortcuts ----
  root.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && !typing) close(false);
    else if (!typing && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) annotator.redo(); else annotator.undo(); }
    else if (!typing && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); annotator.redo(); }
    else if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); annotator.deleteSelected(); }
    else if (!typing && !mod && KEY_TOOLS[e.key.toLowerCase()]) annotator.setTool(KEY_TOOLS[e.key.toLowerCase()]);
  });
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());

  // ---- attach ----
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let attached = false;

  function close(result) {
    commitText(true);
    host.remove();
    document.documentElement.style.overflow = restoreScroll;
    shot.bitmap.close?.();
    resolveDone(result);
  }
  $('btn-cancel').addEventListener('click', () => close(attached));

  const status = (msg) => { $('status').textContent = msg; };

  $('btn-attach').addEventListener('click', async () => {
    commitText();
    const formats = ['pdf', 'png'].filter((f) => $(`fmt-${f}`).checked);
    if (!formats.length) return status('Pick at least one format.');
    const missing = form.missingRequired();
    if (missing.length) { form.markMissing(missing); return status(`Fill in ${missing.map((f) => f.label).join(', ')}.`); }
    if (suggestions.length && !annotator.hasRedaction()
      && !confirm(`${plural(suggestions.length, 'possible sensitive item')} not redacted. Attach anyway?`)) return;

    $('btn-attach').disabled = true;
    status('Building files…');
    try {
      const ctx = form.get();
      const files = await buildFiles({ canvas: annotator.exportCanvas(), title: $('title').value.trim() || record.label, context: ctx, record, settings, formats, createdAt, dpr: shot.dpr });
      const rejected = files.map((f) => attachmentProblem({ name: f.name, size: f.blob.size }, limits)).filter(Boolean);
      if (rejected.length) { status(''); renderResults(rejected.map((error) => ({ ok: false, error }))); return; }
      status('Attaching…');
      const results = [];
      for (const f of files) results.push(await attach(record.token, record, f.name, f.mimeType, f.blob));
      const ok = results.filter((r) => r.ok);
      if (ok.length && $('work-note').checked) {
        const noted = await addWorkNote(record.token, record, workNoteText({ capture: { context: ctx }, files: ok }));
        if (!noted) results.push({ ok: false, name: 'Work note', error: 'Could not post the work note.' });
      }
      renderResults(results);
      if (ok.length) attached = true;
      if (ok.length === results.length) {
        notify(`Snap Lite: attached ${plural(ok.length, 'file')}`);
        close(true);
        return;
      }
      status(ok.length ? 'Some files were not attached.' : 'Nothing was attached.');
    } catch (err) {
      status(`Failed: ${err.message}`);
    } finally {
      $('btn-attach').disabled = false;
    }
  });

  function renderResults(results) {
    $('results').replaceChildren(...results.map((r) => el('li', { class: r.ok ? 'ok' : 'error' },
      r.ok ? `✓ ${r.name}` : `✕ ${r.name ? `${r.name}: ` : ''}${snErrorMessage(r.error)}`)));
  }

  setTimeout(() => $('btn-attach').focus(), 0);
  return done;
}

function notify(msg) {
  const ui = window.GlideUI || document.querySelector('iframe#gsft_main')?.contentWindow?.GlideUI;
  try { ui?.get().addOutputMessage({ msg, type: 'success' }); } catch { /* Next Experience has no GlideUI */ }
}
