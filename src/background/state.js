// Small pieces of service-worker state kept in chrome.storage.session (survives SW restarts,
// cleared when the browser closes), plus badge rendering.

const REC_KEY = 'recording';

export async function getRecording() {
  return (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;
}

export async function setRecording(rec) {
  if (rec) await chrome.storage.session.set({ [REC_KEY]: rec });
  else await chrome.storage.session.remove([REC_KEY, 'recLeft']);
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

/** Brief confirmation on the badge, for work that finished without opening a page. */
export async function flashOk(message) {
  await chrome.action.setBadgeBackgroundColor({ color: '#30a46c' });
  await chrome.action.setBadgeText({ text: '✓' });
  await chrome.action.setTitle({ title: `Snap Companion — ${message}` });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => refreshBadge(), 3000);
}

export async function refreshBadge() {
  const rec = await getRecording();
  const warn = await getFlag('libraryWarn');
  const quota = await getFlag('quotaBlocked');
  const session = await getFlag('session');
  let text = '';
  let color = '#d93025';
  let title = 'Snap Companion';
  if (session && !rec) {
    text = `S${session.captureIds.length}`;
    color = '#2563eb';
    title = `Snap Companion — capture session: ${session.captureIds.length} capture${session.captureIds.length === 1 ? '' : 's'}. Open the menu to finish.`;
  } else if (rec) {
    text = rec.paused ? 'II' : 'REC';
    color = rec.paused ? '#b45309' : '#d93025';
    title = rec.paused ? 'Snap Companion — recording paused' : 'Snap Companion — recording';
    const left = await getFlag('recLeft'); // set only in the last minute before the time limit
    if (!rec.paused && Number.isFinite(left)) {
      const s = Math.max(0, Math.ceil(left / 1000));
      text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      color = s > 30 ? '#b45309' : '#d93025';
      title = `Snap Companion — the recording stops in ${s} s (time limit)`;
    }
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
