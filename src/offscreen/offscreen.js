// Offscreen document: holds the tab-capture MediaStream and MediaRecorder (§6.4).

import { startRecording } from '../shared/recording.js';

let current = null;

async function startTab({ jobId, streamId, opts, source, servicenow }) {
  if (current) throw new Error('Already recording');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
      },
    },
  });
  const rec = await startRecording({ jobId, stream, opts, source, servicenow });
  current = { jobId, rec };
  rec.done
    .then(({ capture, quotaExceeded }) => chrome.runtime.sendMessage({ type: 'recording:finished', jobId, captureId: capture.id, quotaExceeded }))
    .catch((err) => chrome.runtime.sendMessage({ type: 'recording:failed', jobId, error: err.message }))
    .finally(() => { current = null; });
  return { ok: true, mimeType: rec.mimeType, warnings: rec.warnings };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'record:start': return startTab(msg);
      case 'record:pause': current?.rec.pause(); return { ok: true };
      case 'record:resume': current?.rec.resume(); return { ok: true };
      case 'record:stop': current?.rec.stop(); return { ok: true };
      default: return { ok: false, error: `Unknown offscreen message ${msg.type}` };
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
