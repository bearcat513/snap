// Video edits (§7.3): trim, redaction regions over a time range, keyframe extraction.
//
// Edits are non-destructive on the capture (capture.trim, capture.videoRedactions, capture.keyframes)
// and applied at export by re-encoding: the source plays through a canvas that paints each frame with
// the active redactions, and MediaRecorder records canvas + audio. That runs in real time, needs no
// codec libraries, and works for both MP4 and WebM sources.

import { redactRegion, clampRegion } from './redact.js';
import { pickMimeType } from '../shared/recording.js';
import { fixWebmDuration } from '../shared/webm-duration.js';

const once = (target, event) => new Promise((resolve, reject) => {
  const ok = () => { cleanup(); resolve(); };
  const fail = () => { cleanup(); reject(target.error || new Error(`Video ${event} failed`)); };
  const cleanup = () => { target.removeEventListener(event, ok); target.removeEventListener('error', fail); };
  target.addEventListener(event, ok, { once: true });
  target.addEventListener('error', fail, { once: true });
});

export function needsRender(capture) {
  return !!(capture.trim || capture.videoRedactions?.length);
}

export function renderKey(capture) {
  return JSON.stringify({
    trim: capture.trim || null,
    r: (capture.videoRedactions || []).map(({ x, y, w, h, startMs, endMs, mode }) => [x, y, w, h, startMs, endMs, mode]),
  });
}

/** [startMs, endMs] of the exported range. */
export function effectiveRange(capture, durationMs = capture.source?.durationMs || 0) {
  const start = capture.trim?.startMs ?? 0;
  const end = capture.trim?.endMs ?? durationMs;
  return [start, Math.max(start, end)];
}

export const activeRedactions = (redactions, timeMs) =>
  (redactions || []).filter((r) => timeMs >= r.startMs && timeMs <= r.endMs);

/** Paint `video`'s current frame plus the redactions active at timeMs onto ctx (canvas at video size). */
export function paintFrame(ctx, video, redactions, timeMs, unit = 1) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.drawImage(video, 0, 0, W, H);
  for (const r of activeRedactions(redactions, timeMs)) {
    const box = clampRegion(r, W, H);
    if (box.w < 1 || box.h < 1) continue;
    ctx.drawImage(redactRegion(ctx.canvas, box, r.mode, unit), box.x, box.y);
  }
}

export async function loadVideo(blob, { attach = false } = {}) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  if (attach) {
    // Frame callbacks only fire for videos that are rendered; keep it in the DOM but invisible.
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
  }
  await once(video, 'loadedmetadata');
  if (!Number.isFinite(video.duration)) {
    // Unpatched WebM: seeking far forces Chrome to compute the duration.
    video.currentTime = 1e9;
    await once(video, 'seeked');
  }
  return {
    video,
    dispose() {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    },
  };
}

export async function seek(video, seconds) {
  const t = Math.max(0, Math.min(seconds, (video.duration || seconds) - 0.001));
  if (Math.abs(video.currentTime - t) < 0.0005 && video.readyState >= 2) return;
  video.currentTime = t;
  await once(video, 'seeked');
  if (video.readyState < 2) await once(video, 'loadeddata');
}

/** Grabs redacted frames from a private video element so the visible player isn't disturbed. */
export class FrameGrabber {
  constructor(blob, { unit = 1 } = {}) {
    this.blob = blob;
    this.unit = unit;
    this.ready = null;
    this.queue = Promise.resolve();
  }

  async init() {
    if (!this.ready) this.ready = loadVideo(this.blob);
    return this.ready;
  }

  /** Returns a canvas (maxW wide at most) of the frame at timeMs with redactions applied. */
  grab(timeMs, redactions, maxW = Infinity) {
    const job = this.queue.then(async () => {
      const { video } = await this.init();
      await seek(video, timeMs / 1000);
      const full = document.createElement('canvas');
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      paintFrame(full.getContext('2d'), video, redactions, timeMs, this.unit);
      if (full.width <= maxW) return full;
      const out = document.createElement('canvas');
      out.width = Math.round(maxW);
      out.height = Math.round((full.height * maxW) / full.width);
      out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
      return out;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async dispose() {
    if (this.ready) (await this.ready).dispose();
    this.ready = null;
  }
}

/**
 * Re-encode `blob` with trim + time-ranged redactions. Real time: a 40 s range takes ~40 s.
 * The tab must stay visible (Chrome stops painting video frames in background tabs).
 */
export async function renderVideo(blob, { trim, redactions = [], unit = 1, onProgress, signal } = {}) {
  const { video, dispose } = await loadVideo(blob, { attach: true });
  const durationMs = video.duration * 1000;
  const startS = (trim?.startMs ?? 0) / 1000;
  const endS = Math.min(durationMs, trim?.endMs ?? durationMs) / 1000;
  const warnings = [];

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Audio goes through WebAudio so it's recorded without playing out of the speakers.
  const audio = new AudioContext();
  const source = audio.createMediaElementSource(video);
  const dest = audio.createMediaStreamDestination();
  source.connect(dest);
  if (audio.state === 'suspended') await audio.resume().catch(() => {});

  try {
    await seek(video, startS);
    paintFrame(ctx, video, redactions, startS * 1000, unit);

    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const tick = () => {
      if (done) return;
      const t = video.currentTime;
      paintFrame(ctx, video, redactions, t * 1000, unit);
      onProgress?.(Math.min(1, (t - startS) / Math.max(0.001, endS - startS)));
      if (t >= endS - 0.001 || video.ended) finish();
    };
    const onFrame = () => { tick(); if (!done) video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
    const timer = setInterval(tick, 40); // covers frames rVFC skips and the end-of-range check
    video.addEventListener('ended', finish);
    signal?.addEventListener('abort', finish);

    recorder.start(1000);
    try {
      await video.play();
    } catch (err) {
      if (err.name !== 'NotAllowedError') throw err;
      video.muted = true; // autoplay with sound refused: keep the picture, drop the audio
      warnings.push('Audio could not be included in the rendered video.');
      await video.play();
    }
    await stopped;
    clearInterval(timer);
    if (signal?.aborted) throw new DOMException('Rendering cancelled', 'AbortError');

    const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0];
    let out = new Blob(chunks, { type });
    if (type === 'video/webm') out = await fixWebmDuration(out, Math.round((endS - startS) * 1000));
    onProgress?.(1);
    return { blob: out, durationMs: Math.round((endS - startS) * 1000), warnings };
  } finally {
    audio.close().catch(() => {});
    dispose();
  }
}
