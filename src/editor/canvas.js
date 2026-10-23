// Canvas annotation engine (§7.2). Shapes live in image-pixel coordinates in an AnnotationDoc (§10)
// so captures can be re-edited. Blur/pixelate is computed from the base image pixels and painted
// into the output, never overlaid, so redacted content can't be recovered from exports.

import { makeCanvas, redactRegion } from './redact.js';

export const TOOLS = ['select', 'crop', 'arrow', 'rect', 'ellipse', 'text', 'highlight', 'step', 'blur'];
const DRAG_TOOLS = new Set(['crop', 'arrow', 'rect', 'ellipse', 'highlight', 'blur']);
const MIN_SIZE = 4;

const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyDoc() {
  return { version: 1, shapes: [] };
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}


export class Annotator extends EventTarget {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {ImageBitmap} image base screenshot
   * @param {{doc?: object, unit?: number}} opts unit ≈ devicePixelRatio, scales stroke/font sizes
   */
  constructor(canvas, image, { doc, unit = 1 } = {}) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = image;
    this.unit = Math.max(1, unit);
    canvas.width = image.width;
    canvas.height = image.height;
    this.doc = doc && Array.isArray(doc.shapes) ? clone(doc) : emptyDoc();
    this.history = [this.snapshot()];
    this.future = [];
    this.tool = 'arrow';
    this.color = '#e5484d';
    this.strokeWidth = 4;
    this.blurMode = 'pixelate';
    this.selectedId = null;
    this.draft = null;
    this.drag = null;
    this.blurCache = new Map();

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => { this.draft = null; this.drag = null; this.render(); });
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.updateCursor();
    this.render();
  }

  // ---------- state ----------

  snapshot() {
    return JSON.stringify({ crop: this.doc.crop || null, shapes: this.doc.shapes });
  }

  restore(snap) {
    const s = JSON.parse(snap);
    this.doc.shapes = s.shapes;
    if (s.crop) this.doc.crop = s.crop; else delete this.doc.crop;
    if (!this.doc.shapes.some((sh) => sh.id === this.selectedId)) this.selectedId = null;
    this.render();
    this.emit('change');
    this.emit('select');
  }

  commit() {
    const snap = this.snapshot();
    if (snap === this.history[this.history.length - 1]) return;
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.render();
    this.emit('change');
  }

  undo() {
    if (this.history.length < 2) return;
    this.future.push(this.history.pop());
    this.restore(this.history[this.history.length - 1]);
  }

  redo() {
    if (!this.future.length) return;
    const snap = this.future.pop();
    this.history.push(snap);
    this.restore(snap);
  }

  get canUndo() { return this.history.length > 1; }
  get canRedo() { return this.future.length > 0; }

  toDoc() {
    return clone(this.doc);
  }

  hasRedaction() {
    return this.doc.shapes.some((s) => s.type === 'blur');
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    this.tool = tool;
    if (tool !== 'select') this.selectedId = null;
    this.updateCursor();
    this.render();
    this.emit('select');
  }

  updateCursor() {
    this.canvas.style.cursor = this.tool === 'select' ? 'default' : this.tool === 'text' ? 'text' : 'crosshair';
  }

  get selected() {
    return this.doc.shapes.find((s) => s.id === this.selectedId) || null;
  }

  setColor(color) {
    this.color = color;
    const s = this.selected;
    if (s && 'color' in s.props) { s.props.color = color; this.commit(); }
  }

  setStrokeWidth(w) {
    this.strokeWidth = w;
    const s = this.selected;
    if (s && 'width' in s.props) { s.props.width = w; this.commit(); }
  }

  setBlurMode(mode) {
    this.blurMode = mode;
    const s = this.selected;
    if (s && s.type === 'blur') { s.props.mode = mode; this.commit(); }
  }

  deleteSelected() {
    if (!this.selectedId) return;
    this.doc.shapes = this.doc.shapes.filter((s) => s.id !== this.selectedId);
    this.selectedId = null;
    this.commit();
    this.emit('select');
  }

  clearCrop() {
    if (!this.doc.crop) return;
    delete this.doc.crop;
    this.commit();
  }

  addShape(type, props) {
    const shape = { id: crypto.randomUUID(), type, props };
    this.doc.shapes.push(shape);
    this.commit();
    return shape;
  }

  addText(x, y, text) {
    if (!text.trim()) return null;
    return this.addShape('text', { x, y, text, color: this.color, size: Math.round(18 * this.unit) });
  }

  updateText(id, text) {
    const s = this.doc.shapes.find((sh) => sh.id === id);
    if (!s) return;
    if (!text.trim()) this.doc.shapes = this.doc.shapes.filter((sh) => sh.id !== id);
    else s.props.text = text;
    this.commit();
  }

  // ---------- geometry ----------

  toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * this.canvas.width) / r.width,
      y: ((e.clientY - r.top) * this.canvas.height) / r.height,
    };
  }

  /** Image px → CSS px relative to the canvas' top-left. */
  toClient(p) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * r.width) / this.canvas.width, y: (p.y * r.height) / this.canvas.height, scale: r.width / this.canvas.width };
  }

  textMetrics(props) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `600 ${props.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const lines = String(props.text).split('\n');
    const pad = Math.round(props.size * 0.4);
    const lineH = Math.round(props.size * 1.3);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const h = lines.length * lineH + pad * 2 - (lineH - props.size) / 2;
    ctx.restore();
    return { lines, pad, lineH, w, h };
  }

  bounds(s) {
    const p = s.props;
    switch (s.type) {
      case 'arrow': return normRect({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 });
      case 'text': { const m = this.textMetrics(p); return { x: p.x, y: p.y, w: m.w, h: m.h }; }
      case 'step': { const r = this.stepRadius(); return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }; }
      default: return { x: p.x, y: p.y, w: p.w, h: p.h };
    }
  }

  hitTest(pt) {
    const tol = 6 * this.unit;
    for (let i = this.doc.shapes.length - 1; i >= 0; i--) {
      const s = this.doc.shapes[i];
      if (s.type === 'arrow') {
        if (distToSegment(pt, { x: s.props.x1, y: s.props.y1 }, { x: s.props.x2, y: s.props.y2 }) <= tol + s.props.width) return s;
        continue;
      }
      if (s.type === 'rect' || s.type === 'ellipse') {
        // Outline shapes: hit near the stroke, or anywhere inside for small shapes.
        const b = this.bounds(s);
        const inside = pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol;
        const innerTol = tol + s.props.width;
        const deepInside = pt.x > b.x + innerTol && pt.x < b.x + b.w - innerTol && pt.y > b.y + innerTol && pt.y < b.y + b.h - innerTol;
        if (inside && (!deepInside || b.w * b.h < 80 * 80 * this.unit * this.unit)) return s;
        continue;
      }
      const b = this.bounds(s);
      if (pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol) return s;
    }
    return null;
  }

  stepRadius() {
    return Math.round(14 * this.unit);
  }

  constrain(start, end, type, shift) {
    if (!shift) return end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (type === 'arrow') {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
    }
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
  }

  // ---------- pointer ----------

  onDown(e) {
    if (e.button !== 0) return;
    const p = this.toImage(e);
    if (this.tool === 'text') {
      const hit = this.hitTest(p);
      if (hit && hit.type === 'text') this.emit('text-edit', { id: hit.id, ...hit.props });
      else this.emit('text-request', { x: p.x, y: p.y });
      return;
    }
    if (this.tool === 'step') {
      this.addShape('step', { x: p.x, y: p.y, color: this.color });
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'select') {
      const hit = this.hitTest(p);
      this.selectedId = hit ? hit.id : null;
      if (hit) this.drag = { start: p, orig: clone(hit.props), id: hit.id, moved: false };
      this.render();
      this.emit('select');
      return;
    }
    if (DRAG_TOOLS.has(this.tool)) this.draft = { type: this.tool, start: p, end: p };
  }

  onMove(e) {
    const p = this.toImage(e);
    if (this.drag) {
      const s = this.doc.shapes.find((sh) => sh.id === this.drag.id);
      if (!s) return;
      const dx = p.x - this.drag.start.x;
      const dy = p.y - this.drag.start.y;
      const o = this.drag.orig;
      if (s.type === 'arrow') Object.assign(s.props, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
      else Object.assign(s.props, { x: o.x + dx, y: o.y + dy });
      this.drag.moved = true;
      this.render();
      return;
    }
    if (this.draft) {
      this.draft.end = this.constrain(this.draft.start, p, this.draft.type, e.shiftKey);
      this.render();
      return;
    }
    if (this.tool === 'select') this.canvas.style.cursor = this.hitTest(p) ? 'move' : 'default';
  }

  onUp() {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.commit();
      return;
    }
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    const { start, end, type } = d;
    if (type === 'arrow') {
      if (Math.hypot(end.x - start.x, end.y - start.y) >= MIN_SIZE * 2) {
        this.addShape('arrow', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: this.color, width: this.strokeWidth });
      } else this.render();
      return;
    }
    const r = this.clampRect(normRect(start, end));
    if (r.w < MIN_SIZE || r.h < MIN_SIZE) { this.render(); return; }
    if (type === 'crop') {
      this.doc.crop = r;
      this.commit();
    } else if (type === 'blur') {
      this.addShape('blur', { ...r, mode: this.blurMode });
    } else if (type === 'highlight') {
      this.addShape('highlight', { ...r, color: this.color === '#e5484d' ? '#ffd60a' : this.color });
    } else {
      this.addShape(type, { ...r, color: this.color, width: this.strokeWidth });
    }
  }

  onDblClick(e) {
    const hit = this.hitTest(this.toImage(e));
    if (hit && hit.type === 'text') this.emit('text-edit', { id: hit.id, ...hit.props });
  }

  clampRect(r) {
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    return {
      x, y,
      w: Math.min(this.image.width - x, Math.round(r.w)),
      h: Math.min(this.image.height - y, Math.round(r.h)),
    };
  }

  // ---------- painting ----------

  render() {
    this.paint(this.ctx, { ui: true });
  }

  /** Flattened, cropped output canvas — what gets exported. */
  exportCanvas() {
    const full = makeCanvas(this.image.width, this.image.height);
    this.paint(full.getContext('2d'), { ui: false });
    const c = this.doc.crop;
    if (!c) return full;
    const out = makeCanvas(c.w, c.h);
    out.getContext('2d').drawImage(full, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    return out;
  }

  paint(ctx, { ui }) {
    const { width: W, height: H } = this.image;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.image, 0, 0);

    const shapes = this.doc.shapes;
    for (const s of shapes) if (s.type === 'blur') this.drawBlur(ctx, s.props);
    for (const s of shapes) if (s.type === 'highlight') this.drawHighlight(ctx, s.props);
    let step = 0;
    for (const s of shapes) {
      if (s.type === 'rect') this.drawRect(ctx, s.props);
      else if (s.type === 'ellipse') this.drawEllipse(ctx, s.props);
      else if (s.type === 'arrow') this.drawArrow(ctx, s.props);
      else if (s.type === 'text') this.drawText(ctx, s.props);
      else if (s.type === 'step') this.drawStep(ctx, s.props, ++step);
    }

    if (ui) {
      if (this.draft) this.drawDraft(ctx, this.draft);
      const sel = this.selected;
      if (sel) {
        const b = this.bounds(sel);
        const pad = 4 * this.unit;
        ctx.save();
        ctx.setLineDash([6 * this.unit, 4 * this.unit]);
        ctx.lineWidth = 1.5 * this.unit;
        ctx.strokeStyle = '#2563eb';
        ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
        ctx.restore();
      }
      const crop = this.draft && this.draft.type === 'crop' ? this.clampRect(normRect(this.draft.start, this.draft.end)) : this.doc.crop;
      if (crop) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,.5)';
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.rect(crop.x, crop.y, crop.w, crop.h);
        ctx.fill('evenodd');
        ctx.setLineDash([8 * this.unit, 6 * this.unit]);
        ctx.lineWidth = 2 * this.unit;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawDraft(ctx, d) {
    if (d.type === 'crop') return; // drawn with the crop overlay
    const r = normRect(d.start, d.end);
    if (d.type === 'arrow') {
      this.drawArrow(ctx, { x1: d.start.x, y1: d.start.y, x2: d.end.x, y2: d.end.y, color: this.color, width: this.strokeWidth });
    } else if (d.type === 'rect') this.drawRect(ctx, { ...r, color: this.color, width: this.strokeWidth });
    else if (d.type === 'ellipse') this.drawEllipse(ctx, { ...r, color: this.color, width: this.strokeWidth });
    else if (d.type === 'highlight') this.drawHighlight(ctx, { ...r, color: this.color === '#e5484d' ? '#ffd60a' : this.color });
    else if (d.type === 'blur') {
      ctx.save();
      ctx.fillStyle = 'rgba(37,99,235,.15)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([6 * this.unit, 4 * this.unit]);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5 * this.unit;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  drawRect(ctx, p) {
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width * this.unit;
    ctx.lineJoin = 'round';
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.restore();
  }

  drawEllipse(ctx, p) {
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width * this.unit;
    ctx.beginPath();
    ctx.ellipse(p.x + p.w / 2, p.y + p.h / 2, Math.max(1, p.w / 2), Math.max(1, p.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(ctx, p) {
    const lw = p.width * this.unit;
    const angle = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    const head = Math.min(len * 0.6, Math.max(12 * this.unit, lw * 3.5));
    const bx = p.x2 - Math.cos(angle) * head * 0.8;
    const by = p.y2 - Math.sin(angle) * head * 0.8;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.fillStyle = p.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x1, p.y1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x2, p.y2);
    ctx.lineTo(p.x2 - head * Math.cos(angle - Math.PI / 7), p.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(p.x2 - head * Math.cos(angle + Math.PI / 7), p.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawHighlight(ctx, p) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.restore();
  }

  drawText(ctx, p) {
    const m = this.textMetrics(p);
    ctx.save();
    ctx.font = `600 ${p.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, m.w, m.h, 4 * this.unit);
    ctx.fill();
    ctx.fillStyle = isLight(p.color) ? '#111' : '#fff';
    ctx.textBaseline = 'top';
    m.lines.forEach((line, i) => ctx.fillText(line, p.x + m.pad, p.y + m.pad + i * m.lineH));
    ctx.restore();
  }

  drawStep(ctx, p, num) {
    const r = this.stepRadius();
    ctx.save();
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * this.unit;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isLight(p.color) ? '#111' : '#fff';
    ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), p.x, p.y + 1);
    ctx.restore();
  }

  drawBlur(ctx, p) {
    const r = this.clampRect(p);
    if (r.w < 1 || r.h < 1) return;
    const key = `${r.x},${r.y},${r.w},${r.h},${p.mode}`;
    let tile = this.blurCache.get(key);
    if (!tile) {
      tile = redactRegion(this.image, r, p.mode, this.unit);
      if (this.blurCache.size > 64) this.blurCache.clear();
      this.blurCache.set(key, tile);
    }
    ctx.drawImage(tile, r.x, r.y);
  }
}
