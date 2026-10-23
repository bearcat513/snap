// Builds export files (§8) on demand and stores them as blobs so any adapter — including the
// ServiceNow bridge — can reference them by blobId.

import { putBlob, getBlob, updateCapture, del } from '../../shared/db.js';
import { captureBaseName, extensionForMime } from '../../shared/naming.js';
import { formatDuration } from '../../shared/util.js';
import { buildPdf } from './pdf.js';
import { Annotator } from '../canvas.js';
import { needsRender, renderKey, renderVideo, effectiveRange, FrameGrabber } from '../video-tools.js';

/** mm:ss.s — trim points need sub-second precision. */
const fmtPrecise = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

const canvasToBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));

async function jpegFrom(source) {
  // Flatten onto white (JPEG has no alpha) and return bytes + size.
  const w = source.width;
  const h = source.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0);
  const blob = await canvasToBlob(c, 'image/jpeg', 0.88);
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

/** Builds an off-screen annotator for exporting a screenshot without the editor UI (library re-export). */
export async function headlessAnnotator(capture) {
  const blob = await getBlob(capture.originalBlobId);
  if (!blob) throw new Error('The image data for this capture is missing.');
  const bmp = await createImageBitmap(blob);
  return new Annotator(document.createElement('canvas'), bmp, { doc: capture.annotations, unit: capture.source?.dpr || 1 });
}

export function exportedDurationMs(capture) {
  const [start, end] = effectiveRange(capture);
  return end - start;
}

export function environmentLine(capture) {
  const e = capture.environment || {};
  return [
    e.instance, e.table, e.label, e.browser, e.viewport && `viewport ${e.viewport}`,
    e.capturedAt && new Date(e.capturedAt).toLocaleString(),
    e.capturedBy && `captured by ${e.capturedBy}`,
    capture.kind === 'recording' && capture.source?.durationMs && `duration ${Math.round(exportedDurationMs(capture) / 1000)}s`,
  ].filter(Boolean).join(' · ');
}

/** [{ label, value }] for filled custom fields, in settings order. */
export function customFieldValues(capture, settings) {
  const values = capture.context?.custom || {};
  const known = (settings.customFields || []).map((f) => ({ label: f.label, value: values[f.id] }));
  const knownIds = new Set((settings.customFields || []).map((f) => f.id));
  const extra = Object.entries(values).filter(([id]) => !knownIds.has(id)).map(([id, value]) => ({ label: id, value }));
  return [...known, ...extra].filter((f) => f.value && String(f.value).trim());
}

export class ExportFactory {
  /** onProgress(message, fraction) is called during slow steps (video rendering). */
  constructor({ capture, annotator, settings, onProgress }) {
    this.capture = capture;
    this.annotator = annotator;
    this.settings = settings;
    this.onProgress = onProgress;
    this.base = captureBaseName(capture, settings);
    this.cache = new Map();
    this.flattened = null;
    this.video = null;
    this.warnings = [];
  }

  async store(name, blob) {
    const blobId = await putBlob(blob, { ephemeral: true });
    return { name, mimeType: blob.type, blobId, size: blob.size };
  }

  async flatten() {
    if (!this.flattened) {
      if (!this.annotator) this.annotator = await headlessAnnotator(this.capture);
      this.flattened = this.annotator.exportCanvas();
    }
    return this.flattened;
  }

  /** links: [{ label, url }] — e.g. S3 object URLs to cite in the PDF/sidecar. */
  async get(format, links = []) {
    const key = `${format}:${links.length}`;
    if (!this.cache.has(key)) this.cache.set(key, this.build(format, links));
    return this.cache.get(key);
  }

  async build(format, links) {
    switch (format) {
      case 'png': {
        const blob = await canvasToBlob(await this.flatten(), 'image/png');
        return [await this.store(`${this.base}.png`, blob)];
      }
      case 'video': {
        const v = await this.videoFile();
        return [{ name: `${this.base}.${extensionForMime(v.mimeType)}`, mimeType: v.mimeType, blobId: v.blobId, size: v.size }];
      }
      case 'pdf': {
        const bytes = await this.pdfBytes(links);
        return [await this.store(`${this.base}.pdf`, new Blob([bytes], { type: 'application/pdf' }))];
      }
      case 'sidecar': {
        const md = new Blob([this.markdown(links)], { type: 'text/markdown' });
        const json = new Blob([JSON.stringify(this.json(links), null, 2)], { type: 'application/json' });
        return [await this.store(`${this.base}.md`, md), await this.store(`${this.base}.json`, json)];
      }
      default:
        throw new Error(`Unknown export format ${format}`);
    }
  }

  /** The video to export: the original, or a re-encode with trim/redactions (cached on the capture). */
  async videoFile() {
    if (this.video) return this.video;
    const c = this.capture;
    const original = await getBlob(c.originalBlobId);
    if (!original) throw new Error('The video data for this capture is missing.');
    if (!needsRender(c)) {
      this.video = { blobId: c.originalBlobId, mimeType: (c.source.mimeType || original.type).split(';')[0], size: original.size };
      return this.video;
    }
    const key = renderKey(c);
    const cached = c.rendered?.key === key ? await getBlob(c.rendered.blobId) : null;
    if (cached) {
      this.video = { blobId: c.rendered.blobId, mimeType: cached.type, size: cached.size };
      return this.video;
    }
    this.onProgress?.('Rendering video…', 0);
    const { blob, warnings } = await renderVideo(original, {
      trim: c.trim,
      redactions: c.videoRedactions,
      unit: c.source?.dpr || 1,
      onProgress: (p) => this.onProgress?.(`Rendering video ${Math.round(p * 100)}% (keep this tab visible)`, p),
    });
    this.warnings.push(...warnings);
    const blobId = await putBlob(blob);
    const old = c.rendered?.blobId;
    const updated = await updateCapture(c.id, (cap) => { cap.rendered = { key, blobId }; });
    if (updated) this.capture.rendered = updated.rendered;
    if (old && old !== blobId) await del('blobs', old);
    this.video = { blobId, mimeType: blob.type, size: blob.size };
    return this.video;
  }

  /** Keyframe images for the PDF: the chosen keyframes, or one frame at the start of the range. */
  async keyframeImages() {
    const c = this.capture;
    const original = await getBlob(c.originalBlobId);
    if (!original) return [];
    const [start, end] = effectiveRange(c);
    let times = (c.keyframes || []).map((k) => k.timeMs).filter((t) => t >= start && t <= end).sort((a, b) => a - b);
    if (!times.length) times = [Math.min(end, start + 300)];
    const grabber = new FrameGrabber(original, { unit: c.source?.dpr || 1 });
    try {
      const out = [];
      for (const t of times) {
        const frame = await grabber.grab(t, c.videoRedactions, 1920);
        out.push({ caption: `Keyframe at ${formatDuration(t - start)}`, ...(await jpegFrom(frame)) });
      }
      return out;
    } catch {
      // Fall back to the poster grabbed while recording (only safe without redactions).
      const poster = !c.videoRedactions?.length && (await getBlob(c.posterBlobId || c.thumbnailBlobId));
      if (!poster) return [];
      const bmp = await createImageBitmap(poster);
      const img = { caption: 'Keyframe from the recording', ...(await jpegFrom(bmp)) };
      bmp.close();
      return [img];
    } finally {
      grabber.dispose();
    }
  }

  async pdfBytes(links) {
    const c = this.capture;
    const ctx = c.context || {};
    const blocks = [
      { type: 'title', text: c.title || 'Capture' },
      { type: 'meta', text: environmentLine(c) },
      { type: 'field', label: 'Description', text: ctx.description },
    ];
    if (ctx.recordUrl) blocks.push({ type: 'link', label: 'Record', url: ctx.recordUrl });
    blocks.push({ type: 'list', label: 'Steps to reproduce', items: ctx.steps || [] });
    blocks.push({ type: 'field', label: 'Notes', text: ctx.notes });
    for (const f of customFieldValues(c, this.settings)) blocks.push({ type: 'field', label: f.label, text: String(f.value) });
    if (ctx.tags?.length) blocks.push({ type: 'field', label: 'Tags', text: ctx.tags.join(', ') });
    for (const l of links) blocks.push({ type: 'link', label: l.label, url: l.url });

    if (c.kind === 'screenshot') {
      blocks.push({ type: 'image', ...(await jpegFrom(await this.flatten())) });
    } else {
      for (const img of await this.keyframeImages()) blocks.push({ type: 'image', ...img });
    }
    return buildPdf({ pageSize: this.settings['pdf.pageSize'], blocks, title: c.title, createdAt: new Date(c.createdAt) });
  }

  markdown(links) {
    const c = this.capture;
    const e = c.environment || {};
    const ctx = c.context || {};
    const lines = [`# ${c.title}`, ''];
    const [start, end] = effectiveRange(c);
    const env = [
      ['Instance', e.instance], ['Table', e.table], ['Record', e.label], ['Record URL', ctx.recordUrl],
      ['Browser', e.browser], ['Viewport', e.viewport], ['Captured', e.capturedAt], ['Captured by', e.capturedBy],
      ['Duration', c.source?.durationMs ? `${Math.round((end - start) / 1000)}s` : ''],
      ['Trimmed', c.trim ? `${fmtPrecise(start)}–${fmtPrecise(end)} of the original` : ''],
      ['Redacted regions', c.videoRedactions?.length ? String(c.videoRedactions.length) : ''],
      ['Tags', (ctx.tags || []).join(', ')],
      ...customFieldValues(c, this.settings).map((f) => [f.label, f.value]),
    ].filter(([, v]) => v);
    for (const [k, v] of env) lines.push(`- **${k}:** ${v}`);
    if (ctx.description) lines.push('', '## Description', '', ctx.description);
    const steps = (ctx.steps || []).filter((s) => s.trim());
    if (steps.length) lines.push('', '## Steps to reproduce', '', ...steps.map((s, i) => `${i + 1}. ${s}`));
    if (ctx.notes) lines.push('', '## Notes', '', ctx.notes);
    if (c.kind === 'recording' && c.keyframes?.length) {
      lines.push('', '## Keyframes', '', ...c.keyframes.map((k) => `- ${fmtPrecise(k.timeMs - start)}`));
    }
    if (links.length) {
      lines.push('', '## Files', '');
      for (const l of links) lines.push(`- [${l.label}](${l.url})`);
    }
    return `${lines.join('\n')}\n`;
  }

  json(links) {
    const c = this.capture;
    const sn = c.servicenow ? { instance: c.servicenow.instance, table: c.servicenow.table, sysId: c.servicenow.sysId, label: c.servicenow.label, user: c.servicenow.user } : undefined;
    const [start, end] = effectiveRange(c);
    return {
      title: c.title,
      kind: c.kind,
      createdAt: c.createdAt,
      context: c.context,
      customFields: customFieldValues(c, this.settings),
      environment: c.environment,
      servicenow: sn,
      source: { url: c.source.url, title: c.source.title, durationMs: c.source.durationMs, mimeType: c.source.mimeType },
      video: c.kind === 'recording' ? {
        exportedRangeMs: [start, end],
        keyframesMs: (c.keyframes || []).map((k) => k.timeMs),
        redactions: (c.videoRedactions || []).map(({ startMs, endMs, mode }) => ({ startMs, endMs, mode })),
      } : undefined,
      files: links,
    };
  }
}
