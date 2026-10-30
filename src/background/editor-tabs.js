import { updateJob } from '../shared/jobs.js';

/** `after` is the after-capture action: 'copy' copies once loaded; 'save' saves in a background tab. */
export async function openEditor(captureId, { jobId, nearTabId, after } = {}) {
  const url = chrome.runtime.getURL(`src/editor/editor.html?capture=${encodeURIComponent(captureId)}${after ? `&after=${after}` : ''}`);
  const active = after !== 'save';
  let near = null;
  if (nearTabId) near = await chrome.tabs.get(nearTabId).catch(() => null);
  let tab;
  if (near) {
    tab = await chrome.tabs.create({ url, active, windowId: near.windowId, index: near.index + 1, openerTabId: near.id });
  } else {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    tab = win ? await chrome.tabs.create({ url, active, windowId: win.id }) : await chrome.windows.create({ url }).then((w) => w.tabs[0]);
  }
  if (jobId) await updateJob(jobId, { editorTabId: tab.id, captureId, state: 'editing' });
  return tab;
}

export async function openLibrary() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?view=library') });
}
