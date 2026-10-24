// Diagnostics (§16): a small ring buffer of recent errors in chrome.storage.local, so support can ask
// for Settings → About → Copy diagnostics instead of the service-worker console.

import { SECRET_KEYS } from './settings.js';

const KEY = 'diagnostics.errors';
const MAX = 100;
let queue = Promise.resolve();

const text = (v, max = 1000) => String(v ?? '').slice(0, max);

/** Strip query strings and fragments (they can carry tokens) from anything that looks like a URL. */
export function redactUrls(str) {
  return String(str).replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, '$1?…');
}

export function errorEntry(source, err, extra) {
  return {
    at: new Date().toISOString(),
    source: text(source, 60),
    message: redactUrls(text(err?.message ?? err)),
    stack: err?.stack ? redactUrls(text(err.stack, 2000)) : undefined,
    extra: extra ? JSON.parse(redactUrls(JSON.stringify(extra)).slice(0, 2000) || 'null') : undefined,
  };
}

/** Record an error. Never throws; diagnostics must not break the code that is failing. */
export function logError(source, err, extra) {
  const entry = errorEntry(source, err, extra);
  queue = queue.then(async () => {
    const list = (await chrome.storage.local.get(KEY))[KEY] || [];
    list.push(entry);
    await chrome.storage.local.set({ [KEY]: list.slice(-MAX) });
  }).catch(() => {});
  return queue;
}

export async function recentErrors() {
  return (await chrome.storage.local.get(KEY))[KEY] || [];
}

export async function clearDiagnostics() {
  await chrome.storage.local.remove(KEY);
}

/** Settings with credentials removed and URLs reduced to origin + path. */
export function sanitizeSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEYS.includes(k)) out[k] = v ? '(set)' : '';
    else if (k === 'templates' || k === 'customFields') out[k] = `${(v || []).length} item(s)`;
    else if (typeof v === 'string') out[k] = redactUrls(v);
    else out[k] = v;
  }
  return out;
}

/** Log uncaught errors from an extension page or the worker. */
export function installErrorLogging(source) {
  const g = globalThis;
  g.addEventListener?.('error', (e) => logError(source, e.error || e.message));
  g.addEventListener?.('unhandledrejection', (e) => logError(source, e.reason));
}
