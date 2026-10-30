let toastTimer = null;

/** `action` ({ label, onClick }) adds a button to the toast. */
export function toast(message, ms = 3500, action) {
  const el = document.getElementById('toast');
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.classList.remove('show'); action.onClick(); });
    el.append(' ', btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function confirmDialog({ title, message, ok = 'Continue', cancel = 'Cancel' }) {
  const dlg = document.getElementById('confirm-dialog');
  dlg.querySelector('h3').textContent = title;
  dlg.querySelector('p').textContent = message;
  dlg.querySelector('[value="ok"]').textContent = ok;
  dlg.querySelector('[value="cancel"]').textContent = cancel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

export async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

let closeOpenMenu = null;

/**
 * Pop-up menu behavior: click or arrow keys to open, arrows / Home / End to move, Esc to close and
 * return to the button, Tab or a click elsewhere to close. Items are read on each key, so they can change.
 */
export function wireMenu(button, menu) {
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')].filter((b) => !b.hidden && !b.disabled);
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (closeOpenMenu === close) closeOpenMenu = null;
  };
  const open = (focusLast) => {
    closeOpenMenu?.();
    closeOpenMenu = close;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const list = items();
    list[focusLast ? list.length - 1 : 0]?.focus();
  };
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    open(e.key === 'ArrowUp');
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('[role^="menuitem"]')) close(); });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation(); // not the page's own shortcuts while in a menu
    const list = items();
    const i = list.indexOf(document.activeElement);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next !== undefined && list.length) {
      e.preventDefault();
      list[(next + list.length) % list.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      button.focus();
    } else if (e.key === 'Tab') close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('click', () => closeOpenMenu?.());
