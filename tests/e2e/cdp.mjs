// Minimal CDP-over-pipe client (no dependencies). Loads the unpacked extension via
// Extensions.loadUnpacked, which works in branded Chrome where --load-extension is ignored.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function launch({ extraArgs = [], scratch, downloadDir }) {
  const profile = mkdtempSync(join(scratch, 'profile-'));
  if (downloadDir) {
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } }));
  }
  const bin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(bin, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--auto-accept-this-tab-capture', '--window-size=1280,800', ...extraArgs,
    // CHROME_ARGS="--no-sandbox" etc. for CI containers.
    ...(process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const out = chrome.stdio[3];
  const inp = chrome.stdio[4];
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  let buf = '';
  inp.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : resolve(msg.result);
      } else listeners.forEach((l) => l(msg));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    out.write(JSON.stringify({ id: msgId, method, params, sessionId }) + '\0');
  });
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const close = () => { try { chrome.kill(); } catch {} };
  return { send, on, close, chrome };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}
