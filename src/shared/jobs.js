// Capture-job records in IndexedDB (§10 `jobs` store). Job state survives service-worker restarts.
//
// States: created → awaiting-gesture → capturing → recording → editing → delivering → done
//         (or cancelled / interrupted / failed)

import { get, put, getAll } from './db.js';

export async function createJob(fields) {
  const now = new Date().toISOString();
  const job = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, state: 'created', kind: 'local', ...fields };
  await put('jobs', job);
  return job;
}

export const getJob = (id) => (id ? get('jobs', id) : Promise.resolve(null));

export async function updateJob(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  Object.assign(job, typeof patch === 'function' ? patch(job) || {} : patch, { updatedAt: new Date().toISOString() });
  await put('jobs', job);
  return job;
}

export async function findJobs(pred) {
  const all = await getAll('jobs');
  return all.filter((j) => j.kind !== 'upload' && pred(j)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function pendingGestureJob(tabId) {
  const [job] = await findJobs((j) => j.state === 'awaiting-gesture' && j.tabId === tabId);
  return job || null;
}

export async function jobByRequestId(requestId, tabId) {
  const [job] = await findJobs((j) => j.requestId === requestId && j.tabId === tabId);
  return job || null;
}
