// Recorder window (§6.5): getDisplayMedia needs a visible extension page and a user gesture.

import { startRecording } from '../shared/recording.js';
import { getSettings, recordingQuality } from '../shared/settings.js';
import '../ui/theme.js';
import { t } from '../ui/i18n.js';
import { createJob, getJob, updateJob } from '../shared/jobs.js';
import { formatDuration } from '../shared/util.js';
import { installErrorLogging } from '../shared/diagnostics.js';

installErrorLogging('recorder');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const settings = await getSettings();
const quality = recordingQuality(settings);
let job = params.get('job') ? await getJob(params.get('job')) : null;
let rec = null;
let startedAt = 0;
let pausedAt = 0;
let pausedTotal = 0;
let timer = null;

$('opt-mic').checked = settings['recording.mic'];
$('opt-countdown').checked = settings['recording.countdown'];
if (job?.servicenow) {
  $('sn-context').hidden = false;
  $('sn-context').textContent = `For ${job.servicenow.label} (${job.servicenow.table})`;
}
const showMicHint = async () => {
  const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  $('mic-hint').hidden = !$('opt-mic').checked || perm?.state === 'granted';
};
$('opt-mic').addEventListener('change', showMicHint);
showMicHint();
$('link-options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

chrome.commands.getAll().then((cmds) => {
  const key = cmds.find((c) => c.name === 'record-pause')?.shortcut;
  if (key) { $('pause-key').textContent = key; $('pause-key').hidden = false; }
});

function show(id) {
  for (const s of ['setup', 'countdown', 'live', 'finishing']) $(s).hidden = s !== id;
}

async function countdown() {
  show('countdown');
  for (let n = 3; n > 0; n--) {
    $('count').textContent = String(n);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

$('btn-start').addEventListener('click', async () => {
  $('error').hidden = true;
  let stream;
  try {
    // Must be called straight from the click (transient activation) — the picker is always shown.
    stream = await navigator.mediaDevices.getDisplayMedia({
      // No size constraints here: Chrome treats them as a target and upscales small windows.
      video: { frameRate: { ideal: quality.fps, max: quality.fps } },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
    });
  } catch (err) {
    $('error').textContent = err.name === 'NotAllowedError' ? 'Sharing was cancelled.' : err.message;
    $('error').hidden = false;
    return;
  }
  try {
    if ($('opt-countdown').checked) await countdown();
    if (!job) job = await createJob({ kind: 'local', mode: 'record-window' });
    const track = stream.getVideoTracks()[0];
    await capResolution(track);
    const ts = track.getSettings();
    // Track labels for screens/windows are internal ids like "screen:0:0"; only tab labels are readable.
    const title = ts.displaySurface === 'browser' && track.label && !/^(screen|window|web-contents-media-stream):/.test(track.label) ? track.label
      : ts.displaySurface === 'window' ? 'Window recording' : ts.displaySurface === 'browser' ? 'Tab recording' : 'Screen recording';
    const source = { url: '', title, dpr: 1, width: ts.width, height: ts.height, surface: ts.displaySurface, fps: Math.round(ts.frameRate || quality.fps) };
    rec = await startRecording({
      jobId: job.id,
      stream,
      opts: { mic: $('opt-mic').checked, captions: settings['recording.captions'], maxMinutes: settings['recording.maxMinutes'], playback: false, videoBitsPerSecond: quality.videoBitsPerSecond },
      source,
      servicenow: job.servicenow,
    });
    await chrome.runtime.sendMessage({ type: 'recorder:started', jobId: job.id });
    startedAt = Date.now();
    show('live');
    $('max').textContent = `Stops automatically after ${settings['recording.maxMinutes']} min. “Stop sharing” in Chrome also ends the recording.`;
    if (rec.warnings.length) { $('warnings').hidden = false; $('warnings').textContent = rec.warnings.join(' '); }
    timer = setInterval(tick, 500);
    tick();
    rec.done.then(async ({ capture, quotaExceeded }) => {
      clearInterval(timer);
      await chrome.runtime.sendMessage({ type: 'recording:finished', jobId: job.id, captureId: capture.id, quotaExceeded });
      window.close();
    }, async (err) => {
      clearInterval(timer);
      await chrome.runtime.sendMessage({ type: 'recording:failed', jobId: job.id, error: err.message });
      show('setup');
      $('error').textContent = err.message;
      $('error').hidden = false;
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    show('setup');
    $('error').textContent = err.message;
    $('error').hidden = false;
    if (job) await updateJob(job.id, { state: 'failed', error: err.message });
  }
});

/** Scale the shared surface down (never up) to the resolution picked in Settings → Recording. */
async function capResolution(track) {
  const { width, height } = track.getSettings();
  const scale = Math.min(1, quality.maxWidth / (width || Infinity), quality.maxHeight / (height || Infinity));
  if (scale >= 1) return;
  await track.applyConstraints({ width: Math.round(width * scale), height: Math.round(height * scale), frameRate: { max: quality.fps } })
    .catch(() => { /* keep the native size */ });
}

function tick() {
  const now = pausedAt || Date.now();
  $('elapsed').textContent = formatDuration(now - startedAt - pausedTotal);
  const left = rec.remainingMs();
  $('limit').hidden = left > 60_000;
  if (left <= 60_000) $('limit-text').textContent = t('limit_stops_in', Math.max(0, Math.ceil(left / 1000)));
}

function setPaused(paused) {
  document.body.classList.toggle('paused', paused);
  $('state-label').textContent = paused ? 'Paused' : 'Recording';
  $('btn-pause').hidden = paused;
  $('btn-resume').hidden = !paused;
}

function pause() {
  if (!rec || pausedAt) return;
  rec.pause();
  pausedAt = Date.now();
  setPaused(true);
}
function resume() {
  if (!rec || !pausedAt) return;
  rec.resume();
  pausedTotal += Date.now() - pausedAt;
  pausedAt = 0;
  setPaused(false);
}
function stop() {
  if (!rec) return;
  show('finishing');
  rec.stop();
}

// Local buttons go through the worker so the badge/popup state stays in sync.
$('btn-pause').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'record:pause' }));
$('btn-resume').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'record:resume' }));
$('btn-stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'record:stop' }));
$('btn-extend').hidden = settings.locked.includes('recording.maxMinutes');
$('btn-extend').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'record:extend' }));

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.target !== 'recorder' || !job || msg.jobId !== job.id) return false;
  if (msg.type === 'record:pause') pause();
  if (msg.type === 'record:resume') resume();
  if (msg.type === 'record:stop') stop();
  if (msg.type === 'record:extend') rec?.extend();
  sendResponse({ ok: true });
  return false;
});

window.addEventListener('beforeunload', (e) => {
  if (rec && rec.state !== 'inactive') e.preventDefault();
});
