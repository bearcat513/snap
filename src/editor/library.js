// Capture library (§4): search, kind/tag/unsaved filters, re-export without opening the editor,
// and recovery of interrupted recordings (§16). Everything stays in this browser's IndexedDB.

import { listCaptures, getBlob, putBlob, blobSize, deleteCapture, clearLibrary, countChunks, deleteChunks, captureBlobIds, updateCapture } from '../shared/db.js';
import { buildZip, uniqueName } from '../shared/zip.js';
import { formatDate } from '../shared/naming.js';
import { findJobs, updateJob } from '../shared/jobs.js';
import { finalizeRecording } from '../shared/captures.js';
import { getSettings } from '../shared/settings.js';
import { formatBytes, formatDuration } from '../shared/util.js';
import { ExportFactory, exportedDurationMs } from './export/files.js';
import { needsRender, renderKey } from './video-tools.js';
import { getAdapter, SAVE_ORDER, requestPlanOrigins } from '../storage/adapter.js';
import { pendingFailures, retryPlan, toSaveRecord } from '../shared/saves.js';
import { logError } from '../shared/diagnostics.js';
import { runSavePlan } from './save-runner.js';
import { createComparison } from './compare.js';
import { toast, confirmDialog, el } from './ui.js';

const urls = [];
const FILTER_KEY = 'snap.libraryFilter';
const DEST_NAMES = { servicenow: 'ServiceNow', s3: 'S3', download: 'Downloaded', webhook: 'Webhook', jira: 'Jira', github: 'GitHub' };

function loadFilter() {
  try {
    return { q: '', kind: 'all', unsaved: false, failed: false, tag: '', ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
  } catch {
    return { q: '', kind: 'all', unsaved: false, failed: false, tag: '' };
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
    c.source?.url, c.source?.title, ...(c.captions || []).map((cue) => cue.text),
  ].filter(Boolean).join(' \n ').toLowerCase();
}

export function matches(c, f) {
  if (f.kind !== 'all' && c.kind !== f.kind) return false;
  if (f.unsaved && (c.saves || []).some((s) => s.ok)) return false;
  if (f.failed && !pendingFailures(c).length) return false;
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

/**
 * Every capture in one ZIP: its media (annotated PNG / rendered video) plus the .md/.json sidecar.
 * Sessions add only their report; their members are in the archive on their own.
 */
async function downloadAll(captures, settings) {
  const adapter = getAdapter('download');
  const av = await adapter.isAvailable({ settings });
  if (!av.available) { toast(av.reason); return; }
  const entries = [];
  const taken = new Set();
  const included = [];
  const problems = [];
  for (const [i, capture] of captures.entries()) {
    const progress = (msg) => toast(`${i + 1} of ${captures.length}: ${msg || 'Preparing…'}`, 60_000);
    progress();
    const factory = new ExportFactory({ capture, settings, onProgress: progress });
    const formats = capture.kind === 'screenshot' ? ['png', 'sidecar'] : capture.kind === 'recording' ? ['video', 'sidecar'] : ['sidecar'];
    try {
      const files = [];
      for (const f of formats) files.push(...(await factory.get(f)));
      for (const file of files) {
        const blob = await getBlob(file.blobId);
        if (!blob) throw new Error(`${file.name} is missing`);
        entries.push({ name: uniqueName(file.name, taken), data: blob, date: new Date(capture.createdAt) });
      }
      included.push(capture.id);
    } catch (err) {
      problems.push(`${capture.title}: ${err.message}`);
      logError('library:download-all', err.message, { capture: capture.id });
    }
  }
  if (!entries.length) { toast(`Nothing to download. ${problems[0] || ''}`, 8000); return; }
  toast('Building ZIP…', 60_000);
  let result;
  try {
    const zip = await buildZip(entries);
    const file = { name: `snap-library_${formatDate(new Date(), 'yyyyMMdd-HHmmss')}.zip`, mimeType: zip.type, size: zip.size, blobId: await putBlob(zip, { ephemeral: true }) };
    result = { ...(await adapter.save(file, { settings })), at: new Date().toISOString() };
  } catch (err) {
    result = { adapter: 'download', ok: false, name: 'library ZIP', error: err.message };
  }
  if (!result.ok) { toast(`Download failed: ${result.error}`, 8000); return; }
  const { adapter: a, ok, name, location, at, downloadId } = result;
  for (const id of included) await updateCapture(id, (c) => { c.saves = [...(c.saves || []), { adapter: a, ok, name, location, at, downloadId }]; });
  toast([`Downloaded ${included.length} capture${included.length === 1 ? '' : 's'} as ${name}.`,
    problems.length ? `${problems.length} left out — ${problems[0]}` : ''].join(' '), 8000);
}

const snContextOf = (c) => (c.servicenow
  ? { instance: c.servicenow.instance, table: c.servicenow.table, sysId: c.servicenow.sysId, label: c.servicenow.label }
  : undefined);

/** Redo the saves whose latest attempt failed. Call straight from a click (S3 may prompt for access). */
async function retryFailed(capture, settings) {
  const plan = retryPlan(capture, SAVE_ORDER);
  // No await before this: the permission prompt needs the click's user gesture.
  const granted = requestPlanOrigins(plan, settings).then((r) => r.ok);
  const ctx = () => ({ settings, capture, snContext: snContextOf(capture) });
  const ready = [];
  const skipped = [];
  for (const step of plan) {
    let av = await getAdapter(step.id).isAvailable(ctx()).catch((err) => ({ available: false, reason: err.message }));
    if (av.available && getAdapter(step.id).permissionOrigin?.(settings) && !(await granted)) av = { available: false, reason: 'Access was not granted.' };
    if (av.available) ready.push(step);
    else skipped.push(`${getAdapter(step.id).label}: ${av.reason}${step.id === 'servicenow' ? ' Keep the record open in its tab, or run /snap again.' : ''}`);
  }
  if (!ready.length) { toast(skipped.join(' ') || 'Nothing to retry.', 8000); return; }
  toast('Retrying…', 60_000);
  const factory = new ExportFactory({ capture, settings, onProgress: (msg) => toast(msg, 60_000) });
  const results = await runSavePlan({ plan: ready, factory, ctx, onStatus: (msg) => toast(msg, 60_000) });
  const mine = results.filter((r) => !r.persisted).map(toSaveRecord);
  await updateCapture(capture.id, (c) => { c.saves = [...(c.saves || []), ...mine]; });
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) logError(`retry:${r.adapter}`, r.error || 'Save failed', { file: r.name });
  toast([failed.length ? `${failed.length} of ${results.length} still failing: ${failed[0].error}` : `Retried ${results.length} file${results.length === 1 ? '' : 's'}.`, ...skipped].join(' '), 8000);
}

/** Storage meter (§5.7): library size against Settings → Library and the browser's own quota. */
async function storageMeter(captures, total, settings) {
  const maxBytes = settings['library.maxMB'] * 1024 * 1024;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const pct = Math.min(100, (100 * total) / maxBytes);
  const unsaved = captures.filter((c) => !(c.saves || []).some((s) => s.ok));
  const over = total > maxBytes || captures.length > settings['library.maxItems'];
  const bar = el('div', { class: `meter${over ? ' over' : pct > 80 ? ' near' : ''}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(maxBytes), 'aria-valuenow': String(total), 'aria-label': 'Library storage used' },
    el('span', { style: `width:${pct}%` }));
  const lines = [`${formatBytes(total)} of ${formatBytes(maxBytes)} library limit · ${captures.length} of ${settings['library.maxItems']} captures`];
  if (est?.quota) lines.push(`browser storage: ${formatBytes(est.usage)} used of ${formatBytes(est.quota)} available to the extension`);
  let warning = null;
  if (over && unsaved.length) {
    warning = el('p', { class: 'small warn-text', text: `Over the limit. ${unsaved.length} capture${unsaved.length === 1 ? ' has' : 's have'} never been saved, so ${unsaved.length === 1 ? 'it is' : 'they are'} kept: save or delete ${unsaved.length === 1 ? 'it' : 'them'} to free space.` });
  } else if (pct > 80 && unsaved.length) {
    warning = el('p', { class: 'small warn-text', text: `Nearly full. Saved captures are removed oldest first; the ${unsaved.length} unsaved one${unsaved.length === 1 ? ' is' : 's are'} never removed automatically.` });
  }
  return el('section', { class: 'storage' }, bar, el('p', { class: 'small muted', text: lines.join(' · ') }), warning);
}

const compare = { on: false, picked: [] }; // before/after selection mode

export async function renderLibrary(root, { onOpen }) {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  root.replaceChildren();
  const settings = await getSettings();
  const captures = await listCaptures();
  let total = 0;
  for (const c of captures) for (const id of captureBlobIds(c)) total += await blobSize(id);
  const filter = loadFilter();
  const rerender = () => renderLibrary(root, { onOpen });

  const failing = captures.filter((c) => pendingFailures(c).length).length;
  root.append(el('header', { class: 'lib-head' },
    el('h1', { text: 'Library' }),
    el('span', { class: 'muted', text: `${captures.length} capture${captures.length === 1 ? '' : 's'} · stored only on this device${failing ? ` · ${failing} with failed saves` : ''}` }),
    el('div', { class: 'spacer' }),
    el('button', {
      id: 'btn-compare',
      'aria-pressed': String(compare.on),
      title: 'Pick two screenshots to show side by side',
      disabled: captures.filter((c) => c.kind === 'screenshot').length < 2,
      onclick: () => { compare.on = !compare.on; compare.picked = []; rerender(); },
    }, compare.on ? 'Cancel compare' : 'Compare…'),
    el('button', {
      id: 'btn-download-all',
      title: 'Download every capture (media + .md/.json) as one ZIP',
      disabled: !captures.length,
      onclick: async (e) => {
        e.target.disabled = true;
        try { await downloadAll(captures, settings); } finally { rerender(); }
      },
    }, 'Download all'),
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

  if (captures.length) root.append(await storageMeter(captures, total, settings));

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
  if (!failing) filter.failed = false; // its checkbox is only shown while something is failing
  const search = el('input', { type: 'search', id: 'lib-search', placeholder: 'Search title, description, notes, steps, tags, record…', value: filter.q, 'aria-label': 'Search captures' });
  const kind = el('select', { id: 'lib-kind', 'aria-label': 'Kind' },
    el('option', { value: 'all', text: 'All kinds' }), el('option', { value: 'screenshot', text: 'Screenshots' }), el('option', { value: 'recording', text: 'Recordings' }),
    el('option', { value: 'session', text: 'Sessions' }));
  kind.value = filter.kind;
  const unsaved = el('input', { type: 'checkbox', id: 'lib-unsaved', checked: filter.unsaved });
  const failedOnly = el('input', { type: 'checkbox', id: 'lib-failed', checked: filter.failed });
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
    search, kind, el('label', { class: 'check' }, unsaved, 'Not saved anywhere'),
    failing ? el('label', { class: 'check' }, failedOnly, `Failed saves (${failing})`) : null, count), allTags.length ? tagBar : null);

  if (compare.on) {
    const n = compare.picked.length;
    const make = (layout) => async () => {
      try {
        const [a, b] = compare.picked.map((id) => captures.find((c) => c.id === id));
        const capture = await createComparison(a, b, layout);
        compare.on = false;
        compare.picked = [];
        await chrome.runtime.sendMessage({ type: 'library:changed' }).catch(() => {});
        onOpen(capture.id);
      } catch (err) {
        toast(`Compare failed: ${err.message}`);
      }
    };
    root.append(el('div', { class: 'compare-bar', role: 'status' },
      el('span', { text: n < 2 ? `Pick ${2 - n} more screenshot${n === 1 ? '' : 's'} to compare. The older one is “Before”.` : 'Ready to compare.' }),
      el('span', { class: 'spacer' }),
      el('button', { disabled: n < 2, onclick: make('side') }, 'Side by side'),
      el('button', { disabled: n < 2, onclick: make('stacked') }, 'Stacked')));
  }

  // ---- cards ----
  const byId = new Map(captures.map((c) => [c.id, c]));
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
      media = el('div', { class: 'ph', text: c.kind === 'recording' ? '▶' : c.kind === 'session' ? '❐' : '▣' });
    }
    const okSaves = (c.saves || []).filter((s) => s.ok);
    const failures = pendingFailures(c);
    const where = [...new Set(okSaves.map((s) => s.adapter))];
    const formats = c.kind === 'screenshot' ? [['png', 'PNG'], ['pdf', 'PDF report'], ['sidecar', '.md + .json']]
      : c.kind === 'session' ? [['pdf', 'PDF report'], ['sidecar', '.md + .json']]
        : [['video', 'Video'], ['gif', 'GIF'], ['frames', 'frames ZIP (1 PNG/s + video + .md)'], ['pdf', 'PDF report'], ['sidecar', '.md + .json']];
    const menu = el('div', { class: 'menu-list card-menu', role: 'menu', hidden: true },
      ...formats.map(([f, label]) => el('button', {
        role: 'menuitem',
        onclick: async (e) => { e.stopPropagation(); menu.hidden = true; await quickExport(c, f, settings); rerender(); },
      }, `Download ${label}`)),
      failures.length ? el('button', {
        role: 'menuitem',
        onclick: async (e) => { e.stopPropagation(); menu.hidden = true; await retryFailed(c, settings); rerender(); },
      }, `Retry failed saves (${failures.length})`) : null,
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
    const pickable = compare.on && c.kind === 'screenshot';
    const picked = compare.picked.includes(c.id);
    const open = () => {
      if (!compare.on) { onOpen(c.id); return; }
      if (!pickable) return;
      compare.picked = picked ? compare.picked.filter((x) => x !== c.id) : [...compare.picked, c.id].slice(-2);
      rerender();
    };
    const card = el('li', { class: `card${picked ? ' picked' : ''}${compare.on && !pickable ? ' dim' : ''}`, 'data-id': c.id },
      el('button', { class: 'card-open', onclick: open, title: compare.on ? (pickable ? 'Pick for comparison' : 'Only screenshots can be compared') : 'Open in editor', 'aria-pressed': compare.on ? String(picked) : null },
        el('div', { class: 'thumb' }, media,
          c.kind === 'recording' ? el('span', { class: 'badge', text: durationMs ? formatDuration(durationMs) : 'Video' }) : null,
          c.kind === 'session' ? el('span', { class: 'badge', text: `${(c.members || []).length} captures` }) : null),
        el('div', { class: 'card-body' },
          el('div', { class: 'card-title', text: c.title }),
          el('div', { class: 'muted small', text: [new Date(c.createdAt).toLocaleString(), c.context?.description].filter(Boolean).join(' · ') }),
          el('div', { class: 'chips' },
            where.length ? where.map((w) => el('span', { class: 'chip', text: DEST_NAMES[w] || w }))
              : el('span', { class: 'chip warn', text: 'Not saved anywhere' }),
            c.sessionId && byId.has(c.sessionId) ? el('span', { class: 'chip', title: byId.get(c.sessionId).title, text: 'In session' }) : null,
            failures.length ? el('span', { class: 'chip fail', title: failures.map((f) => `${DEST_NAMES[f.adapter] || f.adapter}: ${f.error}`).join('\n'), text: 'Save failed' }) : null,
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
  failedOnly.addEventListener('change', () => { filter.failed = failedOnly.checked; apply(); });
  apply();
}
