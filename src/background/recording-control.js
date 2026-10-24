// Recording orchestration (§6.4–6.6). Tab recordings run in the offscreen document; window/screen
// recordings run in the recorder window (getDisplayMedia needs a visible page and a gesture).

import { getSettings, recordingQuality } from '../shared/settings.js';
import { createJob, getJob, updateJob } from '../shared/jobs.js';
import { ensureOffscreen, closeOffscreen, sendToOffscreen } from './offscreen-client.js';
import { getRecording, setRecording, getFlag } from './state.js';
import { runCountdown } from './capture.js';
import { updateCapture } from '../shared/db.js';
import { videoTimeOf } from '../shared/guide.js';

export async function startTabRecording(tab, { job } = {}) {
  if (await getRecording()) throw new Error('A recording is already in progress.');
  if (await getFlag('quotaBlocked')) throw new Error('Storage is full. Clear the library before recording again.');
  const settings = await getSettings();
  if (!job) job = await createJob({ kind: 'local', mode: 'record-tab', tabId: tab.id, windowId: tab.windowId });

  if (settings['recording.countdown']) await runCountdown(tab.id).catch(() => {});
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const quality = recordingQuality(settings);
  const source = { url: tab.url || '', title: tab.title || '', tabId: tab.id, dpr: 1, width: tab.width, height: tab.height, fps: quality.fps };
  const res = await sendToOffscreen({
    type: 'record:start',
    jobId: job.id,
    streamId,
    opts: { mic: settings['recording.mic'], captions: settings['recording.captions'], maxMinutes: settings['recording.maxMinutes'], playback: true, quality, videoBitsPerSecond: quality.videoBitsPerSecond },
    source,
    servicenow: job.servicenow,
  });
  if (!res || !res.ok) {
    await updateJob(job.id, { state: 'failed', error: res?.error });
    await closeOffscreen();
    throw new Error(res?.error || 'Could not start the recording.');
  }
  await chrome.storage.session.remove(CLICKS_KEY);
  await setRecording({ jobId: job.id, kind: 'tab', tabId: tab.id, startedAt: Date.now(), paused: false, pausedTotal: 0, pauses: [] });
  injectRecordingOverlays(tab.id);
  return job;
}

/** Inject overlay scripts into every frame (falling back to the top frame), after an optional setup func. */
async function injectOverlay(tabId, files, func, args) {
  const run = async (target) => {
    if (func) await chrome.scripting.executeScript({ target, func, args });
    await chrome.scripting.executeScript({ target, files });
  };
  await run({ tabId, allFrames: true }).catch(() => run({ tabId }).catch(() => {}));
}

/** Inject the overlays chosen in Settings → Recording into the recorded tab (again after navigation). */
export async function injectRecordingOverlays(tabId) {
  const settings = await getSettings();
  const rings = settings['recording.clickHighlights'];
  const trackClicks = settings['recording.trackClicks'];
  if (rings || trackClicks) {
    await injectOverlay(tabId, ['src/shared/sensitive.js', 'src/content/click-highlight.js'], (o) => { window.__snapClickOpts = o; }, [{ rings, track: trackClicks }]);
  }
  if (settings['recording.keystrokes']) await injectOverlay(tabId, ['src/content/keystrokes.js']);
}

const CLICKS_KEY = 'recClicks';
let clickWrites = Promise.resolve();
const ROLES = ['link', 'button', 'checkbox', 'radio', 'switch', 'field', 'tab', 'menuitem', 'option', 'element'];
const fraction = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? Math.round(v * 10000) / 10000 : null);

/** A click reported by click-highlight.js in the recorded tab (content-script message: validate everything). */
export async function onRecordedClick(event, sender) {
  const rec = await getRecording();
  if (!rec || rec.kind !== 'tab' || sender.tab?.id !== rec.tabId || !event || typeof event !== 'object') return { ok: false };
  const clean = {
    at: Number.isFinite(event.at) ? event.at : Date.now(),
    fx: fraction(event.fx),
    fy: fraction(event.fy),
    label: typeof event.label === 'string' ? event.label.slice(0, 80) : '',
    role: ROLES.includes(event.role) ? event.role : 'element',
  };
  // Serialized: quick double clicks would otherwise race on the read-modify-write.
  clickWrites = clickWrites.then(async () => {
    const list = (await chrome.storage.session.get(CLICKS_KEY))[CLICKS_KEY] || [];
    list.push(clean);
    await chrome.storage.session.set({ [CLICKS_KEY]: list.slice(-500) });
  }).catch(() => {});
  await clickWrites;
  return { ok: true };
}

/** Clicks recorded during `rec`, converted to video time ({ t, fx, fy, label, role }); clears the buffer. */
async function collectClicks(rec) {
  await clickWrites;
  const list = (await chrome.storage.session.get(CLICKS_KEY))[CLICKS_KEY] || [];
  await chrome.storage.session.remove(CLICKS_KEY);
  return list
    .map((e) => ({ t: videoTimeOf(e.at, rec.startedAt, rec.pauses), fx: e.fx, fy: e.fy, label: e.label, role: e.role }))
    .filter((e) => e.t !== null)
    .sort((a, b) => a.t - b.t);
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
  await setRecording({ jobId, kind: 'window', windowId, startedAt: Date.now(), paused: false, pausedTotal: 0, pauses: [] });
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
  if (rec && !rec.paused) {
    const now = Date.now();
    await setRecording({ ...rec, paused: true, pausedAt: now, pauses: [...(rec.pauses || []), [now, null]] });
  }
}

export async function resumeRecording() {
  const rec = await sendControl('record:resume');
  if (rec && rec.paused) {
    const now = Date.now();
    const pauses = (rec.pauses || []).map(([from, to]) => [from, to ?? now]);
    await setRecording({ ...rec, paused: false, pausedAt: null, pausedTotal: rec.pausedTotal + (now - rec.pausedAt), pauses });
  }
}

export async function togglePauseRecording() {
  const rec = await getRecording();
  if (!rec) return;
  if (rec.paused) await resumeRecording(); else await pauseRecording();
}

export async function stopRecording() {
  return sendControl('record:stop');
}

/**
 * Cleanup after the recorder reports completion; returns the recording state that ended. With a
 * captureId, the clicks made during a tab recording are saved on it for guides.
 */
export async function onRecordingEnded(jobId, captureId) {
  const rec = await getRecording();
  if (!rec || rec.jobId !== jobId) return null;
  await setRecording(null);
  if (rec.kind === 'tab') {
    const clicks = await collectClicks(rec);
    if (captureId && clicks.length) await updateCapture(captureId, (c) => { c.clicks = clicks; });
    if (rec.tabId) {
      chrome.scripting.executeScript({
        target: { tabId: rec.tabId, allFrames: true },
        func: () => { window.__snapClickHighlight?.stop(); window.__snapKeystrokes?.stop(); },
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
