// Download adapter (§9.1).

import { getBlob } from '../shared/db.js';
import { destinationAllowed } from '../shared/settings.js';

function waitForDownload(id, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const done = (state) => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(state);
    };
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') done(delta.state.current);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
  });
}

export const downloadAdapter = {
  id: 'download',
  label: 'Download',

  async isAvailable(ctx) {
    return destinationAllowed('download', ctx.settings)
      ? { available: true }
      : { available: false, reason: 'Disabled by your organization.' };
  },

  async save(file, ctx) {
    const blob = await getBlob(file.blobId);
    if (!blob) return { adapter: 'download', ok: false, name: file.name, error: 'File data missing' };
    const url = URL.createObjectURL(blob);
    const sub = (ctx.settings.downloadSubfolder || '').replace(/^[\\/]+|[\\/]+$/g, '').replace(/\.\.+/g, '_');
    try {
      const id = await chrome.downloads.download({
        url,
        filename: sub ? `${sub}/${file.name}` : file.name,
        saveAs: !!ctx.settings.askWhereToSave,
        conflictAction: 'uniquify',
      });
      const state = await waitForDownload(id);
      if (state === 'interrupted') {
        const [item] = await chrome.downloads.search({ id });
        return { adapter: 'download', ok: false, name: file.name, error: item?.error === 'USER_CANCELED' ? 'Cancelled' : `Download failed (${item?.error || 'interrupted'})` };
      }
      const [item] = await chrome.downloads.search({ id });
      return { adapter: 'download', ok: true, name: file.name, location: item?.filename || file.name, downloadId: id };
    } catch (err) {
      return { adapter: 'download', ok: false, name: file.name, error: err.message };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};
