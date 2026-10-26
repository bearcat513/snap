// Page-only screenshots for /snap-lite: one frame of the current tab through getDisplayMedia (Chrome
// shows its share picker every time; an extension is the only way around that), plus the extension's
// region and element pickers and sensitive-text scan, which are plain page scripts.

import '../src/shared/sensitive.js';
import '../src/content/sensitive-scan.js';
import '../src/content/region-select.js';
import '../src/content/element-select.js';
import { suggestionsToImage } from '../src/shared/image.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** getDisplayMedia needs a recent user gesture; if the slash command's has expired, ask for a click. */
async function displayStream() {
  const opts = { video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' };
  try {
    return await navigator.mediaDevices.getDisplayMedia(opts);
  } catch (err) {
    if (err.name !== 'InvalidStateError') throw err;
    await clickToContinue('Click to capture this tab');
    return navigator.mediaDevices.getDisplayMedia(opts);
  }
}

function clickToContinue(label) {
  return new Promise((resolve) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;font:600 13px system-ui,sans-serif;'
      + 'padding:8px 14px;border-radius:6px;border:0;background:#2563eb;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer';
    b.addEventListener('click', () => { b.remove(); resolve(); }, { once: true });
    document.documentElement.appendChild(b);
  });
}

/**
 * One frame of the tab the user shares. Returns { bitmap, scan, matchesPage } where `scan` is the
 * sensitive-text scan taken at the same moment and `matchesPage` says the frame looks like this
 * page's viewport (the user picked this tab), so DOM coordinates can be mapped onto it.
 */
async function grabFrame(redaction) {
  const stream = await displayStream();
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // Chrome's "Sharing this tab" bar can resize the viewport; let layout settle first.
    await sleep(350);
    await nextFrame();
    const scan = window.__snapFindSensitive({ ...redaction, scope: 'viewport' });
    const bitmap = await createImageBitmap(video);
    const matchesPage = stream.getVideoTracks()[0]?.getSettings().displaySurface === 'browser'
      && Math.abs(bitmap.width / bitmap.height - innerWidth / innerHeight) < 0.02;
    return { bitmap, scan, matchesPage };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

async function crop(bitmap, r) {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.min(bitmap.width - x, Math.round(r.w));
  const h = Math.min(bitmap.height - y, Math.round(r.h));
  const out = await createImageBitmap(bitmap, x, y, w, h);
  bitmap.close();
  return out;
}

function toDataUrl(bitmap) {
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * mode: 'screenshot' | 'region' | 'element'. Returns { bitmap, suggestions, dpr } or null if the user
 * cancelled (Esc, or closed the share picker).
 */
export async function capture(mode, { redaction }) {
  let picked = null;
  if (mode === 'element') {
    // Pick first so the outline isn't in the frame; the pick's click is the gesture for the picker.
    picked = await window.__snapElementSelect();
    if (!picked) return null;
  }
  let frame;
  try {
    frame = await grabFrame(redaction);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return null;
    throw err;
  }
  let { bitmap } = frame;
  const scale = bitmap.width / innerWidth;
  let clip = { x: 0, y: 0, w: innerWidth, h: innerHeight };

  if (mode === 'region') {
    // The overlay stretches the frame over the viewport, so its CSS px map proportionally.
    const r = await window.__snapRegionSelect(toDataUrl(bitmap));
    if (!r) { bitmap.close(); return null; }
    clip = { x: r.x * (innerWidth / r.vw), y: r.y * (innerHeight / r.vh), w: r.w * (innerWidth / r.vw), h: r.h * (innerHeight / r.vh) };
  } else if (picked) {
    if (!frame.matchesPage) { bitmap.close(); throw new Error('Share this tab (not another tab or window) to capture an element.'); }
    clip = { x: picked.x, y: picked.y, w: picked.w, h: picked.h };
  }
  if (clip.w < innerWidth || clip.h < innerHeight) {
    bitmap = await crop(bitmap, { x: clip.x * scale, y: clip.y * (bitmap.height / innerHeight), w: clip.w * scale, h: clip.h * (bitmap.height / innerHeight) });
  }
  const suggestions = frame.matchesPage ? suggestionsToImage(frame.scan, { scale, ox: clip.x, oy: clip.y, clip }) : [];
  return { bitmap, suggestions, dpr: scale };
}
