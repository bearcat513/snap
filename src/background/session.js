// Capture sessions (§6 multi-capture sessions): while a session is open, new screenshots and
// recordings are collected instead of each opening the editor. Finishing creates one "session"
// capture that exports as a single PDF report (and saves once to S3 or the ServiceNow record).

import { updateCapture } from '../shared/db.js';
import { createSessionCapture } from '../shared/captures.js';
import { updateJob } from '../shared/jobs.js';
import { refreshBadge } from './state.js';
import { openEditor } from './editor-tabs.js';

const KEY = 'session';

export async function getSession() {
  return (await chrome.storage.session.get(KEY))[KEY] || null;
}

async function setSession(session) {
  if (session) await chrome.storage.session.set({ [KEY]: session });
  else await chrome.storage.session.remove(KEY);
  await refreshBadge();
}

/** Start collecting. `job`/`servicenow` tie the session to a /snap request so it can be attached. */
export async function startSession({ job, tabId } = {}) {
  if (await getSession()) throw new Error('A capture session is already open.');
  const session = { id: crypto.randomUUID(), startedAt: Date.now(), captureIds: [], jobId: job?.id, servicenow: job?.servicenow, tabId };
  await setSession(session);
  return session;
}

/** Add a finished capture to the open session. Returns false when no session is open. */
export async function addToSession(capture) {
  const session = await getSession();
  if (!session || !capture) return false;
  await updateCapture(capture.id, (c) => { c.sessionId = session.id; });
  session.captureIds.push(capture.id);
  await setSession(session);
  return true;
}

/** Close the session and open the editor on its report. Returns the session capture (or null if empty). */
export async function finishSession({ nearTabId } = {}) {
  const session = await getSession();
  if (!session) return null;
  await setSession(null);
  if (!session.captureIds.length) {
    if (session.jobId) await updateJob(session.jobId, { state: 'cancelled' });
    return null;
  }
  const capture = await createSessionCapture({
    id: session.id, members: session.captureIds, servicenow: session.servicenow, jobId: session.jobId,
  });
  await openEditor(capture.id, { jobId: session.jobId, nearTabId: nearTabId || session.tabId });
  return capture;
}

/** Discard the session; its captures stay in the library as individual captures. */
export async function cancelSession() {
  const session = await getSession();
  await setSession(null);
  return session;
}
