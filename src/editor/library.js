// Capture library (§4): search, kind/tag/unsaved filters, re-export without opening the editor,
// and recovery of interrupted recordings (§16). Everything stays in this browser's IndexedDB.

import { listCaptures, getBlob, blobSize, deleteCapture, clearLibrary, countChunks, deleteChunks, captureBlobIds, updateCapture } from '../shared/db.js';
import { findJobs, updateJob } from '../shared/jobs.js';
import { finalizeRecording } from '../shared/captures.js';
import { getSettings } from '../shared/settings.js';
import { formatBytes, formatDuration } from '../shared/util.js';
import { ExportFactory, exportedDurationMs } from './export/files.js';
import { needsRender, renderKey } from './video-tools.js';
import { getAdapter } from '../storage/adapter.js';
import { toast, confirmDialog, el } from './ui.js';

const urls = [];
const FILTER_KEY = 'snap.libraryFilter';

function loadFilter() {
  try {
    return { q: '', kind: 'all', unsaved: false, tag: '', ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
  } catch {
    return { q: '', kind: 'all', unsaved: false, tag: '' };
  }
}
function saveFilter(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* per-viewer convenience only */ }
}

/** Lower-cased text a capture can be found by. */
export function searchText(c) {
  const ctx = c.context || {};
  return [
    c.title, ctx.description, ctx.notes, ctx.recordUrl, ...(ctx.steps || []), ...(ctx.tags || []),
    ...Object.values(ctx.custom || {}), c.servicenow?.label, c.servicenow?.table, c.servicenow?.instance,
    c.source?.url, c.source?.title,
  ].filter(Boolean).join(' \n ').toLowerCase();
}

export function matches(c, f) {
  if (f.kind !== 'all' && c.kind !== f.kind) return false;
  if (f.unsaved && (c.saves || []).some((s) => s.ok)) return false;
  if (f.tag && !(c.context?.tags || []).includes(f.tag)) return false;
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = searchText(c);
  return words.every((w) => text.includes(w));
}

async function recoverableJobs() {
  const active = (await chrome.storage.session.get('recording')).recording;
  const jobs = await findJobs((j) => ['interrupted', 'recording'].includes(j.state) && j.id !== active?.jobId);
  const out = [];
  for (const j of jobs) {
    const chunks = await countChunks(j.id);
    if (chunks) out.push({ job: j, chunks });
  }
  return out;
}

async function quickExport(capture, format, settings) {
  const factory = new ExportFactory({ capture, settings, onProgress: (msg) => toast(msg, 60_000) });
  toast(format === 'video' && needsRender(capture) && capture.rendered?.key !== renderKey(capture) ? 'Rendering video… keep this tab visible.' : 'Preparing…', 60_000);
  const adapter = getAdapter('download');
  const results = [];
  try {
    for (const file of await factory.get(format)) results.push({ ...(await adapter.save(file, { settings, capture })), at: new Date().toISOString() });
  } catch (err) {
    results.push({ adapter: 'download', ok: false, name: format, error: err.message, at: new Date().toISOString() });
  }
  await updateCapture(capture.id, (c) => {
    c.saves = [...(c.saves || []), ...results.map(({ adapter: a, ok, name, location, error, at, downloadId }) => ({ adapter: a, ok, name, location, error, at, downloadId }))];
  });
  const failed = results.find((r) => !r.ok);
  toast(failed ? `Export failed: ${failed.error}` : `Downloaded ${results.map((r) => r.name).join(', ')}`);
}

export async function renderLibrary(root, { onOpen }) {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  root.replaceChildren();
  const settings = await getSettings();
  const captures = await listCaptures();
  let total = 0;
  for (const c of captures) for (const id of captureBlobIds(c)) total += await blobSize(id);
  const filter = loadFilter();
  const rerender = () => renderLibrary(root, { onOpen });

  root.append(el('header', { class: 'lib-head' },
    el('h1', { text: 'Library' }),
    el('span', { class: 'muted', text: `${captures.length} capture${captures.length === 1 ? '' : 's'} · ${formatBytes(total)} · stored only on this device` }),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'danger',
      disabled: !captures.length,
      onclick: async () => {
        const ok = await confirmDialog({ title: 'Clear library?', message: 'All captures stored in this browser will be deleted. Files you already saved elsewhere are not affected.', ok: 'Delete all' });
        if (!ok) return;
        await clearLibrary();
        await chrome.runtime.sendMessage({ type: 'library:changed' }).catch(() => {});
        rerender();
      },
    }, 'Clear library'),
  ));

  const recover = await recoverableJobs();
  if (recover.length) {
    const list = el('ul', { class: 'recover-list' });
    for (const { job, chunks } of recover) {
      list.append(el('li', {},
        el('span', {}, el('strong', { text: job.source?.title || 'Recording' }), ' ',
          el('span', { class: 'muted', text: `${new Date(job.createdAt).toLocaleString()} · ~${formatDuration(chunks * 1000)} recorded` })),
        el('span', { class: 'spacer' }),
        el('button', {
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const capture = await finalizeRecording({
                jobId: job.id, mimeType: job.mimeType, durationMs: chunks * 1000,
                source: job.source || { url: '', title: 'Recording', dpr: 1 }, servicenow: job.servicenow, partial: true,
              });
              onOpen(capture.id);
            } catch (err) {
              toast(err.message);
              e.target.disabled = false;
            }
          },
        }, 'Recover partial recording'),
        el('button', {
          class: 'ghost',
          onclick: async () => {
            await deleteChunks(job.id);
            await updateJob(job.id, { state: 'failed' });
            rerender();
          },
        }, 'Discard'),
      ));
    }
    root.append(el('section', { class: 'recover' }, el('h2', { text: 'Interrupted recordings' }), list));
  }

  if (!captures.length) {
    root.append(el('p', { class: 'empty muted' }, 'No captures yet. Use the toolbar button or ', el('kbd', { text: 'Alt+Shift+S' }), ' to take one.'));
    return;
  }

  // ---- filters ----
  const allTags = [...new Set(captures.flatMap((c) => c.context?.tags || []))].sort();
  if (filter.tag && !allTags.includes(filter.tag)) filter.tag = '';
  const search = el('input', { type: 'search', id: 'lib-search', placeholder: 'Search title, description, notes, steps, tags, record…', value: filter.q, 'aria-label': 'Search captures' });
  const kind = el('select', { id: 'lib-kind', 'aria-label': 'Kind' },
    el('option', { value: 'all', text: 'All kinds' }), el('option', { value: 'screenshot', text: 'Screenshots' }), el('option', { value: 'recording', text: 'Recordings' }));
  kind.value = filter.kind;
  const unsaved = el('input', { type: 'checkbox', id: 'lib-unsaved', checked: filter.unsaved });
  const tagBar = el('div', { class: 'tag-filter' });
  const renderTagBar = () => {
    tagBar.replaceChildren(...allTags.map((t) => el('button', {
      class: `chip${filter.tag === t ? ' on' : ''}`,
      'aria-pressed': String(filter.tag === t),
      onclick: () => { filter.tag = filter.tag === t ? '' : t; renderTagBar(); apply(); },
    }, `#${t}`)));
  };
  renderTagBar();
  const count = el('span', { class: 'muted small', id: 'lib-count' });
  root.append(el('div', { class: 'lib-filters' },
    search, kind, el('label', { class: 'check' }, unsaved, 'Not saved anywhere'), count), allTags.length ? tagBar : null);

  // ---- cards ----
  const grid = el('ul', { class: 'lib-grid' });
  const cards = [];
  for (const c of captures) {
    const thumb = await getBlob(c.thumbnailBlobId);
    let media;
    if (thumb) {
      const u = URL.createObjectURL(thumb);
      urls.push(u);
      media = el('img', { src: u, alt: '' });
    } else {
      media = el('div', { class: 'ph', text: c.kind === 'recording' ? '▶' : '▣' });
    }
    const okSaves = (c.saves || []).filter((s) => s.ok);
    const where = [...new Set(okSaves.map((s) => s.adapter))];
    const formats = c.kind === 'screenshot' ? [['png', 'PNG'], ['pdf', 'PDF report']] : [['video', 'Video'], ['pdf', 'PDF report'], ['sidecar', '.md + .json']];
    const menu = el('div', { class: 'menu-list card-menu', role: 'menu', hidden: true },
      ...formats.map(([f, label]) => el('button', {
        role: 'menuitem',
        onclick: async (e) => { e.stopPropagation(); menu.hidden = true; await quickExport(c, f, settings); rerender(); },
      }, `Download ${label}`)),
      el('button', { role: 'menuitem', onclick: () => onOpen(c.id) }, 'Open in editor'),
      el('button', {
        role: 'menuitem',
        class: 'danger',
        onclick: async (e) => {
          e.stopPropagation();
          menu.hidden = true;
          if (!okSaves.length) {
            const ok = await confirmDialog({ title: 'Delete capture?', message: 'This capture has not been saved anywhere else. It will be gone for good.', ok: 'Delete' });
            if (!ok) return;
          }
          await deleteCapture(c.id);
          await chrome.runtime.sendMessage({ type: 'library:changed' }).catch(() => {});
          rerender();
        },
      }, 'Delete'));
    const durationMs = c.kind === 'recording' && c.source?.durationMs ? exportedDurationMs(c) : 0;
    const card = el('li', { class: 'card', 'data-id': c.id },
      el('button', { class: 'card-open', onclick: () => onOpen(c.id), title: 'Open in editor' },
        el('div', { class: 'thumb' }, media, c.kind === 'recording' ? el('span', { class: 'badge', text: durationMs ? formatDuration(durationMs) : 'Video' }) : null),
        el('div', { class: 'card-body' },
          el('div', { class: 'card-title', text: c.title }),
          el('div', { class: 'muted small', text: [new Date(c.createdAt).toLocaleString(), c.context?.description].filter(Boolean).join(' · ') }),
          el('div', { class: 'chips' },
            where.length ? where.map((w) => el('span', { class: 'chip', text: w === 'servicenow' ? 'ServiceNow' : w === 's3' ? 'S3' : 'Downloaded' }))
              : el('span', { class: 'chip warn', text: 'Not saved anywhere' }),
            (c.context?.tags || []).map((t) => el('span', { class: 'chip tag-chip', text: `#${t}` }))),
        )),
      el('div', { class: 'menu card-actions' },
        el('button', {
          class: 'card-more', title: 'Export / delete', 'aria-label': `Actions for ${c.title}`, 'aria-haspopup': 'true',
          onclick: (e) => {
            e.stopPropagation();
            const wasHidden = menu.hidden;
            document.querySelectorAll('.card-menu').forEach((m) => { m.hidden = true; });
            menu.hidden = !wasHidden;
          },
        }, '⋯'),
        menu));
    cards.push({ capture: c, card });
    grid.append(card);
  }
  const empty = el('p', { class: 'empty muted', hidden: true, text: 'No captures match.' });
  root.append(grid, empty);
  document.addEventListener('click', () => document.querySelectorAll('.card-menu').forEach((m) => { m.hidden = true; }));

  function apply() {
    let shown = 0;
    for (const { capture, card } of cards) {
      const ok = matches(capture, filter);
      card.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = shown === cards.length ? '' : `${shown} of ${cards.length}`;
    empty.hidden = shown > 0;
    saveFilter(filter);
  }
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filter.q = search.value; apply(); }, 120); });
  kind.addEventListener('change', () => { filter.kind = kind.value; apply(); });
  unsaved.addEventListener('change', () => { filter.unsaved = unsaved.checked; apply(); });
  apply();
}
