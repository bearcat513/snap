// Recording orchestration (§6.4–6.6). Tab recordings run in the offscreen document; window/screen
// recordings run in the recorder window (getDisplayMedia needs a visible page and a gesture).

import { getSettings } from '../shared/settings.js';
import { createJob, getJob, updateJob } from '../shared/jobs.js';
import { ensureOffscreen, closeOffscreen, sendToOffscreen } from './offscreen-client.js';
import { getRecording, setRecording, getFlag } from './state.js';
import { runCountdown } from './capture.js';

export async function startTabRecording(tab, { job } = {}) {
  if (await getRecording()) throw new Error('A recording is already in progress.');
  if (await getFlag('quotaBlocked')) throw new Error('Storage is full. Clear the library before recording again.');
  const settings = await getSettings();
  if (!job) job = await createJob({ kind: 'local', mode: 'record-tab', tabId: tab.id, windowId: tab.windowId });

  if (settings['recording.countdown']) await runCountdown(tab.id).catch(() => {});
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const source = { url: tab.url || '', title: tab.title || '', tabId: tab.id, dpr: 1, width: tab.width, height: tab.height };
  const res = await sendToOffscreen({
    type: 'record:start',
    jobId: job.id,
    streamId,
    opts: { mic: settings['recording.mic'], maxMinutes: settings['recording.maxMinutes'], playback: true },
    source,
    servicenow: job.servicenow,
  });
  if (!res || !res.ok) {
    await updateJob(job.id, { state: 'failed', error: res?.error });
    await closeOffscreen();
    throw new Error(res?.error || 'Could not start the recording.');
  }
  await setRecording({ jobId: job.id, kind: 'tab', tabId: tab.id, startedAt: Date.now(), paused: false, pausedTotal: 0 });
  if (settings['recording.clickHighlights']) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/content/click-highlight.js'] })
      .catch(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/click-highlight.js'] }).catch(() => {}));
  }
  return job;
}

export async function openRecorderWindow(job) {
  if (await getRecording()) throw new Error('A recording is already in progress.');
  const url = chrome.runtime.getURL(`src/recorder/recorder.html${job ? `?job=${encodeURIComponent(job.id)}` : ''}`);
  const win = await chrome.windows.create({ url, type: 'popup', width: 420, height: 400, focused: true });
  if (job) await updateJob(job.id, { recorderWindowId: win.id });
  return win;
}

/** Called by the recorder window once getDisplayMedia succeeded and MediaRecorder is running. */
export async function onRecorderStarted(jobId, windowId) {
  await setRecording({ jobId, kind: 'window', windowId, startedAt: Date.now(), paused: false, pausedTotal: 0 });
}

async function sendControl(type) {
  const rec = await getRecording();
  if (!rec) return null;
  const target = rec.kind === 'tab' ? 'offscreen' : 'recorder';
  await chrome.runtime.sendMessage({ target, type, jobId: rec.jobId }).catch(() => {});
  return rec;
}

export async function pauseRecording() {
  const rec = await sendControl('record:pause');
  if (rec && !rec.paused) await setRecording({ ...rec, paused: true, pausedAt: Date.now() });
}

export async function resumeRecording() {
  const rec = await sendControl('record:resume');
  if (rec && rec.paused) {
    await setRecording({ ...rec, paused: false, pausedAt: null, pausedTotal: rec.pausedTotal + (Date.now() - rec.pausedAt) });
  }
}

export async function stopRecording() {
  return sendControl('record:stop');
}

/** Cleanup after the recorder reports completion; returns the recording state that ended. */
export async function onRecordingEnded(jobId) {
  const rec = await getRecording();
  if (!rec || rec.jobId !== jobId) return null;
  await setRecording(null);
  if (rec.kind === 'tab') {
    if (rec.tabId) {
      chrome.scripting.executeScript({
        target: { tabId: rec.tabId, allFrames: true },
        func: () => window.__snapClickHighlight && window.__snapClickHighlight.stop(),
      }).catch(() => {});
    }
    await closeOffscreen();
  }
  return rec;
}

/** Recorder window closed or offscreen document lost mid-recording: keep chunks for recovery (§16). */
export async function markInterrupted(jobId) {
  const rec = await getRecording();
  if (rec && rec.jobId === jobId) await setRecording(null);
  const job = await getJob(jobId);
  if (job && job.state === 'recording') await updateJob(jobId, { state: 'interrupted' });
}
