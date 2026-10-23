// Scroll-and-stitch helper (§6.3). Detects the real scroll container (including Classic UI's
// gsft_main iframe), scrolls it step by step, and hides fixed/sticky elements after the first tile.
(() => {
  if (window.__snapFullPage) return;

  let state = null;

  function scrollable(el) {
    if (!el) return false;
    const oy = getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 40;
  }

  function findScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    if (docEl.scrollHeight > docEl.clientHeight + 4) {
      return { el: docEl, doc: document, rect: { x: 0, y: 0, w: docEl.clientWidth, h: docEl.clientHeight } };
    }
    // Classic UI: content scrolls inside gsft_main.
    const frame = document.querySelector('iframe#gsft_main, iframe[name="gsft_main"]');
    try {
      const fdoc = frame && frame.contentDocument;
      const fel = fdoc && (fdoc.scrollingElement || fdoc.documentElement);
      if (fel && fel.scrollHeight > fel.clientHeight + 4) {
        const r = frame.getBoundingClientRect();
        return { el: fel, doc: fdoc, rect: { x: r.left + frame.clientLeft, y: r.top + frame.clientTop, w: fel.clientWidth, h: fel.clientHeight } };
      }
    } catch { /* cross-origin frame */ }
    // Otherwise: the largest scrollable element on screen.
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.clientHeight < 100 || !scrollable(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return {
      el: best, doc: document,
      rect: { x: r.left + best.clientLeft, y: r.top + best.clientTop, w: best.clientWidth, h: best.clientHeight },
    };
  }

  function hideFixed() {
    if (state.hidden) return;
    state.hidden = [];
    const docs = new Set([document, state.doc]);
    for (const doc of docs) {
      for (const el of doc.querySelectorAll('body *')) {
        const pos = doc.defaultView.getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          state.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    }
  }

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Overlay scrollbars would otherwise be painted into every tile.
  function hideScrollbars(doc) {
    const style = doc.createElement('style');
    style.textContent = '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}';
    doc.documentElement.appendChild(style);
    return style;
  }

  window.__snapFullPage = {
    async prepare() {
      const styles = [hideScrollbars(document)];
      const frameEl = document.querySelector('iframe#gsft_main, iframe[name="gsft_main"]');
      try { if (frameEl && frameEl.contentDocument) styles.push(hideScrollbars(frameEl.contentDocument)); } catch { /* cross-origin */ }
      await frame();
      const found = findScroller();
      if (!found) { styles.forEach((s) => s.remove()); return null; }
      state = { ...found, originalTop: found.el.scrollTop, hidden: null, styles };
      const rect = found.rect;
      return {
        rect: { x: rect.x, y: rect.y, w: rect.w, h: Math.min(rect.h, innerHeight - rect.y) },
        scrollHeight: found.el.scrollHeight,
        vw: innerWidth,
        vh: innerHeight,
      };
    },
    async scrollTo(y, hide) {
      state.el.scrollTop = y;
      if (hide) hideFixed();
      await frame();
      await new Promise((r) => setTimeout(r, 250)); // lazy content, transitions
      return state.el.scrollTop;
    },
    restore() {
      if (!state) return;
      for (const [el, value, prio] of state.hidden || []) {
        if (value) el.style.setProperty('visibility', value, prio);
        else el.style.removeProperty('visibility');
      }
      state.styles.forEach((s) => s.remove());
      state.el.scrollTop = state.originalTop;
      state = null;
    },
  };
})();
