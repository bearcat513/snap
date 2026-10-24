// Click highlights during tab recording (§6.6): a fading ring at each click point. Also remembers
// what was clicked, for step-by-step guides (§6): the element's accessible name and role and the
// click position as a fraction of the top window, never the value of a text field. Options come
// from window.__snapClickOpts = { rings, track } set just before injection.
(() => {
  if (window.__snapClickHighlight) { window.__snapClickHighlight.start(); return; }

  let host = null;
  let root = null;
  let opts = { rings: true, track: true };

  const clean = (s, max = 60) => {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    // Mask anything that looks sensitive (emails, numbers…) before it is stored.
    const S = globalThis.SnapSensitive;
    if (S && t) for (const m of S.findMatches(t).reverse()) t = `${t.slice(0, m.start)}…${t.slice(m.end)}`;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };

  const ROLE_ATTR = { tab: 'tab', menuitem: 'menuitem', menuitemcheckbox: 'menuitem', menuitemradio: 'menuitem', option: 'option',
    checkbox: 'checkbox', radio: 'radio', switch: 'switch', link: 'link', button: 'button', textbox: 'field', combobox: 'field', searchbox: 'field' };

  function roleOf(el) {
    const attr = (el.getAttribute('role') || '').toLowerCase();
    if (ROLE_ATTR[attr]) return ROLE_ATTR[attr];
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'field';
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable) return 'field';
    return 'element';
  }

  function nameOf(el, role) {
    const doc = el.ownerDocument;
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (role === 'field' || role === 'checkbox' || role === 'radio') {
      const label = el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name');
      return clean(label); // never the field's value
    }
    if (el.tagName === 'INPUT') return clean(el.value || el.getAttribute('title')); // button captions
    const text = el.innerText || el.textContent;
    if (text && text.trim()) return clean(text);
    return clean(el.getAttribute('title') || el.querySelector?.('img[alt]')?.getAttribute('alt'));
  }

  /** Offset of this frame inside the top window, or null if a cross-origin frame is in the way. */
  function frameOffset() {
    let x = 0;
    let y = 0;
    let w = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement;
        if (!fe) return null;
        const r = fe.getBoundingClientRect();
        x += r.left + fe.clientLeft;
        y += r.top + fe.clientTop;
        w = w.parent;
      }
      return { x, y, vw: w.innerWidth, vh: w.innerHeight };
    } catch {
      return null;
    }
  }

  function track(e) {
    const target = e.target instanceof Element
      ? e.target.closest('a[href],button,summary,input,select,textarea,label,[role],[onclick],[tabindex]') || e.target
      : null;
    if (!target) return;
    const role = roleOf(target);
    const off = frameOffset();
    const event = {
      at: Date.now(),
      fx: off ? (e.clientX + off.x) / off.vw : null,
      fy: off ? (e.clientY + off.y) / off.vh : null,
      label: nameOf(target, role),
      role,
    };
    // The worker keeps them, so they survive navigation within the recorded tab.
    chrome.runtime.sendMessage({ type: 'record:click', event }).catch(() => {});
  }

  function onDown(e) {
    if (opts.track && e.isPrimary !== false && e.button === 0) track(e);
    if (!root || !opts.rings) return;
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    root.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
  }

  window.__snapClickHighlight = {
    start() {
      opts = { rings: true, track: true, ...(window.__snapClickOpts || {}) };
      if (host) return;
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .ring{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;
              border:3px solid rgba(255,196,0,.95);background:rgba(255,196,0,.25);animation:snap-ring .7s ease-out forwards}
        @keyframes snap-ring{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}
      </style>`;
      document.documentElement.appendChild(host);
      window.addEventListener('pointerdown', onDown, true);
    },
    stop() {
      window.removeEventListener('pointerdown', onDown, true);
      if (host) host.remove();
      host = null;
      root = null;
    },
  };
  window.__snapClickHighlight.start();
})();
