// Builds export files (§8) on demand and stores them as blobs so any adapter — including the
// ServiceNow bridge — can reference them by blobId.

import { putBlob, getBlob, getCapture, updateCapture, del } from '../../shared/db.js';
import { captureBaseName, extensionForMime } from '../../shared/naming.js';
import { formatDuration } from '../../shared/util.js';
import { contextFields } from '../../shared/settings.js';
import { buildPdf } from './pdf.js';
import { GifEncoder, buildPalette } from './gif.js';
import { buildVtt, transcriptText } from '../../shared/captions.js';
import { Annotator } from '../canvas.js';
import { needsRender, renderKey, renderVideo, effectiveRange, FrameGrabber } from '../video-tools.js';

/** mm:ss.s — trim points need sub-second precision. */
const fmtPrecise = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

const canvasToBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));
const GIF_MAX_MS = 20_000;

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

export const consoleLine = (e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ''}`;
export const requestLine = (r) => `${r.method || 'GET'} ${r.status || 'failed'}${r.statusText ? ` ${r.statusText}` : ''} ${r.url}`.trim();

/** PDF blocks for a capture's console/network log (§6), newest 20 of each. */
export function devtoolsBlocks(dt) {
  if (!dt) return [];
  if (!dt.console.length && !dt.network.length) {
    return [{ type: 'field', label: 'Console & network', text: `No console errors or failed requests since ${new Date(dt.startedAt).toLocaleString()}.` }];
  }
  return [
    { type: 'list', label: `Console errors & warnings (${dt.console.length})`, items: dt.console.slice(-20).map(consoleLine) },
    { type: 'list', label: `Failed requests (${dt.network.length})`, items: dt.network.slice(-20).map(requestLine) },
  ];
}

/** Guide keyframes: a numbered marker where the click happened (fx/fy are fractions of the frame). */
export function drawStepMarker(canvas, step) {
  if (step.fx === null || step.fx === undefined || step.fy === null || step.fy === undefined) return;
  const ctx = canvas.getContext('2d');
  const x = step.fx * canvas.width;
  const y = step.fy * canvas.height;
  const r = Math.max(12, Math.round(canvas.width / 70));
  ctx.save();
  ctx.lineWidth = Math.max(3, r / 4);
  ctx.strokeStyle = 'rgba(229,72,77,.9)';
  ctx.beginPath();
  ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
  ctx.stroke();
  const bx = Math.min(canvas.width - r, x + r * 1.6);
  const by = Math.max(r, y - r * 1.6);
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(step.n), bx, by + 1);
  ctx.restore();
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

/** [{ label, value }] for filled custom and template fields, in settings order. */
export function customFieldValues(capture, settings) {
  const values = capture.context?.custom || {};
  const fields = contextFields(settings, capture.context);
  const known = fields.map((f) => ({ label: f.label, value: values[f.id] }));
  const knownIds = new Set(fields.map((f) => f.id));
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

  /** Session members as their own factories, in session order (deleted members are skipped). */
  async memberFactories() {
    if (!this.members) {
      this.members = [];
      for (const id of this.capture.members || []) {
        const m = await getCapture(id);
        if (!m) { this.warnings.push('A capture in this session was deleted from the library and is left out.'); continue; }
        this.members.push(new ExportFactory({ capture: m, settings: this.settings, onProgress: this.onProgress }));
      }
    }
    return this.members;
  }

  /** Session exports: one file per member for png/video, one combined report for pdf/sidecar. */
  async buildSession(format, links) {
    const members = await this.memberFactories();
    const num = (i) => String(i + 1).padStart(2, '0');
    if (format === 'png' || format === 'video' || format === 'gif') {
      const out = [];
      for (const [i, m] of members.entries()) {
        const wanted = format === 'png' ? 'screenshot' : 'recording';
        if (m.capture.kind !== wanted) continue;
        for (const f of await m.get(format)) out.push({ ...f, name: f.name.replace(m.base, `${this.base}-${num(i)}`) });
        this.warnings.push(...m.warnings);
      }
      if (!out.length) throw new Error(`This session has no ${format === 'png' ? 'screenshots' : 'recordings'}.`);
      return out;
    }
    return null; // pdf / sidecar: handled by pdfBytes / markdown / json
  }

  async build(format, links) {
    if (this.capture.kind === 'session') {
      const files = await this.buildSession(format, links);
      if (files) return files;
    }
    switch (format) {
      case 'png': {
        const blob = await canvasToBlob(await this.flatten(), 'image/png');
        return [await this.store(`${this.base}.png`, blob)];
      }
      case 'video': {
        const v = await this.videoFile();
        return [{ name: `${this.base}.${extensionForMime(v.mimeType)}`, mimeType: v.mimeType, blobId: v.blobId, size: v.size }];
      }
      case 'issue':
        return []; // a tracker's issue itself: no file
      case 'gif': {
        const bytes = await this.gifBytes();
        return [await this.store(`${this.base}.gif`, new Blob([bytes], { type: 'image/gif' }))];
      }
      case 'pdf': {
        const bytes = await this.pdfBytes(links);
        return [await this.store(`${this.base}.pdf`, new Blob([bytes], { type: 'application/pdf' }))];
      }
      case 'sidecar': {
        if (this.capture.kind === 'session') await this.memberFactories();
        const md = new Blob([this.markdown(links)], { type: 'text/markdown' });
        const json = new Blob([JSON.stringify(this.json(links), null, 2)], { type: 'application/json' });
        const files = [await this.store(`${this.base}.md`, md), await this.store(`${this.base}.json`, json)];
        if (this.capture.captions?.length) {
          files.push(await this.store(`${this.base}.vtt`, new Blob([buildVtt(this.capture.captions, effectiveRange(this.capture))], { type: 'text/vtt' })));
        }
        return files;
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

  /**
   * Animated GIF of the exported range (§6 GIF export): redacted frames at Settings → GIF fps and
   * width, capped at GIF_MAX_MS. The palette comes from a few sample frames, then frames are
   * compressed one at a time.
   */
  async gifBytes() {
    const c = this.capture;
    const original = await getBlob(c.originalBlobId);
    if (!original) throw new Error('The video data for this capture is missing.');
    const [start, end] = effectiveRange(c);
    const fps = Math.min(20, Math.max(2, Number(this.settings['gif.fps']) || 10));
    const maxW = Math.min(1600, Math.max(160, Number(this.settings['gif.maxWidth']) || 800));
    let stop = end;
    if (end - start > GIF_MAX_MS) {
      stop = start + GIF_MAX_MS;
      this.warnings.push(`The GIF covers the first ${GIF_MAX_MS / 1000} s; use the video for longer clips.`);
    }
    const step = 1000 / fps;
    const times = [];
    for (let t = start; t < stop; t += step) times.push(t);
    if (!times.length) times.push(start);
    const grabber = new FrameGrabber(original, { unit: c.source?.dpr || 1 });
    const pixels = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    try {
      const samples = [];
      for (let i = 0; i < 6; i++) samples.push(pixels(await grabber.grab(times[Math.floor((i * (times.length - 1)) / 5)], c.videoRedactions, maxW)));
      let enc = null;
      for (const [i, t] of times.entries()) {
        const frame = await grabber.grab(t, c.videoRedactions, maxW);
        enc = enc || new GifEncoder(frame.width, frame.height, buildPalette(samples));
        enc.addFrame(pixels(frame), step);
        this.onProgress?.(`Making GIF ${Math.round(((i + 1) * 100) / times.length)}%`, (i + 1) / times.length);
      }
      return enc.finish();
    } finally {
      grabber.dispose();
    }
  }

  /** Keyframe images for the PDF: the chosen keyframes, or one frame at the start of the range. */
  async keyframeImages() {
    const c = this.capture;
    const original = await getBlob(c.originalBlobId);
    if (!original) return [];
    const [start, end] = effectiveRange(c);
    let keys = (c.keyframes || []).filter((k) => k.timeMs >= start && k.timeMs <= end).sort((a, b) => a.timeMs - b.timeMs);
    if (!keys.length) keys = [{ timeMs: Math.min(end, start + 300) }];
    const grabber = new FrameGrabber(original, { unit: c.source?.dpr || 1 });
    try {
      const out = [];
      for (const k of keys) {
        const frame = await grabber.grab(k.timeMs, c.videoRedactions, 1920);
        if (k.step) drawStepMarker(frame, k.step);
        const caption = k.step ? `Step ${k.step.n}: ${k.step.text}` : `Keyframe at ${formatDuration(k.timeMs - start)}`;
        out.push({ caption, ...(await jpegFrom(frame)) });
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
    blocks.push(...devtoolsBlocks(c.devtools));
    if (c.captions?.length) blocks.push({ type: 'field', label: 'Transcript', text: transcriptText(c.captions, effectiveRange(c)).slice(0, 4000) });

    blocks.push(...(await this.mediaBlocks()));
    return buildPdf({ pageSize: this.settings['pdf.pageSize'], blocks, title: c.title, createdAt: new Date(c.createdAt) });
  }

  /** The capture's images for the PDF; for a session, a section per member. */
  async mediaBlocks() {
    const c = this.capture;
    if (c.kind === 'screenshot') return [{ type: 'image', ...(await jpegFrom(await this.flatten())) }];
    if (c.kind === 'recording') return (await this.keyframeImages()).map((img) => ({ type: 'image', ...img }));
    const blocks = [];
    for (const [i, m] of (await this.memberFactories()).entries()) {
      const mc = m.capture;
      blocks.push({ type: 'heading', text: `${i + 1}. ${mc.title}`, newPage: i > 0 && mc.kind === 'recording' });
      blocks.push({ type: 'meta', text: environmentLine(mc) });
      blocks.push({ type: 'field', label: 'Description', text: mc.context?.description });
      blocks.push({ type: 'field', label: 'Notes', text: mc.context?.notes });
      blocks.push(...(await m.mediaBlocks()));
    }
    return blocks;
  }

  /** Issue body for the tracker destinations: the sidecar Markdown (session members loaded first). */
  async issueMarkdown(links = []) {
    if (this.capture.kind === 'session') await this.memberFactories();
    return this.markdown(links);
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
      lines.push('', '## Keyframes', '', ...c.keyframes.map((k) => `- ${fmtPrecise(k.timeMs - start)}${k.step ? ` — step ${k.step.n}: ${k.step.text}` : ''}`));
    }
    if (c.captions?.length) lines.push('', '## Transcript', '', transcriptText(c.captions, [start, end]));
    if (c.devtools) {
      const dt = c.devtools;
      lines.push('', '## Console errors & warnings', '', ...(dt.console.length ? dt.console.map((e) => `- ${consoleLine(e)}`) : ['None.']));
      lines.push('', '## Failed requests', '', ...(dt.network.length ? dt.network.map((r) => `- ${requestLine(r)}`) : ['None.']));
    }
    if (c.kind === 'session') {
      lines.push('', '## Captures', '');
      (this.members || []).forEach((m, i) => {
        const mc = m.capture;
        lines.push(`${i + 1}. **${mc.title}** (${mc.kind}, ${new Date(mc.createdAt).toLocaleString()})${mc.context?.description ? ` — ${mc.context.description}` : ''}`);
      });
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
        guide: (c.keyframes || []).some((k) => k.step) ? c.keyframes.filter((k) => k.step).map((k) => ({ timeMs: k.timeMs, ...k.step })) : undefined,
        redactions: (c.videoRedactions || []).map(({ startMs, endMs, mode }) => ({ startMs, endMs, mode })),
      } : undefined,
      devtools: c.devtools || undefined,
      captions: c.captions?.length ? c.captions : undefined,
      members: c.kind === 'session' ? (this.members || []).map((m) => ({
        id: m.capture.id, kind: m.capture.kind, title: m.capture.title, createdAt: m.capture.createdAt, context: m.capture.context,
      })) : undefined,
      files: links,
    };
  }
}
