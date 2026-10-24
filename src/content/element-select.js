// Element picker (§6 capture a single element). Injected on demand; outlines the element under the
// pointer and resolves its bounds { x, y, w, h, vw, vh } in CSS px (padded, clipped to the viewport),
// or null on Esc. ↑ / ↓ widen to the parent or narrow back to the child. Reaches into same-origin
// frames such as ServiceNow's gsft_main.
(() => {
  if (window.__snapElementSelect) return;

  /** Deepest element at a client point, descending into same-origin frames. Returns { el, ox, oy }. */
  function deepest(x, y) {
    let doc = document;
    let ox = 0;
    let oy = 0;
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; i < 4 && el && /^(IFRAME|FRAME)$/.test(el.tagName); i++) {
      let inner;
      try { inner = el.contentDocument; } catch { break; }
      if (!inner) break;
      const r = el.getBoundingClientRect();
      ox += r.left + el.clientLeft;
      oy += r.top + el.clientTop;
      doc = inner;
      const next = doc.elementFromPoint(x - ox, y - oy);
      if (!next) break;
      el = next;
    }
    return el ? { el, ox, oy } : null;
  }

  window.__snapElementSelect = (padding = 8) => new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;display:none;transition:all .06s}
        .tag{position:absolute;left:-2px;top:-24px;font:12px system-ui,sans-serif;background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;white-space:nowrap}
        .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);font:13px system-ui,sans-serif;background:#1b1f24;color:#fff;
              padding:6px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.3)}
      </style>
      <div class="box"><span class="tag"></span></div>
      <div class="hint">Click an element to capture it · ↑ / ↓ parent / child · Esc to cancel</div>`;
    const box = root.querySelector('.box');
    const tag = root.querySelector('.tag');
    document.documentElement.appendChild(host);

    let current = null; // { el, ox, oy }
    const stack = []; // children we widened away from, for ↓

    const rectOf = (c) => {
      const r = c.el.getBoundingClientRect();
      return { x: r.left + c.ox, y: r.top + c.oy, w: r.width, h: r.height };
    };
    const show = () => {
      if (!current) { box.style.display = 'none'; return; }
      const r = rectOf(current);
      Object.assign(box.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const id = current.el.id ? `#${current.el.id}` : '';
      tag.textContent = `${current.el.tagName.toLowerCase()}${id} · ${Math.round(r.w)} × ${Math.round(r.h)}`;
    };

    // Same-origin frames get their own listeners (their events don't reach this window); `off`
    // converts a frame's client coordinates to this window's.
    const wins = [{ win: window, off: () => ({ x: 0, y: 0 }) }];
    (function collect(doc, parentOff, depth) {
      if (depth > 3) return;
      for (const f of doc.querySelectorAll('iframe, frame')) {
        let w;
        try { w = f.contentWindow; if (!w.document) continue; } catch { continue; }
        const off = () => { const r = f.getBoundingClientRect(); const p = parentOff(); return { x: p.x + r.left + f.clientLeft, y: p.y + r.top + f.clientTop }; };
        wins.push({ win: w, off });
        collect(w.document, off, depth + 1);
      }
    })(document, () => ({ x: 0, y: 0 }), 0);

    const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const toTop = (e) => {
      const entry = wins.find((x) => x.win === e.view);
      const o = entry ? entry.off() : { x: 0, y: 0 };
      return { x: e.clientX + o.x, y: e.clientY + o.y };
    };
    const onMove = (e) => {
      const p = toTop(e);
      const hit = deepest(p.x, p.y);
      if (!hit || hit.el === host || hit.el === current?.el) return;
      current = hit;
      stack.length = 0;
      show();
    };
    const EVENTS = ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'];
    const listen = (on) => {
      for (const { win } of wins) {
        const m = on ? 'addEventListener' : 'removeEventListener';
        try {
          win[m]('pointermove', onMove, true);
          for (const t of EVENTS) win[m](t, block, true);
          win[m]('pointerup', onUp, true);
          win[m]('keydown', onKey, true);
        } catch { /* frame navigated away */ }
      }
    };
    const finish = (value) => {
      listen(false);
      host.remove();
      // Two frames so the outline is gone from the next screenshot.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
    };
    const pick = () => {
      if (!current) return;
      const r = rectOf(current);
      const x = Math.max(0, r.x - padding);
      const y = Math.max(0, r.y - padding);
      const w = Math.min(innerWidth, r.x + r.w + padding) - x;
      const h = Math.min(innerHeight, r.y + r.h + padding) - y;
      if (w < 4 || h < 4) return;
      finish({ x, y, w, h, vw: innerWidth, vh: innerHeight });
    };
    const onUp = (e) => { block(e); if (e.button === 0) pick(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { block(e); finish(null); return; }
      if (e.key === 'Enter') { block(e); pick(); return; }
      if (!current) return;
      if (e.key === 'ArrowUp') {
        block(e);
        const parent = current.el.parentElement;
        if (parent && parent !== current.el.ownerDocument.documentElement) { stack.push(current.el); current = { ...current, el: parent }; show(); }
      } else if (e.key === 'ArrowDown') {
        block(e);
        const child = stack.pop();
        if (child) { current = { ...current, el: child }; show(); }
      }
    };
    listen(true);
  });
})();
