// Files /snap-lite attaches: the annotated PNG and a PDF report laid out like the extension's.

import { buildPdf } from '../src/editor/export/pdf.js';
import { buildFileName } from '../src/shared/naming.js';
import { contextFields } from '../src/shared/settings.js';

const toBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));

async function jpegFrom(canvas) {
  // JPEG has no alpha: flatten onto white.
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  const blob = await toBlob(c, 'image/jpeg', 0.88);
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
}

export function baseName(record, settings, date) {
  return buildFileName(settings.fileNamePattern, { table: record.table, label: record.label, host: location.host, title: record.label }, date, '');
}

/** [{ label, value }] for filled custom and template fields. */
function fieldValues(context, settings) {
  const values = context.custom || {};
  return contextFields(settings, context).map((f) => ({ label: f.label, value: values[f.id] })).filter((f) => f.value && String(f.value).trim());
}

function environmentLine(record, createdAt, dpr) {
  return [
    location.host, record.table, record.label, navigator.userAgentData?.brands?.find((b) => /Chrome|Edge/.test(b.brand))?.brand,
    `viewport ${innerWidth}×${innerHeight}${dpr && dpr !== 1 ? ` @${Math.round(dpr * 100) / 100}x` : ''}`,
    createdAt.toLocaleString(), record.user && `captured by ${record.user}`,
  ].filter(Boolean).join(' · ');
}

/** → [{ name, mimeType, blob }] for the chosen formats ('png', 'pdf'). */
export async function buildFiles({ canvas, title, context, record, settings, formats, createdAt, dpr }) {
  const base = baseName(record, settings, createdAt);
  const files = [];
  if (formats.includes('pdf')) {
    const blocks = [
      { type: 'title', text: title },
      { type: 'meta', text: environmentLine(record, createdAt, dpr) },
      { type: 'field', label: 'Description', text: context.description },
      { type: 'link', label: 'Record', url: record.recordUrl },
      { type: 'list', label: 'Steps to reproduce', items: context.steps || [] },
      { type: 'field', label: 'Notes', text: context.notes },
      ...fieldValues(context, settings).map((f) => ({ type: 'field', label: f.label, text: String(f.value) })),
    ];
    if (context.tags?.length) blocks.push({ type: 'field', label: 'Tags', text: context.tags.join(', ') });
    blocks.push({ type: 'image', ...(await jpegFrom(canvas)) });
    const bytes = buildPdf({ pageSize: settings.pageSize, blocks, title, createdAt });
    files.push({ name: `${base}.pdf`, mimeType: 'application/pdf', blob: new Blob([bytes], { type: 'application/pdf' }) });
  }
  if (formats.includes('png')) files.push({ name: `${base}.png`, mimeType: 'image/png', blob: await toBlob(canvas, 'image/png') });
  return files;
}
