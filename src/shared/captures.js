// Creating capture records (§10). Used by the service worker (screenshots), the offscreen document
// and recorder window (recordings), and the editor (recovering partial recordings).

import { putBlob, getBlob, getCapture, saveCapture, getChunks, deleteChunks } from './db.js';
import { thumbnailFromSource, gridThumbnail } from './image.js';
import { fixWebmDuration } from './webm-duration.js';
import { updateJob } from './jobs.js';

export function browserLabel() {
  const ua = navigator.userAgentData;
  if (ua && ua.brands) {
    const brands = ua.brands.filter((b) => !/not.?a.?brand/i.test(b.brand));
    const pick = brands.find((b) => b.brand !== 'Chromium') || brands[0];
    if (pick) return `${pick.brand} ${pick.version}`;
  }
  const m = /(Edg|Chrome)\/(\d+)/.exec(navigator.userAgent);
  return m ? `${m[1] === 'Edg' ? 'Microsoft Edge' : 'Chrome'} ${m[2]}` : navigator.userAgent;
}

export function buildEnvironment({ source, servicenow, createdAt }) {
  let host = '';
  try { host = new URL(source.url).host; } catch { /* screen recording */ }
  return {
    instance: servicenow?.instance || host || '',
    table: servicenow?.table || '',
    label: servicenow?.label || '',
    browser: browserLabel(),
    viewport: source.width && source.height ? `${source.width}×${source.height}` : '',
    dpr: source.dpr || 1,
    capturedAt: createdAt,
    capturedBy: servicenow?.user || '',
  };
}

function defaultTitle(kind, source, servicenow) {
  if (servicenow) return `${servicenow.label} (${servicenow.table})`;
  if (source.title) return source.title.slice(0, 120);
  return kind === 'recording' ? 'Screen recording' : 'Screenshot';
}

async function baseCapture({ kind, blob, source, servicenow, jobId, title }) {
  const createdAt = new Date().toISOString();
  const originalBlobId = await putBlob(blob);
  return {
    id: crypto.randomUUID(),
    kind,
    createdAt,
    title: title || defaultTitle(kind, source, servicenow),
    source: { ...source, mimeType: blob.type },
    originalBlobId,
    thumbnailBlobId: null,
    context: { recordUrl: servicenow?.recordUrl || source.url || '', description: '', notes: '' },
    environment: buildEnvironment({ source, servicenow, createdAt }),
    servicenow: servicenow || undefined,
    jobId: jobId || undefined,
    saves: [],
  };
}

export async function createScreenshotCapture({ blob, source, servicenow, jobId, title, suggestions, devtools, sessionId }) {
  const capture = await baseCapture({ kind: 'screenshot', blob, source, servicenow, jobId, title });
  capture.annotations = { version: 1, shapes: [] };
  // Rectangles (image px) of text that looks sensitive; the editor offers to redact them.
  if (suggestions?.length) capture.suggestedRedactions = suggestions;
  if (devtools) capture.devtools = devtools;
  if (sessionId) capture.sessionId = sessionId;
  try {
    capture.thumbnailBlobId = await putBlob(await thumbnailFromSource(blob));
  } catch { /* thumbnail is optional */ }
  await saveCapture(capture);
  return capture;
}

/** Assemble chunks for a job into a recording capture. Safe to call for partial (crashed) jobs. */
export async function finalizeRecording({ jobId, mimeType, durationMs, source, servicenow, thumbnailBlob, partial = false }) {
  const chunks = await getChunks(jobId);
  if (!chunks.length) throw new Error('No recorded data was found for this recording.');
  const type = (mimeType || chunks[0].blob.type || 'video/webm').split(';')[0];
  let blob = new Blob(chunks.map((c) => c.blob), { type });
  if (type === 'video/webm' && durationMs) blob = await fixWebmDuration(blob, durationMs);

  const capture = await baseCapture({ kind: 'recording', blob, source: { ...source, durationMs }, servicenow, jobId });
  capture.source.mimeType = mimeType || type;
  if (partial) capture.title = `${capture.title} (recovered)`;
  if (thumbnailBlob) {
    try {
      capture.thumbnailBlobId = await putBlob(await thumbnailFromSource(thumbnailBlob));
      capture.posterBlobId = await putBlob(thumbnailBlob);
    } catch { /* optional */ }
  }
  await saveCapture(capture);
  await deleteChunks(jobId);
  await updateJob(jobId, { state: 'editing', captureId: capture.id });
  return capture;
}

/**
 * A session groups member captures (by id, in order) into one report (§6 multi-capture sessions).
 * It owns no media, only its own thumbnail; deleting it leaves the members in the library.
 */
export async function createSessionCapture({ id = crypto.randomUUID(), members, servicenow, jobId, title }) {
  const createdAt = new Date().toISOString();
  const first = await getCapture(members[0]);
  const source = { url: first?.source?.url || '', title: first?.source?.title || '', dpr: first?.source?.dpr || 1, width: first?.source?.width, height: first?.source?.height };
  const capture = {
    id,
    kind: 'session',
    createdAt,
    title: title || (servicenow ? `${servicenow.label} (${servicenow.table}) — ${members.length} captures` : `Session — ${members.length} capture${members.length === 1 ? '' : 's'}`),
    source,
    members: [...members],
    thumbnailBlobId: null,
    context: { recordUrl: servicenow?.recordUrl || source.url || '', description: '', notes: '' },
    environment: buildEnvironment({ source, servicenow, createdAt }),
    servicenow: servicenow || undefined,
    jobId: jobId || undefined,
    saves: [],
  };
  capture.thumbnailBlobId = await sessionThumbnail(members).catch(() => null);
  await saveCapture(capture);
  return capture;
}

/** A 2×2 grid of the first four members' thumbnails, stored as the session's own blob. */
export async function sessionThumbnail(memberIds) {
  const blobs = [];
  for (const mid of memberIds.slice(0, 4)) {
    const m = await getCapture(mid);
    const b = m && (await getBlob(m.thumbnailBlobId));
    if (b) blobs.push(b);
  }
  return blobs.length ? putBlob(await gridThumbnail(blobs)) : null;
}
