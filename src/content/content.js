// ServiceNow content script (§5.1, §11): announces the extension, validates and relays bridge
// messages, injects the bridge iframe, and shows the "press the shortcut" prompt.
(() => {
  'use strict';
  if (window.__snapCompanionContent) return;
  window.__snapCompanionContent = true;

  const P = globalThis.SnapProtocol;
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const iframes = new Map(); // requestId → iframe

  document.documentElement.dataset.snapCompanion = '1.0';

  const toPage = (type, requestId, payload) => window.postMessage(P.envelope(type, requestId, payload), location.origin);

  async function toWorker(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'Snap Companion was updated. Reload this page.' : err.message };
    }
  }

  window.addEventListener('message', async (event) => {
    // Files coming back from our bridge iframe: re-post them to the page on its own origin so the
    // /snap script only ever has to trust location.origin.
    if (event.origin === EXT_ORIGIN) {
      const m = event.data;
      if (!P.isEnvelope(m) || !['snap:file', 'snap:error'].includes(m.type)) return;
      const frame = iframes.get(m.requestId);
      if (!frame || frame.contentWindow !== event.source) return;
      toPage(m.type, m.requestId, m.payload);
      setTimeout(() => { frame.remove(); iframes.delete(m.requestId); }, 1000);
      return;
    }

    const res = P.validatePageMessage(event, window, location);
    if (!res) return;
    if (!res.ok) {
      toPage('snap:rejected', res.requestId, { message: res.error });
      return;
    }
    const m = res.msg;
    if (m.type === 'snap:request') {
      const reply = await toWorker({ type: 'bridge.request', requestId: m.requestId, payload: m.payload });
      if (reply && reply.ok) toPage('snap:accepted', m.requestId, { jobId: reply.jobId });
      else toPage('snap:rejected', m.requestId, { message: (reply && reply.error) || 'Snap Companion did not respond' });
    } else if (m.type === 'snap:uploaded') {
      await toWorker({ type: 'bridge.result', requestId: m.requestId, payload: m.payload });
    } else if (m.type === 'snap:cancelled') {
      await toWorker({ type: 'bridge.cancel', requestId: m.requestId });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('bridge:')) return;
    sendResponse({ ok: true });
    switch (msg.type) {
      case 'bridge:deliver':
        if (msg.useIframe) deliverViaIframe(msg);
        else deliverViaMessaging(msg);
        break;
      case 'bridge:prompt':
        showPrompt(msg);
        break;
      case 'bridge:prompt-clear':
        hidePrompt();
        break;
      case 'bridge:cancelled':
        hidePrompt();
        toPage('snap:cancelled', msg.requestId);
        break;
      case 'bridge:error':
        hidePrompt();
        toPage('snap:error', msg.requestId, { message: msg.message });
        break;
    }
  });

  function deliverViaIframe({ requestId, jobId, token }) {
    const frame = document.createElement('iframe');
    frame.src = `${chrome.runtime.getURL('src/bridge/bridge.html')}?job=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none;left:-10px;top:-10px;';
    iframes.set(requestId, frame);
    document.documentElement.appendChild(frame);
    setTimeout(() => { if (iframes.get(requestId) === frame) { frame.remove(); iframes.delete(requestId); } }, 5 * 60_000);
  }

  // Custom-domain instances: bridge.html isn't web-accessible there, so pull the files over
  // extension messaging (base64 chunks) and rebuild the Blobs here.
  async function deliverViaMessaging({ requestId, jobId, token }) {
    try {
      const claim = await toWorker({ type: 'bridge.claim', jobId, token });
      if (!claim || !claim.ok) throw new Error((claim && claim.error) || 'Delivery refused');
      const files = [];
      for (let i = 0; i < claim.files.length; i++) {
        const f = claim.files[i];
        const parts = [];
        let offset = 0;
        for (;;) {
          const r = await toWorker({ type: 'bridge.fetchFile', jobId, token, index: i, offset });
          if (!r || !r.ok) throw new Error((r && r.error) || 'Transfer failed');
          const bin = atob(r.data);
          const bytes = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          parts.push(bytes);
          offset += bytes.length;
          if (r.done || !bytes.length) break;
        }
        files.push({ name: f.name, mimeType: f.mimeType, blob: new Blob(parts, { type: f.mimeType }) });
      }
      toPage('snap:file', requestId, { files });
    } catch (err) {
      toPage('snap:error', requestId, { message: err.message });
    }
  }

  // ---- in-page prompt for requests that need a real user gesture (§11.6) ----
  let promptHost = null;
  function showPrompt({ requestId, action, shortcut }) {
    hidePrompt();
    promptHost = document.createElement('div');
    promptHost.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = promptHost.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box{font:13px/1.4 system-ui,sans-serif;background:#1b1f24;color:#fff;padding:12px 14px;border-radius:8px;
             box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:320px;display:flex;gap:12px;align-items:flex-start}
        kbd{font:12px ui-monospace,monospace;background:#333a44;border-radius:4px;padding:1px 5px}
        button{font:inherit;background:transparent;color:#9fc0ff;border:0;cursor:pointer;padding:0}
      </style>
      <div class="box" role="status"><div>
        <strong>Snap Companion</strong><br>
        Press <kbd></kbd> or click the Snap icon to <span class="act"></span>.
      </div><button type="button">Cancel</button></div>`;
    root.querySelector('kbd').textContent = shortcut || 'the shortcut';
    root.querySelector('.act').textContent = action;
    root.querySelector('button').addEventListener('click', async () => {
      hidePrompt();
      await toWorker({ type: 'bridge.cancel', requestId });
    });
    document.documentElement.appendChild(promptHost);
  }
  function hidePrompt() {
    if (promptHost) promptHost.remove();
    promptHost = null;
  }
})();
