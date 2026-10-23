// Small pieces of service-worker state kept in chrome.storage.session (survives SW restarts,
// cleared when the browser closes), plus badge rendering.

const REC_KEY = 'recording';

export async function getRecording() {
  return (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;
}

export async function setRecording(rec) {
  if (rec) await chrome.storage.session.set({ [REC_KEY]: rec });
  else await chrome.storage.session.remove(REC_KEY);
  await refreshBadge();
}

export async function getFlag(key) {
  return (await chrome.storage.session.get(key))[key];
}

export async function setFlag(key, value) {
  if (value === undefined || value === null || value === false) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: value });
  await refreshBadge();
}

/** Single-use request IDs (§11.4). Returns false if the ID was seen before. */
export async function claimRequestId(requestId) {
  const used = (await getFlag('usedRequestIds')) || [];
  if (used.includes(requestId)) return false;
  used.push(requestId);
  await chrome.storage.session.set({ usedRequestIds: used.slice(-500) });
  return true;
}

let flashTimer = null;

export async function flashError(message) {
  await chrome.storage.session.set({ lastError: { message, at: Date.now() } });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: 'ERR' });
  await chrome.action.setTitle({ title: `Snap Companion — ${message}` });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => refreshBadge(), 5000);
}

export async function refreshBadge() {
  const rec = await getRecording();
  const warn = await getFlag('libraryWarn');
  const quota = await getFlag('quotaBlocked');
  let text = '';
  let color = '#d93025';
  let title = 'Snap Companion';
  if (rec) {
    text = rec.paused ? 'II' : 'REC';
    color = rec.paused ? '#b45309' : '#d93025';
    title = rec.paused ? 'Snap Companion — recording paused' : 'Snap Companion — recording';
  } else if (quota) {
    text = '!';
    title = 'Snap Companion — storage full: clear the library to record again';
  } else if (warn) {
    text = '!';
    color = '#b45309';
    title = 'Snap Companion — library over its size limit with unsaved captures';
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}
