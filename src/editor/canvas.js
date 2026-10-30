// Canvas annotation engine (§7.2). Shapes live in image-pixel coordinates in an AnnotationDoc (§10)
// so captures can be re-edited. Blur/pixelate is computed from the base image pixels and painted
// into the output, never overlaid, so redacted content can't be recovered from exports.

import { makeCanvas, redactRegion } from './redact.js';

export const TOOLS = ['select', 'crop', 'arrow', 'rect', 'ellipse', 'pen', 'text', 'highlight', 'step', 'blur'];
const DRAG_TOOLS = new Set(['crop', 'arrow', 'rect', 'ellipse', 'highlight', 'blur']);
const BOX_SHAPES = new Set(['rect', 'ellipse', 'highlight', 'blur', 'pen']);
const MIN_SIZE = 4;
const HANDLE_CSS_PX = 9; // on-screen size of resize handles
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' };

const clone = (o) => JSON.parse(JSON.stringify(o));

export function emptyDoc() {
  return { version: 1, shapes: [] };
}

/** Move a shape by (dx, dy) from `from` (its current props, or the props when a drag started). */
function translated(type, from, dx, dy) {
  if (type === 'arrow') return { x1: from.x1 + dx, y1: from.y1 + dy, x2: from.x2 + dx, y2: from.y2 + dy };
  if (type === 'pen') return { points: from.points.map(([x, y]) => [x + dx, y + dy]) };
  return { x: from.x + dx, y: from.y + dy };
}

// Shapes are painted in these groups (see paint), so layer order only means something within one.
const paintGroup = (s) => (s.type === 'blur' || s.type === 'highlight' ? s.type : 'shape');

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
    this.hints = []; // suggested redactions: dashed outlines, never exported

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

  /** Copy the selected shape, slightly offset, and select the copy. */
  duplicateSelected() {
    const s = this.selected;
    if (!s) return;
    const off = 12 * this.unit;
    const copy = { id: crypto.randomUUID(), type: s.type, props: { ...clone(s.props), ...translated(s.type, s.props, off, off) } };
    this.doc.shapes.push(copy);
    this.selectedId = copy.id;
    this.commit();
    this.emit('select');
  }

  /** Move the selected shape by CSS px. A run of quick nudges is one undo step. */
  nudgeSelected(dx, dy) {
    const s = this.selected;
    if (!s) return;
    Object.assign(s.props, translated(s.type, s.props, dx * this.unit, dy * this.unit));
    const now = Date.now();
    if (this.lastNudge?.id === s.id && now - this.lastNudge.at < 800 && this.history.length > 1 && !this.future.length) {
      this.history[this.history.length - 1] = this.snapshot();
      this.render();
      this.emit('change');
    } else {
      this.commit();
    }
    this.lastNudge = { id: s.id, at: now };
  }

  /** Bring the selected shape forward (+1) or send it back (-1) past its nearest neighbor in the same paint group. */
  moveLayer(dir) {
    const s = this.selected;
    if (!s) return;
    const shapes = this.doc.shapes;
    const i = shapes.indexOf(s);
    for (let j = i + dir; j >= 0 && j < shapes.length; j += dir) {
      if (paintGroup(shapes[j]) !== paintGroup(s)) continue;
      shapes.splice(i, 1);
      shapes.splice(j, 0, s);
      this.commit();
      return;
    }
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

  /** Add several shapes as one undo step. */
  addShapes(list) {
    const shapes = list.map(({ type, props }) => ({ id: crypto.randomUUID(), type, props }));
    this.doc.shapes.push(...shapes);
    this.commit();
    return shapes;
  }

  /** Suggested redactions to outline (image px): [{ x, y, w, h, kind }]. */
  setHints(hints) {
    this.hints = hints || [];
    this.render();
  }

  hintAt(p) {
    return this.hints.findIndex((h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h);
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
      case 'pen': {
        const xs = p.points.map((q) => q[0]);
        const ys = p.points.map((q) => q[1]);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      default: return { x: p.x, y: p.y, w: p.w, h: p.h };
    }
  }

  /** Image px per CSS px of the canvas as currently displayed. */
  viewScale() {
    const r = this.canvas.getBoundingClientRect();
    return r.width ? this.canvas.width / r.width : 1;
  }

  /** Resize handles of a shape: [{ id, x, y }] in image px. Steps have none; text only scales from its corner. */
  handles(s) {
    if (s.type === 'arrow') return [{ id: 'p1', x: s.props.x1, y: s.props.y1 }, { id: 'p2', x: s.props.x2, y: s.props.y2 }];
    const b = this.bounds(s);
    if (s.type === 'text') return [{ id: 'se', x: b.x + b.w, y: b.y + b.h }];
    if (!BOX_SHAPES.has(s.type)) return [];
    const mx = b.x + b.w / 2;
    const my = b.y + b.h / 2;
    return [
      { id: 'nw', x: b.x, y: b.y }, { id: 'n', x: mx, y: b.y }, { id: 'ne', x: b.x + b.w, y: b.y },
      { id: 'e', x: b.x + b.w, y: my }, { id: 'se', x: b.x + b.w, y: b.y + b.h }, { id: 's', x: mx, y: b.y + b.h },
      { id: 'sw', x: b.x, y: b.y + b.h }, { id: 'w', x: b.x, y: my },
    ];
  }

  handleAt(pt) {
    const s = this.selected;
    if (!s || this.tool !== 'select') return null;
    const tol = HANDLE_CSS_PX * this.viewScale();
    return this.handles(s).find((h) => Math.abs(pt.x - h.x) <= tol && Math.abs(pt.y - h.y) <= tol) || null;
  }

  /** Apply a handle drag: `orig` is the shape's props and `ob` its bounds when the drag started. */
  resizeShape(s, handle, orig, ob, p) {
    if (s.type === 'arrow') {
      if (handle === 'p1') Object.assign(s.props, { x1: p.x, y1: p.y }); else Object.assign(s.props, { x2: p.x, y2: p.y });
      return;
    }
    if (s.type === 'text') {
      const ratio = ob.w > 0 ? (p.x - ob.x) / ob.w : 1;
      s.props.size = Math.round(Math.max(8 * this.unit, Math.min(200 * this.unit, orig.size * ratio)));
      return;
    }
    let x1 = ob.x;
    let y1 = ob.y;
    let x2 = ob.x + ob.w;
    let y2 = ob.y + ob.h;
    if (handle.includes('w')) x1 = p.x;
    if (handle.includes('e')) x2 = p.x;
    if (handle.includes('n')) y1 = p.y;
    if (handle.includes('s')) y2 = p.y;
    const r = normRect({ x: x1, y: y1 }, { x: x2, y: y2 });
    if (s.type === 'pen') {
      // Map each point from the old box to the new one, keeping flips (dragging past the opposite edge).
      const sx = ob.w ? (x2 - x1) / ob.w : 1;
      const sy = ob.h ? (y2 - y1) / ob.h : 1;
      s.props.points = orig.points.map(([x, y]) => [x1 + (x - ob.x) * sx, y1 + (y - ob.y) * sy]);
      return;
    }
    Object.assign(s.props, s.type === 'blur' ? this.clampRect(r) : r);
  }

  hitTest(pt) {
    const tol = 6 * this.unit;
    for (let i = this.doc.shapes.length - 1; i >= 0; i--) {
      const s = this.doc.shapes[i];
      if (s.type === 'pen') {
        const pts = s.props.points;
        for (let j = 1; j < pts.length; j++) {
          if (distToSegment(pt, { x: pts[j - 1][0], y: pts[j - 1][1] }, { x: pts[j][0], y: pts[j][1] }) <= tol + s.props.width * this.unit) return s;
        }
        continue;
      }
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
    const hint = this.hints.length ? this.hintAt(p) : -1;
    if (hint >= 0) { this.emit('hint-click', { index: hint }); return; }
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
    if (this.tool === 'pen') {
      this.draft = { type: 'pen', points: [[p.x, p.y]] };
      return;
    }
    if (this.tool === 'select') {
      const handle = this.handleAt(p);
      if (handle) {
        const s = this.selected;
        this.drag = { resize: handle.id, start: p, orig: clone(s.props), bounds: this.bounds(s), id: s.id, moved: false };
        return;
      }
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
      if (this.drag.resize) this.resizeShape(s, this.drag.resize, o, this.drag.bounds, p);
      else Object.assign(s.props, translated(s.type, o, dx, dy));
      this.drag.moved = true;
      this.render();
      return;
    }
    if (this.draft?.type === 'pen') {
      const [lx, ly] = this.draft.points[this.draft.points.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) >= 1.5 * this.viewScale()) this.draft.points.push([p.x, p.y]);
      this.render();
      return;
    }
    if (this.draft) {
      this.draft.end = this.constrain(this.draft.start, p, this.draft.type, e.shiftKey);
      this.render();
      return;
    }
    if (this.tool === 'select') {
      const handle = this.handleAt(p);
      this.canvas.style.cursor = handle ? HANDLE_CURSORS[handle.id] : this.hitTest(p) ? 'move' : 'default';
    }
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
    if (d.type === 'pen') {
      if (d.points.length > 1) {
        const points = d.points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
        this.addShape('pen', { points, color: this.color, width: this.strokeWidth });
      } else this.render();
      return;
    }
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
      else if (s.type === 'pen') this.drawPen(ctx, s.props);
      else if (s.type === 'text') this.drawText(ctx, s.props);
      else if (s.type === 'step') this.drawStep(ctx, s.props, ++step);
    }

    if (ui) {
      if (this.hints.length) this.drawHints(ctx);
      if (this.draft) this.drawDraft(ctx, this.draft);
      const sel = this.selected;
      if (sel) {
        const b = this.bounds(sel);
        const pad = 4 * this.unit;
        ctx.save();
        ctx.setLineDash([6 * this.unit, 4 * this.unit]);
        ctx.lineWidth = 1.5 * this.unit;
        ctx.strokeStyle = '#2563eb';
        if (sel.type !== 'arrow') ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
        if (this.tool === 'select') {
          const size = HANDLE_CSS_PX * this.viewScale();
          ctx.setLineDash([]);
          ctx.fillStyle = '#fff';
          for (const h of this.handles(sel)) {
            ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
            ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
          }
        }
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

  drawHints(ctx) {
    const u = this.viewScale();
    ctx.save();
    ctx.lineWidth = 2 * u;
    ctx.setLineDash([6 * u, 4 * u]);
    ctx.font = `600 ${11 * u}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const h of this.hints) {
      ctx.fillStyle = 'rgba(247,107,21,.18)';
      ctx.fillRect(h.x, h.y, h.w, h.h);
      ctx.strokeStyle = '#f76b15';
      ctx.strokeRect(h.x, h.y, h.w, h.h);
      const label = h.kind;
      const tw = ctx.measureText(label).width + 8 * u;
      const ty = h.y > 16 * u ? h.y : h.y + h.h + 15 * u;
      ctx.fillStyle = '#f76b15';
      ctx.fillRect(h.x, ty - 15 * u, tw, 15 * u);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, h.x + 4 * u, ty - 2 * u);
    }
    ctx.restore();
  }

  drawDraft(ctx, d) {
    if (d.type === 'crop') return; // drawn with the crop overlay
    if (d.type === 'pen') { this.drawPen(ctx, { points: d.points, color: this.color, width: this.strokeWidth }); return; }
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

  drawPen(ctx, p) {
    const pts = p.points;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width * this.unit;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    // Quadratic curves through segment midpoints smooth out pointer jitter.
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
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
