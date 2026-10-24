// Finds on-screen rectangles of sensitive text for suggested redactions (§6 smart redaction).
// Injected with shared/sensitive.js at capture time. Reads text nodes and form-field values in this
// document and in same-origin frames (ServiceNow's gsft_main); cross-origin frames can't be read.
// Only rectangles and a kind ("email", "phone"…) leave the page, never the matched text.
(() => {
  if (window.__snapFindSensitive) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);
  const FIELD_TYPES = new Set(['', 'text', 'email', 'tel', 'search', 'url', 'number']);
  const PAD = 2;

  function visible(el) {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }

  /**
   * opts: { patterns, custom, scope: 'viewport' | 'all' }.
   * Returns { rects: [{ x, y, w, h, kind }] in top-window CSS px (client coordinates), vw, vh, scrollX, scrollY }.
   */
  window.__snapFindSensitive = (opts) => {
    const S = globalThis.SnapSensitive;
    const rects = [];
    const vw = innerWidth;
    const vh = innerHeight;
    const add = (r, kind, ox, oy) => {
      const box = { x: r.left + ox - PAD, y: r.top + oy - PAD, w: r.width + 2 * PAD, h: r.height + 2 * PAD, kind };
      if (box.w < 3 || box.h < 3) return;
      if (opts.scope !== 'all' && (box.x > vw || box.y > vh || box.x + box.w < 0 || box.y + box.h < 0)) return;
      rects.push(box);
    };

    function scanDoc(doc, ox, oy, depth) {
      if (!doc.body || depth > 3) return;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.nodeValue.trim().length >= 6 && !SKIP.has(n.parentElement?.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      let node;
      let count = 0;
      while ((node = walker.nextNode()) && count++ < 20000) {
        const matches = S.findMatches(node.nodeValue, opts);
        if (!matches.length || !visible(node.parentElement)) continue;
        for (const m of matches) {
          const range = doc.createRange();
          range.setStart(node, m.start);
          range.setEnd(node, m.end);
          for (const r of range.getClientRects()) add(r, m.kind, ox, oy);
        }
      }
      // Form fields: values aren't text nodes, so the whole field is suggested.
      for (const el of doc.querySelectorAll('input, textarea')) {
        if (!el.value || !visible(el)) continue;
        const type = (el.getAttribute('type') || '').toLowerCase();
        let kind = null;
        if (type === 'password') kind = 'password';
        else if (el.tagName === 'TEXTAREA' || FIELD_TYPES.has(type)) kind = S.findMatches(el.value, opts)[0]?.kind || null;
        if (kind) add(el.getBoundingClientRect(), kind, ox, oy);
      }
      for (const frame of doc.querySelectorAll('iframe, frame')) {
        let inner;
        try { inner = frame.contentDocument; } catch { continue; }
        if (!inner) continue;
        const fr = frame.getBoundingClientRect();
        scanDoc(inner, ox + fr.left + frame.clientLeft, oy + fr.top + frame.clientTop, depth + 1);
      }
    }

    scanDoc(document, 0, 0, 0);
    return { rects: rects.slice(0, 500), vw, vh, scrollX, scrollY };
  };
})();
