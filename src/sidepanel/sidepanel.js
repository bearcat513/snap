// Side panel library (§6): recent captures next to the page, ready to drag into a ticket, chat or
// email as files. Screenshots are flattened with their annotations and redactions; recordings are
// offered as the exported video when no re-render is needed (or the last render is still current).

import { listCaptures, getBlob } from '../shared/db.js';
import { captureBaseName, extensionForMime } from '../shared/naming.js';
import { getSettings } from '../shared/settings.js';
import { formatDuration } from '../shared/util.js';
import { headlessAnnotator, exportedDurationMs } from '../editor/export/files.js';
import { needsRender, renderKey } from '../editor/video-tools.js';
import { toast, el } from '../editor/ui.js';
import '../ui/theme.js';
import '../ui/i18n.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();
const files = new Map(); // capture id → File (prepared ahead: dragstart can't wait)
const urls = [];
let signature = '';

/** The file a capture is dragged as, or null if it needs exporting in the editor first. */
async function fileFor(c) {
  if (files.has(c.id)) return files.get(c.id);
  const base = captureBaseName(c, settings);
  let file = null;
  if (c.kind === 'screenshot') {
    const canvas = (await headlessAnnotator(c)).exportCanvas();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    file = new File([blob], `${base}.png`, { type: 'image/png' });
  } else if (c.kind === 'recording') {
    const blob = !needsRender(c) ? await getBlob(c.originalBlobId)
      : c.rendered?.key === renderKey(c) ? await getBlob(c.rendered.blobId) : null;
    if (blob) {
      const type = blob.type.split(';')[0];
      file = new File([blob], `${base}.${extensionForMime(type)}`, { type });
    }
  }
  files.set(c.id, file);
  return file;
}

async function copy(c) {
  try {
    const file = await fileFor(c);
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
    toast('Copied.');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

const openInEditor = (id) => chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/editor.html?capture=${encodeURIComponent(id)}`) });

async function render() {
  const captures = (await listCaptures(20)).filter((c) => c.kind !== 'session');
  const sig = captures.map((c) => `${c.id}:${c.thumbnailBlobId}:${(c.saves || []).length}`).join('|');
  if (sig === signature) return;
  signature = sig;
  files.clear();
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  $('empty').hidden = captures.length > 0;
  const items = [];
  for (const c of captures) {
    const thumb = await getBlob(c.thumbnailBlobId);
    let media = el('div', { class: 'thumb ph', text: c.kind === 'recording' ? '▶' : '▣' });
    if (thumb) {
      const u = URL.createObjectURL(thumb);
      urls.push(u);
      media = el('img', { class: 'thumb', src: u, alt: '', draggable: 'false' });
    }
    const item = el('li', { class: 'item', draggable: 'true', title: 'Drag into another page, or use Copy' },
      media,
      el('div', { class: 'body' },
        el('span', { class: 'title', text: c.title }),
        el('div', { class: 'row' },
          el('span', { class: 'small muted', text: [c.kind === 'recording' ? `Video ${formatDuration(exportedDurationMs(c))}` : 'Screenshot', new Date(c.createdAt).toLocaleTimeString()].join(' · ') }),
          el('span', { class: 'spacer' }),
          c.kind === 'screenshot' ? el('button', { class: 'small', onclick: () => copy(c) }, 'Copy') : null,
          el('button', { class: 'small ghost', onclick: () => openInEditor(c.id) }, 'Open'))));
    item.addEventListener('dragstart', (e) => {
      const file = files.get(c.id);
      if (!file) {
        e.preventDefault();
        toast(c.kind === 'recording' ? 'Export this video in the editor first (it has trims or redactions).' : 'Still preparing… try again in a moment.');
        return;
      }
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.items.add(file);
      // Desktop / file-manager drops.
      const u = URL.createObjectURL(file);
      urls.push(u);
      e.dataTransfer.setData('DownloadURL', `${file.type}:${file.name}:${u}`);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    items.push(item);
  }
  $('list').replaceChildren(...items);
  // Prepare files in the background so a drag can start immediately.
  for (const c of captures) await fileFor(c).catch(() => files.set(c.id, null));
}

$('btn-library').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?view=library') }));
window.addEventListener('focus', render);
setInterval(() => { if (document.visibilityState === 'visible') render(); }, 4000);
render();
