// Creating capture records (§10). Used by the service worker (screenshots), the offscreen document
// and recorder window (recordings), and the editor (recovering partial recordings).

import { putBlob, saveCapture, getChunks, deleteChunks } from './db.js';
import { thumbnailFromSource } from './image.js';
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

export async function createScreenshotCapture({ blob, source, servicenow, jobId, title }) {
  const capture = await baseCapture({ kind: 'screenshot', blob, source, servicenow, jobId, title });
  capture.annotations = { version: 1, shapes: [] };
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
