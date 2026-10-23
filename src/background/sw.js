// Service worker entry (§5): commands, context menus, popup/editor/content messages, recording lifecycle.
// Stateless across restarts — job state lives in IndexedDB, small flags in storage.session.

import { getSettings } from '../shared/settings.js';
import { enforceRetention, purgeEphemeralBlobs } from '../shared/db.js';
import { getJob, findJobs } from '../shared/jobs.js';
import { isCapturableUrl } from '../shared/util.js';
import { snapVisible, snapRegion, snapFullPage } from './capture.js';
import {
  startTabRecording, openRecorderWindow, onRecorderStarted, pauseRecording, resumeRecording,
  stopRecording, onRecordingEnded, markInterrupted,
} from './recording-control.js';
import * as bridge from './bridge.js';
import { openEditor, openLibrary } from './editor-tabs.js';
import { getRecording, setFlag, getFlag, refreshBadge, flashError } from './state.js';
import { syncCustomContentScripts } from './content-scripts.js';
import { hasOffscreen } from './offscreen-client.js';

// ---------- install / startup ----------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'frame', 'selection', 'link', 'image'];
    chrome.contextMenus.create({ id: 'snap-visible', title: 'Snap visible area', contexts });
    chrome.contextMenus.create({ id: 'snap-region', title: 'Snap region…', contexts });
    chrome.contextMenus.create({ id: 'snap-fullpage', title: 'Snap full page', contexts });
    chrome.contextMenus.create({ id: 'record-tab', title: 'Record this tab', contexts });
  });
  await startup();
});

chrome.runtime.onStartup.addListener(startup);

async function startup() {
  await syncCustomContentScripts().catch((e) => console.warn('content script sync', e));
  await purgeEphemeralBlobs().catch(() => {});
  // A recording that was live when the browser/SW died can't continue without its offscreen document.
  const rec = await getRecording();
  if (rec && rec.kind === 'tab' && !(await hasOffscreen())) await markInterrupted(rec.jobId);
  await refreshBadge();
}

chrome.permissions.onAdded.addListener(() => syncCustomContentScripts().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => syncCustomContentScripts().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'sync' || area === 'managed') && changes.snHosts) syncCustomContentScripts().catch(() => {});
});

// ---------- user entry points ----------

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    await flashError(err.message || String(err));
    return null;
  }
}

function assertCapturable(tab) {
  if (!tab) throw new Error('No active tab.');
  // tab.url is hidden unless we hold activeTab/host access; let captureVisibleTab report those cases.
  if (tab.url && !isCapturableUrl(tab.url)) throw new Error("Chrome doesn't allow capturing this page.");
}

async function afterCapture(capture, tab) {
  if (!capture) return;
  await openEditor(capture.id, { jobId: capture.jobId, nearTabId: tab.id });
  await applyRetention();
}

async function applyRetention() {
  const s = await getSettings();
  const { warn } = await enforceRetention({ maxItems: s['library.maxItems'], maxMB: s['library.maxMB'] });
  await setFlag('libraryWarn', warn);
}

export async function doCapture(mode, tab) {
  assertCapturable(tab);
  if (await bridge.runPendingForGesture(tab, 'capture')) return;
  const capture = mode === 'region' ? await snapRegion(tab) : mode === 'fullpage' ? await snapFullPage(tab) : await snapVisible(tab);
  await afterCapture(capture, tab);
}

/** Delayed capture (§4): count down on the toolbar badge so the user can open menus, hover, etc. */
async function badgeCountdown(seconds) {
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  for (let n = seconds; n > 0; n--) {
    await chrome.action.setBadgeText({ text: String(n) });
    await new Promise((r) => setTimeout(r, 1000));
  }
  await refreshBadge();
}

async function toggleTabRecording(tab) {
  if (await getRecording()) return stopRecording();
  assertCapturable(tab);
  if (await bridge.runPendingForGesture(tab, 'record')) return;
  await startTabRecording(tab);
}

chrome.commands.onCommand.addListener((command, tab) => guarded(async () => {
  tab = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (command === 'snap-visible') return doCapture('visible', tab);
  if (command === 'snap-region') return doCapture('region', tab);
  if (command === 'record-toggle') return toggleTabRecording(tab);
}));

chrome.contextMenus.onClicked.addListener((info, tab) => guarded(async () => {
  if (info.menuItemId === 'snap-visible') return doCapture('visible', tab);
  if (info.menuItemId === 'snap-region') return doCapture('region', tab);
  if (info.menuItemId === 'snap-fullpage') return doCapture('fullpage', tab);
  if (info.menuItemId === 'record-tab') return toggleTabRecording(tab);
}));

// ---------- tab / window lifecycle ----------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRecording();
  if (rec && rec.kind === 'tab' && rec.tabId === tabId) await stopRecording(); // §16: finalize, open editor
  await bridge.onTabClosed(tabId);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const rec = await getRecording();
  if (rec && rec.kind === 'window' && rec.windowId === windowId) await markInterrupted(rec.jobId);
});

// ---------- messages ----------

const handlers = {
  // popup
  'popup:state': async ({ tabId }) => {
    const [recording, pending, lastError] = await Promise.all([
      getRecording(),
      tabId ? findJobs((j) => j.state === 'awaiting-gesture' && j.tabId === tabId).then((l) => l[0] || null) : null,
      getFlag('lastError'),
    ]);
    await chrome.storage.session.remove('lastError');
    return { recording, pending, lastError: lastError && Date.now() - lastError.at < 60_000 ? lastError.message : null, quotaBlocked: !!(await getFlag('quotaBlocked')) };
  },
  'capture:start': async ({ mode, tabId, delaySeconds }) => {
    const tab = await chrome.tabs.get(tabId);
    guarded(async () => {
      if (delaySeconds > 0) await badgeCountdown(Math.min(30, delaySeconds));
      await doCapture(mode, tab);
    });
    return { ok: true };
  },
  'record:tab:start': async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    guarded(async () => {
      assertCapturable(tab);
      if (!(await bridge.runPendingForGesture(tab, 'record'))) await startTabRecording(tab);
    });
    return { ok: true };
  },
  'bridge:run-pending': async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    guarded(() => bridge.runPendingForGesture(tab, 'any'));
    return { ok: true };
  },
  'record:window:open': async () => {
    await openRecorderWindow(null);
    return { ok: true };
  },
  'record:pause': async () => { await pauseRecording(); return { ok: true }; },
  'record:resume': async () => { await resumeRecording(); return { ok: true }; },
  'record:stop': async () => { await stopRecording(); return { ok: true }; },
  'open:library': async () => { await openLibrary(); return { ok: true }; },

  // recorder window / offscreen
  'recorder:started': async ({ jobId }, sender) => {
    await onRecorderStarted(jobId, sender.tab?.windowId);
    return { ok: true };
  },
  'recording:finished': async ({ jobId, captureId, quotaExceeded }) => {
    const rec = await onRecordingEnded(jobId);
    if (quotaExceeded) await setFlag('quotaBlocked', true);
    const job = await getJob(jobId);
    await openEditor(captureId, { jobId: job?.kind === 'bridge' ? jobId : undefined, nearTabId: job?.tabId || rec?.tabId });
    await applyRetention();
    return { ok: true };
  },
  'recording:failed': async ({ jobId, error }) => {
    await onRecordingEnded(jobId);
    await markInterrupted(jobId);
    await flashError(error || 'Recording failed');
    return { ok: true };
  },

  // editor / library
  'library:changed': async () => {
    await setFlag('quotaBlocked', false);
    await applyRetention();
    return { ok: true };
  },
  'sn:availability': (msg) => bridge.snAvailability(msg),
  'bridge.deliver': (msg) => bridge.handleDeliver(msg),

  // content script / bridge iframe
  'bridge.request': (msg, sender) => bridge.handleBridgeRequest(msg, sender),
  'bridge.result': (msg, sender) => bridge.handleBridgeResult(msg, sender),
  'bridge.cancel': (msg, sender) => bridge.handleBridgeCancel(msg, sender),
  'bridge.claim': (msg, sender) => bridge.handleClaim(msg, sender),
  'bridge.fetchFile': (msg, sender) => bridge.handleFetchFile(msg, sender),
  'bridge.deliveryFailed': (msg, sender) => bridge.handleDeliveryFailed(msg, sender),
};

// Messages from content scripts may only use the bridge handlers.
const CONTENT_ALLOWED = new Set(['bridge.request', 'bridge.result', 'bridge.cancel', 'bridge.claim', 'bridge.fetchFile']);
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== 'sw')) return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  const fromExtension = sender.id === chrome.runtime.id && sender.origin === EXTENSION_ORIGIN;
  if (!fromExtension && !CONTENT_ALLOWED.has(msg.type)) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => {
      console.error(msg.type, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true;
});
