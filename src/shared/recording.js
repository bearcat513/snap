// MediaRecorder engine shared by the offscreen document (tab capture) and the recorder window
// (window/screen capture). Chunks go to IndexedDB every second (§6.4) so crashes lose ≤1s.

import { appendChunk, saveCapture } from './db.js';
import { finalizeRecording } from './captures.js';
import { updateJob } from './jobs.js';
import { startCaptions } from './captions.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Mix the capture's own audio and (optionally) the microphone into one track (§6.6).
 * `playback` re-routes captured tab audio to the speakers, since tab capture mutes it (§6.4).
 */
async function mixAudio(stream, { mic, playback }) {
  const warnings = [];
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  let hasAudio = false;
  let micStream = null;

  if (stream.getAudioTracks().length) {
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(dest);
    if (playback) src.connect(ctx.destination);
    hasAudio = true;
  }
  if (mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      ctx.createMediaStreamSource(micStream).connect(dest);
      hasAudio = true;
    } catch (err) {
      warnings.push(`Microphone unavailable (${err.name}). Enable it in Options → Recording.`);
    }
  }
  const tracks = [...stream.getVideoTracks(), ...(hasAudio ? dest.stream.getAudioTracks() : [])];
  return {
    stream: new MediaStream(tracks),
    micTrack: micStream?.getAudioTracks()[0] || null,
    warnings,
    cleanup() {
      micStream?.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

async function grabFrame(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  try {
    await video.play();
    await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/**
 * Start recording `stream`. Returns controls plus `done`, a promise for the finished capture.
 * opts: { mic, captions, maxMinutes, playback, videoBitsPerSecond }
 */
export async function startRecording({ jobId, stream, opts = {}, source, servicenow }) {
  const mix = await mixAudio(stream, { mic: !!opts.mic, playback: !!opts.playback });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mix.stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: opts.videoBitsPerSecond || 2_500_000,
  });

  let seq = 0;
  let writes = Promise.resolve();
  let writeError = null;
  let startedAt = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let maxTimer = null;

  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const n = seq++;
    writes = writes.then(() => appendChunk(jobId, n, e.data)).catch((err) => {
      writeError = err;
      stop();
    });
  };

  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  function stop() {
    if (recorder.state !== 'inactive') recorder.stop();
  }

  for (const track of stream.getVideoTracks()) track.addEventListener('ended', stop);

  const thumbnail = grabFrame(stream);
  recorder.start(1000);
  startedAt = performance.now();
  if (opts.maxMinutes > 0) maxTimer = setTimeout(stop, opts.maxMinutes * 60_000);

  // On-device captions from the microphone (§6); recording time excludes pauses.
  let captions = null;
  if (opts.captions && mix.micTrack) {
    try {
      captions = await startCaptions(mix.micTrack, () => (pausedAt ? null : performance.now() - startedAt - pausedTotal));
    } catch (err) {
      mix.warnings.push(err.message);
    }
  } else if (opts.captions) {
    mix.warnings.push('Captions need the microphone: turn on narration for this recording.');
  }

  await updateJob(jobId, { state: 'recording', mimeType: recorder.mimeType || mimeType, source, servicenow });

  const done = stopped.then(async () => {
    clearTimeout(maxTimer);
    const cues = captions?.stop() || [];
    const end = performance.now();
    if (pausedAt) pausedTotal += end - pausedAt;
    stream.getTracks().forEach((t) => t.stop());
    mix.cleanup();
    await writes;
    const durationMs = Math.round(end - startedAt - pausedTotal);
    const capture = await finalizeRecording({
      jobId, mimeType: recorder.mimeType || mimeType, durationMs, source, servicenow,
      thumbnailBlob: await thumbnail,
    });
    if (writeError) {
      capture.warnings = [`Recording stopped early: ${writeError.name === 'QuotaExceededError' ? 'storage is full — clear the library' : writeError.message}`];
    }
    if (mix.warnings.length) capture.warnings = [...(capture.warnings || []), ...mix.warnings];
    if (cues.length) capture.captions = cues;
    if (capture.warnings || cues.length) await saveCapture(capture);
    return { capture, quotaExceeded: writeError?.name === 'QuotaExceededError' };
  });

  return {
    mimeType: recorder.mimeType || mimeType,
    warnings: mix.warnings,
    pause() {
      if (recorder.state === 'recording') { recorder.pause(); pausedAt = performance.now(); }
    },
    resume() {
      if (recorder.state === 'paused') { recorder.resume(); pausedTotal += performance.now() - pausedAt; pausedAt = 0; }
    },
    stop,
    get state() { return recorder.state; },
    done,
  };
}
