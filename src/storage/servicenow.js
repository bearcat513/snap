// ServiceNow attachment adapter (§9.3). The page uploads with its own session; this adapter only
// hands the files to the service worker → content script → bridge iframe, then waits for results.

import { destinationAllowed } from '../shared/settings.js';
import { attachmentProblem, workNoteText } from '../shared/sn.js';

const RESULT_TIMEOUT = 5 * 60_000;

function waitForResult(jobId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(null);
    }, RESULT_TIMEOUT);
    const listener = (msg) => {
      if (!msg || msg.type !== 'sn:result' || msg.jobId !== jobId) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg.saves);
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

export const servicenowAdapter = {
  id: 'servicenow',
  label: 'ServiceNow record',

  async isAvailable(ctx) {
    if (!destinationAllowed('servicenow', ctx.settings)) return { available: false, reason: 'Disabled by your organization.' };
    if (!ctx.capture.servicenow) return { available: false, reason: 'Run /snap from a record to attach captures to it.' };
    const res = await chrome.runtime.sendMessage({ type: 'sn:availability', captureId: ctx.capture.id });
    return res || { available: false, reason: 'Extension worker did not respond.' };
  },

  async save(file, ctx, onProgress) {
    const [r] = await this.saveAll([file], ctx, onProgress);
    return r;
  },

  /** One bridge request is single-use, so every file for the record goes in one hand-off. */
  async saveAll(files, ctx) {
    const jobId = ctx.capture.jobId;
    // Check the instance's attachment limits (read by /snap) before handing anything over.
    const limits = ctx.capture.servicenow?.limits;
    const rejected = files.map((f) => ({ f, error: attachmentProblem(f, limits) })).filter((x) => x.error)
      .map(({ f, error }) => ({ adapter: 'servicenow', ok: false, name: f.name, error }));
    files = files.filter((f) => !attachmentProblem(f, limits));
    if (!files.length) return rejected;
    const note = ctx.settings['servicenow.workNote'] ? workNoteText({ capture: ctx.capture, files, links: ctx.links }) : '';
    const resultPromise = waitForResult(jobId);
    const res = await chrome.runtime.sendMessage({
      type: 'bridge.deliver',
      jobId,
      note,
      files: files.map(({ name, mimeType, blobId, size }) => ({ name, mimeType, blobId, size })),
    });
    if (!res || !res.ok) {
      return [...rejected, ...files.map((f) => ({ adapter: 'servicenow', ok: false, name: f.name, error: res?.error || 'Delivery failed' }))];
    }
    const saves = await resultPromise;
    if (!saves) {
      const error = 'No response from the ServiceNow page (timed out). Keep the record open and retry; if you reloaded it, run /snap again.';
      return [...rejected, ...files.map((f) => ({ adapter: 'servicenow', ok: false, name: f.name, error }))];
    }
    // The service worker already recorded these on the capture.
    return [...rejected, ...saves.map((s) => ({ ...s, persisted: true }))];
  },
};
