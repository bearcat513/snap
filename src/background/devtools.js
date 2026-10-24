// Console + network capture for bug reports (§6). Opt-in per tab from the popup: the extension
// attaches the DevTools protocol (optional "debugger" permission; Chrome shows its "started debugging"
// bar) and buffers console errors/warnings and failed requests from then on. Captures of that tab
// carry a copy. Request and response bodies and all headers are never read; URLs keep their
// origin and path, and query strings keep only parameter names.

import { updateCapture } from '../shared/db.js';
import { redactUrls } from '../shared/diagnostics.js';

const TABS_KEY = 'devtoolsTabs';
const bufKey = (tabId) => `devtools:${tabId}`;
const MAX = 100;
const requests = new Map(); // requestId → { method, type } (memory only; lost if the worker restarts)
let writes = Promise.resolve();

/** Query values can carry tokens: keep the parameter names only. */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return `${u.protocol}…`;
    const names = [...new Set([...u.searchParams.keys()])];
    return `${u.origin}${u.pathname}${names.length ? `?${names.map((k) => `${k}=…`).join('&')}` : ''}`;
  } catch {
    return '';
  }
}

const clip = (s, n = 500) => redactUrls(String(s ?? '')).slice(0, n);

async function activeTabs() {
  return (await chrome.storage.session.get(TABS_KEY))[TABS_KEY] || {};
}

export async function isRecordingDevtools(tabId) {
  return !!(await activeTabs())[tabId];
}

export async function startDevtools(tabId) {
  if (!(await chrome.permissions.contains({ permissions: ['debugger'] }))) throw new Error('Console & network capture needs the "debugger" permission.');
  if (await isRecordingDevtools(tabId)) return;
  listenForDebuggerEvents();
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) await chrome.debugger.sendCommand(target, domain).catch(() => {});
  const tabs = await activeTabs();
  tabs[tabId] = { startedAt: Date.now() };
  await chrome.storage.session.set({ [TABS_KEY]: tabs, [bufKey(tabId)]: { startedAt: Date.now(), console: [], network: [] } });
}

export async function stopDevtools(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
  await forget(tabId);
}

async function forget(tabId) {
  const tabs = await activeTabs();
  delete tabs[tabId];
  await chrome.storage.session.set({ [TABS_KEY]: tabs });
  await chrome.storage.session.remove(bufKey(tabId));
}

/** The buffered log for a tab, or null. */
export async function devtoolsSnapshot(tabId) {
  if (!(await isRecordingDevtools(tabId))) return null;
  return (await chrome.storage.session.get(bufKey(tabId)))[bufKey(tabId)] || null;
}

/** Copy the tab's buffered log onto a capture (no-op unless capture is on for that tab). */
export async function attachDevtools(captureId, tabId) {
  if (!captureId || !tabId) return;
  const snap = await devtoolsSnapshot(tabId);
  if (snap) await updateCapture(captureId, (c) => { c.devtools = { ...snap, capturedAt: Date.now() }; });
}

/**
 * Run fn with the DevTools protocol attached to the tab, reusing the console/network attachment if
 * there is one (Chrome allows one attachment per extension and tab).
 */
export async function withDebugger(tabId, fn) {
  const target = { tabId };
  const shared = await isRecordingDevtools(tabId);
  if (!shared) await chrome.debugger.attach(target, '1.3');
  try {
    return await fn(target);
  } finally {
    if (!shared) await chrome.debugger.detach(target).catch(() => {});
  }
}

function record(tabId, kind, entry) {
  writes = writes.then(async () => {
    const key = bufKey(tabId);
    const buf = (await chrome.storage.session.get(key))[key];
    if (!buf) return;
    buf[kind].push(entry);
    if (buf[kind].length > MAX) buf[kind] = buf[kind].slice(-MAX);
    await chrome.storage.session.set({ [key]: buf });
  }).catch(() => {});
}

const argText = (a) => (a.type === 'string' ? a.value : a.description ?? (a.value !== undefined ? JSON.stringify(a.value) : a.type));

/** Turn one protocol event into a buffer entry; exported for tests. Returns [kind, entry] or null. */
export function entryFor(method, p, now = Date.now()) {
  if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type)) {
    const frame = p.stackTrace?.callFrames?.[0];
    return ['console', { at: now, level: p.type === 'warning' ? 'warning' : 'error', text: clip((p.args || []).map(argText).join(' ')), source: frame?.url ? `${safeUrl(frame.url)}:${frame.lineNumber + 1}` : '' }];
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    return ['console', { at: now, level: 'error', text: clip(d.exception?.description || d.text), source: d.url ? `${safeUrl(d.url)}:${(d.lineNumber || 0) + 1}` : '' }];
  }
  if (method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry?.level) && p.entry.source !== 'network') {
    return ['console', { at: now, level: p.entry.level, text: clip(p.entry.text), source: safeUrl(p.entry.url || '') }];
  }
  return null;
}

async function onEvent(source, method, p) {
  const tabId = source.tabId;
  if (!tabId || !(await isRecordingDevtools(tabId))) return;
  if (method === 'Network.requestWillBeSent') {
    requests.set(p.requestId, { method: p.request?.method, type: p.type, url: safeUrl(p.request?.url || '') });
    if (requests.size > 2000) requests.delete(requests.keys().next().value);
    return;
  }
  if (method === 'Network.responseReceived' && p.response?.status >= 400) {
    const req = requests.get(p.requestId) || {};
    record(tabId, 'network', { at: Date.now(), method: req.method || '', url: safeUrl(p.response.url), status: p.response.status, statusText: clip(p.response.statusText, 80), type: p.type || req.type || '' });
    return;
  }
  if (method === 'Network.loadingFailed' && !p.canceled) {
    const req = requests.get(p.requestId) || {};
    record(tabId, 'network', { at: Date.now(), method: req.method || '', url: req.url || '', status: 0, statusText: clip(p.errorText, 120), type: p.type || req.type || '' });
    return;
  }
  const entry = entryFor(method, p);
  if (entry) record(tabId, ...entry);
}

// chrome.debugger only exists once the optional permission is granted.
let listening = false;
export function listenForDebuggerEvents() {
  if (listening || !globalThis.chrome?.debugger) return;
  listening = true;
  chrome.debugger.onEvent.addListener(onEvent);
  // "Cancel" on Chrome's debugging bar, or the tab closed.
  chrome.debugger.onDetach.addListener((source) => { if (source.tabId) forget(source.tabId); });
}
listenForDebuggerEvents();
