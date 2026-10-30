// First-run page, also reachable from Settings → About & diagnostics.

import '../ui/theme.js';

const $ = (id) => document.getElementById(id);

const cmds = await chrome.commands.getAll();
$('shortcuts').replaceChildren(...cmds.filter((c) => c.description).map((c) => {
  const li = document.createElement('li');
  const k = document.createElement('kbd');
  k.textContent = c.shortcut || 'not set';
  li.append(k, ` ${c.description}`);
  return li;
}));

$('btn-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('btn-library').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?view=library') }));
$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
