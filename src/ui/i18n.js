// Localization (§5.9): messages live in _locales/<lang>/messages.json. Pages mark text with
// data-i18n="key" (and data-i18n-title / -placeholder / -aria-label); the English text in the HTML is
// the fallback when a message is missing. Scripts use t(key, ...substitutions).

export function t(key, ...subs) {
  try {
    return chrome.i18n.getMessage(key, subs.map(String)) || '';
  } catch {
    return '';
  }
}

/** Translate marked elements under `root`. */
export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const m = t(el.dataset.i18n);
    if (m) el.textContent = m;
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const data = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`; // i18nTitle, i18nAriaLabel…
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const m = t(el.dataset[data]);
      if (m) el.setAttribute(attr, m);
    }
  }
}

if (typeof document !== 'undefined') {
  try { document.documentElement.lang = chrome.i18n.getUILanguage(); } catch { /* keep the page's lang */ }
  localize();
}
