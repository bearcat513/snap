// Offscreen document lifecycle (§5.1). The document holds MediaStreams/MediaRecorder for tab recording.

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating = null;

async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  return contexts.length > 0;
}

export async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Record the captured tab with MediaRecorder and write recording chunks to IndexedDB.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

export async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

export async function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

export { hasOffscreen };
