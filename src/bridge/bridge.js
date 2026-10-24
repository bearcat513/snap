// Bridge iframe (§5.1, §11): runs in the extension origin inside the ServiceNow page, reads the
// finished files and postMessages them (as Blobs, by structured clone) to the exact SN origin.

import '../shared/protocol.js';
import { getBlob } from '../shared/db.js';
import { base64ToBytes } from '../shared/util.js';

const P = globalThis.SnapProtocol;
const params = new URLSearchParams(location.search);
const jobId = params.get('job');
const token = params.get('token');

async function readFile(index, file) {
  // Direct IndexedDB read works when the frame's storage isn't partitioned; otherwise ask the worker.
  try {
    const blob = await getBlob(file.blobId);
    if (blob) return blob;
  } catch { /* fall through */ }
  const parts = [];
  let offset = 0;
  for (;;) {
    const r = await chrome.runtime.sendMessage({ type: 'bridge.fetchFile', jobId, token, index, offset });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Transfer failed');
    const bytes = base64ToBytes(r.data);
    parts.push(bytes);
    offset += bytes.length;
    if (r.done || !bytes.length) break;
  }
  return new Blob(parts, { type: file.mimeType });
}

async function main() {
  const claim = await chrome.runtime.sendMessage({ type: 'bridge.claim', jobId, token });
  if (!claim || !claim.ok) return; // not ours, already used, or forged — say nothing

  const parentOrigin = location.ancestorOrigins && location.ancestorOrigins[0];
  if (parentOrigin !== claim.origin) {
    await chrome.runtime.sendMessage({ type: 'bridge.deliveryFailed', jobId, token, error: 'Bridge embedded in an unexpected page' });
    return;
  }
  try {
    const files = [];
    for (let i = 0; i < claim.files.length; i++) {
      const f = claim.files[i];
      files.push({ name: f.name, mimeType: f.mimeType, blob: await readFile(i, f) });
    }
    window.parent.postMessage(P.envelope('snap:file', claim.requestId, { files, note: claim.note || '' }), claim.origin);
  } catch (err) {
    await chrome.runtime.sendMessage({ type: 'bridge.deliveryFailed', jobId, token, error: err.message });
    window.parent.postMessage(P.envelope('snap:error', claim.requestId, { message: err.message }), claim.origin);
  }
}

main();
