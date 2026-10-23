// Service-worker side of the SN Utils bridge (§11).

import '../shared/protocol.js';
import { getSettings, isSnHost, isBuiltinSnHost } from '../shared/settings.js';
import { createJob, getJob, updateJob, findJobs, jobByRequestId, pendingGestureJob } from '../shared/jobs.js';
import { getBlob, updateCapture, getCapture } from '../shared/db.js';
import { bytesToBase64 } from '../shared/util.js';
import { snErrorMessage, attachmentUrl } from '../shared/sn.js';
import { claimRequestId, getRecording } from './state.js';
import { snapVisible, snapRegion, snapFullPage } from './capture.js';
import { startTabRecording, openRecorderWindow } from './recording-control.js';
import { openEditor } from './editor-tabs.js';

const P = globalThis.SnapProtocol;
const FILE_CHUNK = 8 * 1024 * 1024;
const BRIDGE_URL = chrome.runtime.getURL('src/bridge/bridge.html');

function toFrame(job, msg) {
  return chrome.tabs.sendMessage(job.tabId, msg, { frameId: job.frameId || 0 }).catch(() => {});
}

async function shortcutFor(command) {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === command)?.shortcut || '';
}

export async function handleBridgeRequest(msg, sender) {
  const tab = sender.tab;
  if (!tab || !sender.url) return { ok: false, error: 'No sender tab' };
  const url = new URL(sender.url);
  const origin = url.origin;
  const settings = await getSettings();
  if (url.protocol !== 'https:' || !isSnHost(url.host, settings)) return { ok: false, error: 'This host is not a configured ServiceNow instance.' };

  const v = P.validateRequestPayload(msg.payload, { host: url.host, origin });
  if (!v.ok) return { ok: false, error: v.error };
  if (!(await claimRequestId(msg.requestId))) return { ok: false, error: 'Duplicate requestId' };
  const { mode, deliver, context } = v.payload;
  if (mode.startsWith('record') && (await getRecording())) return { ok: false, error: 'A recording is already in progress.' };

  const job = await createJob({
    kind: 'bridge',
    mode,
    requestId: msg.requestId,
    tabId: tab.id,
    frameId: sender.frameId || 0,
    windowId: tab.windowId,
    deliver,
    servicenow: { ...context, origin, requestId: msg.requestId },
  });
  runBridgeJob(job, tab).catch((err) => failJob(job, err));
  return { ok: true, jobId: job.id };
}

async function failJob(job, err) {
  await updateJob(job.id, { state: 'failed', error: err.message });
  await toFrame(job, { type: 'bridge:error', requestId: job.requestId, message: err.message });
}

async function promptForGesture(job) {
  const command = job.mode === 'record-tab' ? 'record-toggle' : job.mode === 'region' ? 'snap-region' : 'snap-visible';
  await updateJob(job.id, { state: 'awaiting-gesture' });
  await toFrame(job, {
    type: 'bridge:prompt',
    requestId: job.requestId,
    action: job.mode === 'record-tab' ? 'start recording' : 'take the screenshot',
    shortcut: await shortcutFor(command),
  });
}

async function runBridgeJob(job, tab) {
  if (job.mode === 'record-tab') return promptForGesture(job);
  if (job.mode === 'record-window') {
    await updateJob(job.id, { state: 'capturing' });
    await openRecorderWindow(job);
    return;
  }
  // captureVisibleTab needs activeTab or <all_urls>; ServiceNow host permissions are not enough
  // (§20 Q1, confirmed). Without the opt-in <all_urls> grant, ask for a gesture instead.
  if (!tab.active || !(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) return promptForGesture(job);
  try {
    await runCaptureJob(job, tab);
  } catch (err) {
    if (/permission|activeTab|Cannot access|not allowed/i.test(err.message)) return promptForGesture(job);
    throw err;
  }
}

async function runCaptureJob(job, tab) {
  await updateJob(job.id, { state: 'capturing' });
  const extra = { servicenow: job.servicenow, jobId: job.id };
  const capture = job.mode === 'region' ? await snapRegion(tab, extra)
    : job.mode === 'fullpage' ? await snapFullPage(tab, extra)
      : await snapVisible(tab, extra);
  if (!capture) {
    await updateJob(job.id, { state: 'cancelled' });
    await toFrame(job, { type: 'bridge:cancelled', requestId: job.requestId });
    return null;
  }
  await openEditor(capture.id, { jobId: job.id, nearTabId: tab.id });
  return capture;
}

/**
 * A user gesture on `tab` (command, toolbar popup, context menu). If a bridge request is waiting
 * for one, run it and return true.
 */
export async function runPendingForGesture(tab, kind) {
  const job = await pendingGestureJob(tab.id);
  if (!job) return false;
  const isRecord = job.mode === 'record-tab';
  if (kind !== 'any' && (kind === 'record') !== isRecord) return false;
  await toFrame(job, { type: 'bridge:prompt-clear', requestId: job.requestId });
  try {
    if (isRecord) {
      await updateJob(job.id, { state: 'capturing' });
      await startTabRecording(tab, { job });
    } else {
      await runCaptureJob(job, tab);
    }
  } catch (err) {
    await failJob(job, err);
    throw err;
  }
  return true;
}

export async function handleBridgeCancel(msg, sender) {
  const job = await jobByRequestId(msg.requestId, sender.tab?.id);
  if (!job || ['done', 'cancelled'].includes(job.state)) return { ok: false };
  await updateJob(job.id, { state: 'cancelled' });
  await toFrame(job, { type: 'bridge:cancelled', requestId: job.requestId });
  return { ok: true };
}

/** Editor asks to hand files to the page for attaching (§9.3). */
export async function handleDeliver({ jobId, files }) {
  const job = await getJob(jobId);
  if (!job || job.kind !== 'bridge') return { ok: false, error: 'This capture was not started from ServiceNow.' };
  if (job.delivery) return { ok: false, error: 'Files were already sent to this record. Run /snap again to attach more.' };
  const reason = await deliveryBlocker(job);
  if (reason) return { ok: false, error: reason };
  const token = crypto.randomUUID();
  await updateJob(job.id, { state: 'delivering', delivery: { state: 'pending', token, files } });
  const useIframe = isBuiltinSnHost(new URL(job.servicenow.origin).host);
  try {
    await chrome.tabs.sendMessage(job.tabId, { type: 'bridge:deliver', requestId: job.requestId, jobId, token, useIframe }, { frameId: job.frameId || 0 });
  } catch {
    await updateJob(job.id, { delivery: null, state: 'editing' });
    return { ok: false, error: 'The ServiceNow page is no longer reachable. Reload it and run /snap again, or download instead.' };
  }
  return { ok: true };
}

async function deliveryBlocker(job) {
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (!tab) return 'The ServiceNow tab was closed.';
  try {
    if (!tab.url || new URL(tab.url).origin !== job.servicenow.origin) return 'The ServiceNow tab navigated to another site.';
  } catch {
    return 'The ServiceNow tab navigated away.';
  }
  return null;
}

export async function snAvailability({ captureId }) {
  const capture = await getCapture(captureId);
  if (!capture?.servicenow) return { available: false, reason: 'Not started from ServiceNow (run /snap on a record).' };
  const job = await getJob(capture.jobId);
  if (!job) return { available: false, reason: 'The original /snap request has expired.' };
  if (job.delivery) {
    return job.delivery.state === 'done'
      ? { available: false, reason: 'Already attached. Run /snap again to attach more.' }
      : { available: false, reason: 'Delivery in progress…' };
  }
  if (['cancelled', 'failed'].includes(job.state)) return { available: false, reason: 'The /snap request was cancelled.' };
  const reason = await deliveryBlocker(job);
  return reason ? { available: false, reason } : { available: true };
}

function senderMayClaim(job, sender) {
  if (!sender.tab || sender.tab.id !== job.tabId) return false;
  if (sender.url && sender.url.startsWith(BRIDGE_URL)) return true; // bridge iframe
  return sender.origin === job.servicenow.origin && (sender.frameId || 0) === (job.frameId || 0); // content script
}

/** Bridge iframe / content script claims a pending delivery. Single use. */
export async function handleClaim({ jobId, token }, sender) {
  const job = await getJob(jobId);
  if (!job?.delivery || job.delivery.token !== token || job.delivery.state !== 'pending') return { ok: false, error: 'Unknown or used delivery' };
  if (!senderMayClaim(job, sender)) return { ok: false, error: 'Delivery not allowed from this frame' };
  await updateJob(job.id, { delivery: { ...job.delivery, state: 'claimed' } });
  return { ok: true, origin: job.servicenow.origin, requestId: job.requestId, files: job.delivery.files };
}

/** Chunked file transfer for frames that can't read IndexedDB directly (custom hosts, partitioned storage). */
export async function handleFetchFile({ jobId, token, index, offset }, sender) {
  const job = await getJob(jobId);
  if (!job?.delivery || job.delivery.token !== token || job.delivery.state !== 'claimed') return { ok: false, error: 'Delivery not claimed' };
  if (!senderMayClaim(job, sender)) return { ok: false, error: 'Not allowed' };
  const file = job.delivery.files[index];
  const blob = file && (await getBlob(file.blobId));
  if (!blob) return { ok: false, error: 'File missing' };
  const part = new Uint8Array(await blob.slice(offset, offset + FILE_CHUNK).arrayBuffer());
  return { ok: true, data: bytesToBase64(part), done: offset + part.length >= blob.size, size: blob.size };
}

export async function handleDeliveryFailed({ jobId, token, error }, sender) {
  const job = await getJob(jobId);
  if (!job?.delivery || job.delivery.token !== token || !senderMayClaim(job, sender)) return { ok: false };
  const results = job.delivery.files.map((f) => ({ name: f.name, ok: false, error }));
  await finishDelivery(job, results);
  return { ok: true };
}

/** Page reports attachment results (snap:uploaded). */
export async function handleBridgeResult(msg, sender) {
  const job = await jobByRequestId(msg.requestId, sender.tab?.id);
  if (!job?.delivery || job.delivery.state === 'done') return { ok: false };
  const v = P.validateUploadedPayload(msg.payload);
  if (!v.ok) return { ok: false, error: v.error };
  await finishDelivery(job, v.payload.results);
  return { ok: true };
}

async function finishDelivery(job, results) {
  await updateJob(job.id, { state: 'done', delivery: { ...job.delivery, state: 'done', results } });
  const at = new Date().toISOString();
  const saves = results.map((r) => ({
    adapter: 'servicenow',
    ok: r.ok,
    name: r.name,
    location: r.ok ? attachmentUrl(job.servicenow.origin, r.sysId) : undefined,
    error: r.ok ? undefined : snErrorMessage(r.error),
    at,
  }));
  if (job.captureId) await updateCapture(job.captureId, (c) => { c.saves = [...(c.saves || []), ...saves]; });
  chrome.runtime.sendMessage({ type: 'sn:result', jobId: job.id, captureId: job.captureId, saves }).catch(() => {});
}

/** Editor tab closed without delivering → tell the page the request is over (§11.1). */
export async function onTabClosed(tabId) {
  const jobs = await findJobs((j) => j.kind === 'bridge' && j.editorTabId === tabId && !j.delivery && !['done', 'cancelled', 'failed'].includes(j.state));
  for (const job of jobs) {
    await updateJob(job.id, { state: 'cancelled' });
    await toFrame(job, { type: 'bridge:cancelled', requestId: job.requestId });
  }
}
