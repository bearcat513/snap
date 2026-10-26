// Screenshot capture (§6.1–6.3): visible area, region, full page.

import { createScreenshotCapture, createSessionCapture } from '../shared/captures.js';
import { cropBlob, stitchTiles, suggestionsToImage } from '../shared/image.js';
import { updateCapture } from '../shared/db.js';
import { withDebugger } from './devtools.js';
import { getSettings } from '../shared/settings.js';
import { sleep, base64ToBytes } from '../shared/util.js';

// Chrome allows ~2 captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL = 550;
const MAX_TILES = 40;
const MAX_PX = 16384;
let lastCaptureAt = 0;

export { suggestionsToImage };

export async function captureVisibleDataUrl(windowId) {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

const dataUrlToBlob = async (url) => (await fetch(url)).blob();

function sourceFromTab(tab, extra = {}) {
  return { url: tab.url || '', title: tab.title || '', tabId: tab.id, dpr: 1, width: tab.width, height: tab.height, ...extra };
}

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// ---------- suggested redactions (§6 smart redaction) ----------

/** Scan the page for sensitive text. Returns the content script's result, or null (off / no access). */
async function findSensitive(tab, scope = 'viewport') {
  const settings = await getSettings();
  if (!settings['redaction.suggest']) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/shared/sensitive.js', 'src/content/sensitive-scan.js'] });
    return await exec(tab.id, (o) => window.__snapFindSensitive(o), [{ patterns: settings['redaction.patterns'], custom: settings['redaction.custom'], scope }]);
  } catch {
    return null; // e.g. no host access to this page; suggestions are optional
  }
}

export async function snapVisible(tab, extra = {}) {
  const scan = await findSensitive(tab);
  const blob = await dataUrlToBlob(await captureVisibleDataUrl(tab.windowId));
  const bmp = await createImageBitmap(blob);
  const dpr = tab.width ? bmp.width / tab.width : 1;
  const suggestions = scan ? suggestionsToImage(scan, { scale: bmp.width / scan.vw, clip: { w: scan.vw, h: scan.vh } }) : [];
  bmp.close();
  return createScreenshotCapture({ blob, source: sourceFromTab(tab, { dpr }), suggestions, ...extra });
}

/** Returns the capture, or null if the user pressed Esc. */
export async function snapRegion(tab, extra = {}) {
  // Capture first so the selection overlay isn't in the image (§6.2).
  const dataUrl = await captureVisibleDataUrl(tab.windowId);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/region-select.js'] });
  const scan = await findSensitive(tab);
  const sel = await exec(tab.id, (url) => window.__snapRegionSelect(url), [dataUrl]);
  if (!sel) return null;
  return cropToSelection(tab, dataUrl, sel, scan, extra);
}

/** Click an element to capture just its bounds. Returns the capture, or null on Esc. */
export async function snapElement(tab, extra = {}) {
  const settings = await getSettings();
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/element-select.js'] });
  const sel = await exec(tab.id, (pad) => window.__snapElementSelect(pad), [Math.max(0, Number(settings['capture.elementPadding']) || 0)]);
  if (!sel) return null;
  // The picker is gone now; scan and capture the page as it looks.
  const scan = await findSensitive(tab);
  const dataUrl = await captureVisibleDataUrl(tab.windowId);
  return cropToSelection(tab, dataUrl, sel, scan, extra);
}

async function cropToSelection(tab, dataUrl, sel, scan, extra) {
  const blob = await dataUrlToBlob(dataUrl);
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / sel.vw;
  bmp.close();
  const cropped = await cropBlob(blob, { x: sel.x * scale, y: sel.y * scale, w: sel.w * scale, h: sel.h * scale });
  return createScreenshotCapture({
    blob: cropped,
    source: sourceFromTab(tab, { dpr: scale, width: Math.round(sel.w), height: Math.round(sel.h) }),
    suggestions: suggestionsToImage(scan, { scale, ox: sel.x, oy: sel.y, clip: { w: sel.w, h: sel.h } }),
    ...extra,
  });
}

export async function snapFullPage(tab, extra = {}) {
  const settings = await getSettings();
  if (settings.fullPageStrategy === 'debugger' && (await chrome.permissions.contains({ permissions: ['debugger'] }))) {
    return createScreenshotCapture({ ...(await fullPageViaDebugger(tab)), ...extra });
  }
  return createScreenshotCapture({ ...(await fullPageViaScroll(tab)), ...extra });
}

async function fullPageViaScroll(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/fullpage.js'] });
  const info = await exec(tab.id, () => window.__snapFullPage.prepare());
  if (!info) throw new Error('Could not find a scrollable area on this page.');
  const scan = await findSensitive(tab, 'all');

  const tiles = [];
  try {
    let y = 0;
    let prev = -1;
    let dpr = 1;
    for (let i = 0; i < MAX_TILES; i++) {
      const top = await exec(tab.id, (yy, hide) => window.__snapFullPage.scrollTo(yy, hide), [y, i > 0]);
      if (top === prev) break;
      const blob = await dataUrlToBlob(await captureVisibleDataUrl(tab.windowId));
      if (i === 0) {
        const bmp = await createImageBitmap(blob);
        dpr = bmp.width / info.vw;
        bmp.close();
      }
      tiles.push({ blob, top });
      prev = top;
      if (top + info.rect.h >= info.scrollHeight - 1) break;
      y = top + info.rect.h;
      if (y * dpr >= MAX_PX) break;
    }
    const last = tiles[tiles.length - 1];
    const totalHeight = Math.min(info.scrollHeight, last.top + info.rect.h);
    const blob = await stitchTiles(tiles, { rect: info.rect, totalHeight, dpr, maxPx: MAX_PX });
    return {
      blob,
      source: sourceFromTab(tab, { dpr, width: Math.round(info.rect.w), height: Math.round(totalHeight), fullPage: true }),
      // Stitched image y = client y − scroller top + the scroll offset at scan time.
      suggestions: suggestionsToImage(scan, { scale: dpr, ox: info.rect.x, oy: info.rect.y - info.top, clip: { w: info.rect.w, h: Math.min(totalHeight, MAX_PX / dpr) } }),
    };
  } finally {
    await exec(tab.id, () => window.__snapFullPage.restore()).catch(() => {});
  }
}

async function fullPageViaDebugger(tab) {
  const scan = await findSensitive(tab, 'all');
  return withDebugger(tab.id, async (target) => {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
    const height = Math.min(size.height, MAX_PX);
    const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height, scale: 1 },
    });
    const blob = new Blob([base64ToBytes(data)], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const dpr = bmp.width / size.width;
    bmp.close();
    return {
      blob,
      source: sourceFromTab(tab, { dpr, width: Math.round(vp?.clientWidth || size.width), height: Math.round(height), fullPage: true }),
      // Document coordinates = client + scroll offset.
      suggestions: scan ? suggestionsToImage(scan, { scale: dpr, ox: -scan.scrollX, oy: -scan.scrollY, clip: { w: size.width, h: height } }) : [],
    };
  });
}

/**
 * Multi-viewport capture (§6): the page at each width in Settings → Screenshots, emulated through the
 * DevTools protocol, grouped as a session. Returns the session capture.
 */
export async function snapViewports(tab) {
  if (!(await chrome.permissions.contains({ permissions: ['debugger'] }))) throw new Error('Viewport capture needs the "debugger" permission (Settings → Screenshots).');
  const settings = await getSettings();
  const members = [];
  await withDebugger(tab.id, async (target) => {
    try {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
      const height = Math.round((metrics.cssLayoutViewport || metrics.layoutViewport).clientHeight);
      for (const width of settings['capture.viewports']) {
        await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: width < 768 });
        await sleep(700); // layout, media queries, lazy images
        const scan = await findSensitive(tab);
        const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' });
        const blob = new Blob([base64ToBytes(data)], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const dpr = bmp.width / width;
        const suggestions = scan ? suggestionsToImage(scan, { scale: bmp.width / scan.vw, clip: { w: scan.vw, h: scan.vh } }) : [];
        bmp.close();
        const capture = await createScreenshotCapture({
          blob, suggestions, title: `${(tab.title || 'Page').slice(0, 100)} — ${width}px`,
          source: sourceFromTab(tab, { dpr, width, height, viewport: width }),
        });
        members.push(capture.id);
      }
    } finally {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  });
  const session = await createSessionCapture({ members, title: `${(tab.title || 'Page').slice(0, 100)} — ${members.length} viewports` });
  for (const id of members) await updateCapture(id, (c) => { c.sessionId = session.id; });
  return session;
}

/** Run the 3-2-1 countdown overlay in the page (tab recording, §6.6). Resolves when it's gone. */
export async function runCountdown(tabId, seconds = 3) {
  await exec(tabId, (n) => new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>div{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.35);' +
      'font:700 120px/1 system-ui,sans-serif;color:#fff;text-shadow:0 4px 24px rgba(0,0,0,.5)}</style><div></div>';
    const el = root.querySelector('div');
    document.documentElement.appendChild(host);
    let left = n;
    const tick = () => {
      if (left === 0) {
        host.remove();
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120)));
        return;
      }
      el.textContent = String(left--);
      setTimeout(tick, 1000);
    };
    tick();
  }), [seconds]);
}
