// Captions and transcripts for narrated recordings (§6). Speech is recognised on the device only
// (SpeechRecognition with processLocally); without an on-device model nothing is recognised and
// no audio leaves the browser. Cues: [{ startMs, endMs, text }] in recording time.

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function vttTime(ms) {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}`;
}

/** Cues inside [start, end], shifted so the exported range starts at 0. */
export function cuesInRange(cues, [start, end]) {
  return (cues || [])
    .filter((c) => c.endMs > start && c.startMs < end && c.text.trim())
    .map((c) => ({ startMs: Math.max(0, c.startMs - start), endMs: Math.min(end, c.endMs) - start, text: c.text.trim() }));
}

/** WebVTT for the exported range. */
export function buildVtt(cues, range) {
  const lines = ['WEBVTT', ''];
  cuesInRange(cues, range).forEach((c, i) => {
    lines.push(String(i + 1), `${vttTime(c.startMs)} --> ${vttTime(Math.max(c.endMs, c.startMs + 500))}`, c.text.replace(/-->/g, '→'), '');
  });
  return lines.join('\n');
}

export function transcriptText(cues, range) {
  return cuesInRange(cues, range).map((c) => c.text).join(' ');
}

/**
 * Turn a final recognition result into a cue. Recognition gives no timestamps, so the cue runs
 * from the later of the previous cue's end and an estimate from the word count (~380 ms a word)
 * to the moment the result arrived.
 */
export function cueFor(text, arrivedMs, prevEndMs = 0) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const startMs = Math.max(prevEndMs, arrivedMs - Math.max(800, words * 380));
  return { startMs: Math.round(startMs), endMs: Math.round(Math.max(arrivedMs, startMs + 500)), text: text.trim() };
}

const SR = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' for on-device recognition. */
export async function onDeviceStatus(lang = navigator.language) {
  const Rec = SR();
  if (!Rec || typeof Rec.available !== 'function' || !('processLocally' in Rec.prototype)) return 'unsupported';
  try {
    return await Rec.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unsupported';
  }
}

/** Download the on-device model (needs a user gesture). Resolves true when installed. */
export async function installOnDevice(lang = navigator.language) {
  const Rec = SR();
  if (!Rec || typeof Rec.install !== 'function') return false;
  return Rec.install({ langs: [lang], processLocally: true }).catch(() => false);
}

/**
 * Recognise speech on `track` (a microphone MediaStreamTrack) until stop(). `clock()` returns the
 * recording time in ms, or null while paused. Returns { stop(): cues } or throws if unavailable.
 */
export async function startCaptions(track, clock, lang = navigator.language) {
  const status = await onDeviceStatus(lang);
  if (status !== 'available') {
    throw new Error(status === 'unsupported'
      ? "Captions need Chrome's on-device speech recognition, which this browser doesn't have."
      : 'Captions: download the speech model first (Settings → Recording).');
  }
  const Rec = SR();
  const cues = [];
  let running = true;
  const rec = new Rec();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = false;
  rec.processLocally = true;
  rec.onresult = (e) => {
    const now = clock();
    if (now === null) return; // paused
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal && r[0]?.transcript?.trim()) cues.push(cueFor(r[0].transcript, now, cues[cues.length - 1]?.endMs || 0));
    }
  };
  // Recognition ends itself after silence; keep it going for the whole recording.
  rec.onend = () => { if (running) { try { rec.start(track); } catch { /* already started */ } } };
  rec.start(track);
  return {
    stop() {
      running = false;
      try { rec.stop(); } catch { /* not running */ }
      return cues;
    },
  };
}
