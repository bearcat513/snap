// Keystroke overlay during tab recording: shows shortcuts and special keys in a pill at the bottom of
// the page so viewers can follow along. Password fields are ignored entirely, and plain typing in a
// text field shows as "typing…" rather than the characters.
(() => {
  if (window.__snapKeystrokes) { window.__snapKeystrokes.start(); return; }

  const MAC = /Mac|iP(hone|ad)/.test(navigator.platform);
  const NAMES = {
    ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc',
    Enter: '⏎ Enter', Backspace: '⌫', Delete: 'Del', Tab: '⇥ Tab', PageUp: 'PgUp', PageDown: 'PgDn',
  };
  const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Fn', 'AltGraph']);
  const COMPOSING = new Set(['Dead', 'Process', 'Unidentified', 'Compose']); // IME / accent keys

  let host = null;
  let pill = null;
  let items = [];
  let hideTimer = null;

  const isPassword = (t) => t instanceof HTMLInputElement && t.type === 'password';
  const isEditable = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  function label(e) {
    const mods = [];
    if (e.ctrlKey) mods.push(MAC ? '⌃' : 'Ctrl');
    if (e.altKey) mods.push(MAC ? '⌥' : 'Alt');
    if (e.shiftKey) mods.push(MAC ? '⇧' : 'Shift');
    if (e.metaKey) mods.push(MAC ? '⌘' : 'Win');
    const chord = e.ctrlKey || e.altKey || e.metaKey;
    if (!chord && (e.key.length === 1 || COMPOSING.has(e.key))) {
      if (isEditable(e.target)) return 'typing…';
      if (COMPOSING.has(e.key)) return null;
    }
    const special = NAMES[e.key] || (e.key.length > 1 ? e.key : null);
    if (chord) return [...mods, special || e.key.toUpperCase()].join(MAC ? '' : ' + ');
    if (special) return e.shiftKey ? `${MAC ? '⇧' : 'Shift + '}${special}` : special;
    return e.key;
  }

  function onKey(e) {
    if (!pill || e.repeat || MODIFIERS.has(e.key) || isPassword(e.target)) return;
    const text = label(e);
    if (!text) return;
    if (text === 'typing…' && items[items.length - 1] === text) { show(); return; }
    items = [...items, text].slice(-5);
    pill.replaceChildren(...items.map((t) => Object.assign(document.createElement('kbd'), { textContent: t })));
    show();
  }

  function show() {
    pill.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { pill.classList.remove('on'); items = []; }, 1500);
  }

  window.__snapKeystrokes = {
    start() {
      if (host) return;
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .pill{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);display:flex;gap:6px;padding:8px 10px;
              border-radius:12px;background:rgba(20,22,26,.85);box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .2s}
        .pill.on{opacity:1}
        kbd{font:600 18px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;padding:4px 10px;border-radius:6px;
            background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);white-space:nowrap}
      </style><div class="pill"></div>`;
      pill = root.querySelector('.pill');
      document.documentElement.appendChild(host);
      window.addEventListener('keydown', onKey, true);
    },
    stop() {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(hideTimer);
      if (host) host.remove();
      host = null;
      pill = null;
      items = [];
    },
  };
  window.__snapKeystrokes.start();
})();
