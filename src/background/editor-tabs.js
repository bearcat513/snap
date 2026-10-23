import { updateJob } from '../shared/jobs.js';

export async function openEditor(captureId, { jobId, nearTabId } = {}) {
  const url = chrome.runtime.getURL(`src/editor/editor.html?capture=${encodeURIComponent(captureId)}`);
  let near = null;
  if (nearTabId) near = await chrome.tabs.get(nearTabId).catch(() => null);
  let tab;
  if (near) {
    tab = await chrome.tabs.create({ url, windowId: near.windowId, index: near.index + 1, openerTabId: near.id });
  } else {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    tab = win ? await chrome.tabs.create({ url, windowId: win.id }) : await chrome.windows.create({ url }).then((w) => w.tabs[0]);
  }
  if (jobId) await updateJob(jobId, { editorTabId: tab.id, captureId, state: 'editing' });
  return tab;
}

export async function openLibrary() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?view=library') });
}
