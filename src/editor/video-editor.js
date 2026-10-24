// Video editing UI (§7.3): trim in/out, keyframes for the PDF, redaction regions over a time range.
// The player shows a live preview of the redactions on an overlay canvas; exports are re-rendered
// by video-tools.renderVideo so the redacted pixels are what ends up in the file.

import { redactRegion, clampRegion } from './redact.js';
import { FrameGrabber, activeRedactions } from './video-tools.js';
import { formatDuration } from '../shared/util.js';
import { el, confirmDialog } from './ui.js';
import { guideSteps, frameTimeFor } from '../shared/guide.js';

const MIN_TRIM_MS = 300;
const AUTO_KEYFRAMES = 4;
const FRAME_RATE = 30;

const fmt = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

export class VideoEditor extends EventTarget {
  constructor({ capture, blob }) {
    super();
    this.$ = (id) => document.getElementById(id);
    this.capture = capture;
    this.blob = blob;
    this.unit = capture.source?.dpr || 1;
    this.trim = capture.trim ? { ...capture.trim } : null;
    this.redactions = (capture.videoRedactions || []).map((r) => ({ ...r }));
    this.keyframes = (capture.keyframes || []).map((k) => ({ ...k }));
    this.selectedId = null;
    this.redactMode = false;
    this.blurMode = 'pixelate';
    this.draft = null;
    this.drag = null;
    this.grabber = new FrameGrabber(blob, { unit: this.unit });
    this.thumbTimer = null;

    this.video = this.$('video');
    this.overlay = this.$('video-overlay');
    this.octx = this.overlay.getContext('2d');
    this.url = URL.createObjectURL(blob);
    this.video.src = this.url;
  }

  async init() {
    const v = this.video;
    await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
    this.durationMs = Number.isFinite(v.duration) ? v.duration * 1000 : this.capture.source?.durationMs || 0;
    this.W = v.videoWidth;
    this.H = v.videoHeight;
    this.overlay.width = this.W;
    this.overlay.height = this.H;
    this.$('video-box').style.aspectRatio = `${this.W} / ${this.H}`;
    // Keep the box exactly the video's aspect ratio (no letterboxing) so the overlay lines up.
    const fit = () => {
      const avail = this.$('video-wrap').clientWidth;
      const maxH = Math.max(200, window.innerHeight - 340);
      this.$('video-box').style.width = `${Math.min(avail, (maxH * this.W) / this.H)}px`;
    };
    new ResizeObserver(fit).observe(this.$('video-wrap'));
    window.addEventListener('resize', fit);
    fit();

    v.addEventListener('seeked', () => this.drawOverlay());
    v.addEventListener('loadeddata', () => this.drawOverlay());
    v.addEventListener('timeupdate', () => { this.constrainPlayback(); this.renderPlayhead(); });
    v.addEventListener('play', () => {
      const [s, e] = this.range();
      if (v.currentTime * 1000 < s - 50 || v.currentTime * 1000 >= e - 50) v.currentTime = s / 1000;
      this.loop();
    });

    this.bindOverlay();
    this.bindTimeline();
    this.bindButtons();
    this.renderAll();
    if (this.trim) v.currentTime = this.trim.startMs / 1000;
  }

  changed() {
    this.renderAll();
    this.dispatchEvent(new Event('change'));
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => this.renderKeyframeThumbs(), 400);
  }

  /** Fields persisted on the capture. */
  state() {
    return { trim: this.trim, videoRedactions: this.redactions, keyframes: this.keyframes };
  }

  range() {
    return [this.trim?.startMs ?? 0, this.trim?.endMs ?? this.durationMs];
  }

  get nowMs() {
    return this.video.currentTime * 1000;
  }

  // ---------------- playback

  constrainPlayback() {
    const [, e] = this.range();
    if (!this.video.paused && this.nowMs >= e) {
      this.video.pause();
      this.video.currentTime = e / 1000;
    }
  }

  loop() {
    const step = () => {
      this.drawOverlay();
      this.constrainPlayback();
      this.renderPlayhead();
      if (!this.video.paused) this.video.requestVideoFrameCallback(step);
    };
    this.video.requestVideoFrameCallback(step);
  }

  // ---------------- transport (keyboard)

  togglePlay() {
    if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause();
  }

  seekTo(ms) {
    this.video.currentTime = Math.max(0, Math.min(this.durationMs, ms)) / 1000;
  }

  seekBy(ms) {
    this.seekTo(this.nowMs + ms);
  }

  /** Step whole frames; MediaRecorder output has no fixed frame index, so assume the recording's rate. */
  stepFrames(n) {
    this.video.pause();
    this.seekBy((n * 1000) / (this.capture.source?.fps || FRAME_RATE));
  }

  // ---------------- overlay (live redaction preview + region drawing)

  drawOverlay() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.video.readyState < 2) return;
    const t = this.nowMs;
    for (const r of activeRedactions(this.redactions, t)) {
      const box = clampRegion(r, this.W, this.H);
      if (box.w < 1 || box.h < 1) continue;
      ctx.drawImage(redactRegion(this.video, box, r.mode, this.unit), box.x, box.y);
    }
    const lw = Math.max(2, this.W / 600);
    ctx.save();
    ctx.lineWidth = lw;
    for (const r of this.redactions) {
      const active = t >= r.startMs && t <= r.endMs;
      const selected = r.id === this.selectedId;
      if (!active && !selected && !this.redactMode) continue;
      ctx.setLineDash(active ? [] : [lw * 4, lw * 3]);
      ctx.strokeStyle = selected ? '#2563eb' : active ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.45)';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    if (this.draft) {
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = 'rgba(37,99,235,.15)';
      const d = this.draftRect();
      ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeRect(d.x, d.y, d.w, d.h);
    }
    ctx.restore();
  }

  toVideo(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * this.W) / r.width, y: ((e.clientY - r.top) * this.H) / r.height };
  }

  draftRect() {
    const { start, end } = this.draft;
    return clampRegion({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }, this.W, this.H);
  }

  setRedactMode(on) {
    this.redactMode = on;
    this.overlay.classList.toggle('drawing', on);
    this.$('btn-redact-video').classList.toggle('active', on);
    this.$('btn-redact-video').setAttribute('aria-pressed', String(on));
    if (on) this.video.pause();
    this.drawOverlay();
  }

  bindOverlay() {
    const ov = this.overlay;
    ov.addEventListener('pointerdown', (e) => {
      if (!this.redactMode || e.button !== 0) return;
      ov.setPointerCapture(e.pointerId);
      const p = this.toVideo(e);
      const t = this.nowMs;
      const hit = [...this.redactions].reverse().find((r) => (t >= r.startMs && t <= r.endMs || r.id === this.selectedId) &&
        p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
      if (hit) {
        this.selectedId = hit.id;
        this.drag = { start: p, orig: { x: hit.x, y: hit.y }, id: hit.id, moved: false };
        this.renderRegions();
      } else {
        this.draft = { start: p, end: p };
      }
      this.drawOverlay();
    });
    ov.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const p = this.toVideo(e);
        const r = this.redactions.find((x) => x.id === this.drag.id);
        r.x = Math.round(Math.max(0, Math.min(this.W - r.w, this.drag.orig.x + p.x - this.drag.start.x)));
        r.y = Math.round(Math.max(0, Math.min(this.H - r.h, this.drag.orig.y + p.y - this.drag.start.y)));
        this.drag.moved = true;
        this.drawOverlay();
      } else if (this.draft) {
        this.draft.end = this.toVideo(e);
        this.drawOverlay();
      }
    });
    ov.addEventListener('pointerup', () => {
      if (this.drag) {
        const moved = this.drag.moved;
        this.drag = null;
        if (moved) this.changed();
        return;
      }
      if (!this.draft) return;
      const box = this.draftRect();
      this.draft = null;
      if (box.w >= 6 && box.h >= 6) {
        const [, end] = this.range();
        const r = { id: crypto.randomUUID(), ...box, startMs: Math.round(this.nowMs), endMs: Math.round(end), mode: this.blurMode };
        this.redactions.push(r);
        this.selectedId = r.id;
        this.changed();
      } else this.drawOverlay();
    });
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    this.redactions = this.redactions.filter((r) => r.id !== this.selectedId);
    this.selectedId = null;
    this.changed();
    return true;
  }

  // ---------------- trim

  setIn(ms) {
    const [, e] = this.range();
    const start = Math.max(0, Math.min(Math.round(ms), e - MIN_TRIM_MS));
    this.setTrim(start, e);
  }

  setOut(ms) {
    const [s] = this.range();
    const end = Math.min(this.durationMs, Math.max(Math.round(ms), s + MIN_TRIM_MS));
    this.setTrim(s, end);
  }

  setTrim(start, end) {
    this.trim = start <= 0 && end >= this.durationMs - 1 ? null : { startMs: start, endMs: end };
    this.changed();
  }

  // ---------------- keyframes

  addKeyframe(ms = this.nowMs) {
    const t = Math.round(ms);
    if (this.keyframes.some((k) => Math.abs(k.timeMs - t) < 100)) return;
    this.keyframes.push({ id: crypto.randomUUID(), timeMs: t });
    this.keyframes.sort((a, b) => a.timeMs - b.timeMs);
    this.changed();
  }

  async autoKeyframes() {
    if (this.keyframes.length) {
      const ok = await confirmDialog({ title: 'Replace keyframes?', message: `Replace the ${this.keyframes.length} keyframe(s) you picked with ${AUTO_KEYFRAMES} evenly spaced ones?`, ok: 'Replace' });
      if (!ok) return;
    }
    const [s, e] = this.range();
    const len = e - s;
    this.keyframes = Array.from({ length: AUTO_KEYFRAMES }, (_, i) => ({ id: crypto.randomUUID(), timeMs: Math.round(s + ((i + 0.5) * len) / AUTO_KEYFRAMES) }));
    this.changed();
  }

  /**
   * Step-by-step guide from the clicks recorded in the tab: a keyframe just before each click (the
   * PDF marks the click point and captions the step). Returns the steps' text, or null if cancelled.
   */
  async generateGuide() {
    const [s, e] = this.range();
    const steps = guideSteps(this.capture.clicks, [s, e]);
    if (!steps.length) return [];
    if (this.keyframes.length) {
      const ok = await confirmDialog({ title: 'Replace keyframes?', message: `Replace the ${this.keyframes.length} keyframe(s) with ${steps.length} from the recorded clicks?`, ok: 'Replace' });
      if (!ok) return null;
    }
    this.keyframes = steps.map((st, i) => ({
      id: crypto.randomUUID(),
      timeMs: frameTimeFor(st, s),
      step: { n: i + 1, text: st.text, fx: st.fx, fy: st.fy },
    }));
    this.changed();
    return steps.map((st) => st.text);
  }

  // ---------------- timeline

  pct(ms) {
    return `${(100 * Math.max(0, Math.min(ms, this.durationMs))) / (this.durationMs || 1)}%`;
  }

  bindTimeline() {
    const tl = this.$('timeline');
    const msAt = (e) => {
      const r = tl.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.durationMs;
    };
    let mode = null;
    tl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      tl.setPointerCapture(e.pointerId);
      mode = e.target.id === 'tl-in' ? 'in' : e.target.id === 'tl-out' ? 'out' : 'seek';
      if (mode === 'seek') this.video.currentTime = msAt(e) / 1000;
    });
    tl.addEventListener('pointermove', (e) => {
      if (!mode) return;
      const ms = msAt(e);
      if (mode === 'seek') this.video.currentTime = ms / 1000;
      else {
        if (mode === 'in') this.setIn(ms); else this.setOut(ms);
        this.video.currentTime = (mode === 'in' ? this.range()[0] : this.range()[1]) / 1000;
      }
    });
    tl.addEventListener('pointerup', () => { mode = null; });
    tl.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5000 : 1000;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.video.currentTime = Math.max(0, this.video.currentTime - step / 1000); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.video.currentTime = Math.min(this.durationMs / 1000, this.video.currentTime + step / 1000); }
    });
  }

  renderPlayhead() {
    this.$('tl-head').style.left = this.pct(this.nowMs);
    this.$('time-label').textContent = `${fmt(this.nowMs)} / ${fmt(this.durationMs)}`;
  }

  renderTimeline() {
    const [s, e] = this.range();
    Object.assign(this.$('tl-range').style, { left: this.pct(s), width: `calc(${this.pct(e)} - ${this.pct(s)})` });
    this.$('tl-in').style.left = this.pct(s);
    this.$('tl-out').style.left = this.pct(e);
    this.$('tl-keys').replaceChildren(...this.keyframes.map((k) => el('span', { class: 'tl-key', style: `left:${this.pct(k.timeMs)}`, title: `Keyframe ${fmt(k.timeMs)}` })));
    this.$('tl-redactions').replaceChildren(...this.redactions.map((r) => el('span', {
      class: `tl-red${r.id === this.selectedId ? ' selected' : ''}`,
      style: `left:${this.pct(r.startMs)};width:calc(${this.pct(r.endMs)} - ${this.pct(r.startMs)})`,
    })));
    this.$('trim-label').textContent = this.trim ? `Exporting ${fmt(s)} → ${fmt(e)} (${formatDuration(e - s)})` : `Exporting full length (${formatDuration(this.durationMs)})`;
    this.$('btn-clear-trim').disabled = !this.trim;
    this.renderPlayhead();
  }

  // ---------------- side lists

  renderKeyframes() {
    const list = this.$('keyframes');
    const [s] = this.range();
    this.$('keyframes-empty').hidden = this.keyframes.length > 0;
    list.replaceChildren(...this.keyframes.map((k) => el('li', { 'data-id': k.id },
      el('button', { class: 'kf-thumb', title: 'Go to keyframe', onclick: () => { this.video.currentTime = k.timeMs / 1000; } }, el('span', { class: 'ph' })),
      el('span', { class: 'small', text: k.step ? `${k.step.n}. ${k.step.text}` : fmt(k.timeMs - s), title: fmt(k.timeMs - s) }),
      el('button', {
        class: 'ghost icon', 'aria-label': `Remove keyframe at ${fmt(k.timeMs)}`,
        onclick: () => { this.keyframes = this.keyframes.filter((x) => x.id !== k.id); this.changed(); },
      }, '✕'))));
  }

  async renderKeyframeThumbs() {
    for (const k of this.keyframes) {
      const slot = this.$('keyframes').querySelector(`[data-id="${k.id}"] .kf-thumb`);
      if (!slot) continue;
      try {
        const c = await this.grabber.grab(k.timeMs, this.redactions, 160);
        c.className = 'kf-canvas';
        slot.replaceChildren(c);
      } catch { /* leave placeholder */ }
    }
  }

  renderRegions() {
    const list = this.$('video-redactions');
    this.$('redactions-empty').hidden = this.redactions.length > 0;
    list.replaceChildren(...this.redactions.map((r, i) => {
      const mode = el('select', { 'aria-label': 'Redaction style' },
        el('option', { value: 'pixelate', text: 'Pixelate' }), el('option', { value: 'blur', text: 'Blur' }));
      mode.value = r.mode;
      mode.addEventListener('change', () => { r.mode = mode.value; this.changed(); });
      return el('li', { class: r.id === this.selectedId ? 'selected' : '' },
        el('button', {
          class: 'ghost region-name',
          onclick: () => { this.selectedId = r.id; this.video.currentTime = r.startMs / 1000; this.renderAll(); },
        }, `Region ${i + 1}`),
        el('span', { class: 'small muted', text: `${fmt(r.startMs)} → ${fmt(r.endMs)}` }),
        el('span', { class: 'row-actions' },
          el('button', { class: 'small', title: 'Start at the current time', onclick: () => { r.startMs = Math.min(Math.round(this.nowMs), r.endMs - 100); this.changed(); } }, 'Start = now'),
          el('button', { class: 'small', title: 'End at the current time', onclick: () => { r.endMs = Math.max(Math.round(this.nowMs), r.startMs + 100); this.changed(); } }, 'End = now'),
          mode,
          el('button', { class: 'ghost icon', 'aria-label': `Remove region ${i + 1}`, onclick: () => { this.selectedId = r.id; this.deleteSelected(); } }, '✕')));
    }));
  }

  renderAll() {
    this.renderTimeline();
    this.renderKeyframes();
    this.renderRegions();
    this.drawOverlay();
  }

  bindButtons() {
    this.$('btn-set-in').addEventListener('click', () => this.setIn(this.nowMs));
    this.$('btn-set-out').addEventListener('click', () => this.setOut(this.nowMs));
    this.$('btn-clear-trim').addEventListener('click', () => this.setTrim(0, this.durationMs));
    this.$('btn-add-key').addEventListener('click', () => this.addKeyframe());
    this.$('btn-auto-keys').addEventListener('click', () => this.autoKeyframes());
    this.$('btn-guide').hidden = !this.capture.clicks?.length;
    this.$('btn-redact-video').addEventListener('click', () => this.setRedactMode(!this.redactMode));
    this.$('video-blur-mode').addEventListener('change', (e) => { this.blurMode = e.target.value; });
    this.renderKeyframeThumbs();
  }

  /** Thumbnail for the library: first keyframe (or start of range), redacted. */
  async thumbnail() {
    const [s] = this.range();
    const t = this.keyframes[0]?.timeMs ?? Math.min(this.range()[1], s + 300);
    return this.grabber.grab(t, this.redactions, 360);
  }

  dispose() {
    this.grabber.dispose();
    URL.revokeObjectURL(this.url);
  }
}
