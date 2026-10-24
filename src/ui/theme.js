// Applies the theme picked in Settings (system / light / dark) to an extension page. The last value
// is cached in localStorage so pages don't flash the wrong theme while settings load.

import { getSettings } from '../shared/settings.js';

const KEY = 'snap.theme';

function set(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(KEY, theme); } catch { /* cache only */ }
}

try { set(localStorage.getItem(KEY) || 'system'); } catch { /* no storage */ }

export async function applyTheme() {
  set((await getSettings())['ui.theme']);
}

applyTheme();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['ui.theme']) set(changes['ui.theme'].newValue || 'system');
});
