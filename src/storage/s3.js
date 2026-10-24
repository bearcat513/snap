// Amazon S3 adapter via a presigned-URL service (§9.2). No AWS credentials live in the extension.
//
// POST <presignEndpoint>  { fileName, contentType, size, context }
//  → { key, objectUrl, upload: { type: 'single', url, headers? } }
//  → { key, objectUrl, upload: { type: 'multipart', uploadId, partSize, partUrls[], completeUrl } }
// Multipart completion: POST completeUrl { key, uploadId, parts: [{ PartNumber, ETag }] }

import { getBlob, get, put, del } from '../shared/db.js';
import { destinationAllowed } from '../shared/settings.js';
import { sleep } from '../shared/util.js';
import { planParts, validatePresign, backoffMs } from './s3-plan.js';

const RESUME_TTL = 6 * 3600 * 1000;
const ATTEMPTS = 3;

export function endpointOrigin(settings) {
  try {
    const u = new URL(settings['s3.presignEndpoint']);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

async function getToken(settings) {
  if (settings['s3.auth'] !== 'oidc') return null;
  const cached = (await chrome.storage.session.get('s3Token')).s3Token;
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!chrome.identity) throw new Error('Grant the "identity" permission in Options → S3 to sign in.');
  const template = settings['s3.oidcAuthUrl'];
  if (!template) throw new Error('S3 sign-in URL is not configured.');
  const url = template
    .replace('{redirect_uri}', encodeURIComponent(chrome.identity.getRedirectURL('s3')))
    .replace('{nonce}', crypto.randomUUID());
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1) || new URL(responseUrl).search.slice(1));
  const token = params.get('access_token') || params.get('id_token');
  if (!token) throw new Error('Sign-in did not return a token.');
  const exp = Date.now() + (Number(params.get('expires_in')) || 3600) * 1000;
  await chrome.storage.session.set({ s3Token: { token, exp } });
  return token;
}

function putWithProgress(url, body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader('ETag') });
      else reject(Object.assign(new Error(`S3 responded HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error uploading to S3 (check bucket CORS for this extension origin).'));
    xhr.send(body);
  });
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) break;
      if (attempt < ATTEMPTS - 1) await sleep(backoffMs(attempt));
    }
  }
  throw lastErr;
}

const resumeId = (file) => `upload:${file.blobId}:${file.name}`;

export const s3Adapter = {
  id: 's3',
  label: 'Amazon S3',
  permissionOrigin: (s) => endpointOrigin(s),

  async isAvailable(ctx) {
    const s = ctx.settings;
    if (!destinationAllowed('s3', s)) return { available: false, reason: 'Disabled by your organization.' };
    if (!s['s3.presignEndpoint']) return { available: false, reason: 'Not configured (Options → S3).' };
    if (!endpointOrigin(s)) return { available: false, reason: 'Presign endpoint must be an https:// URL.' };
    return { available: true };
  },

  async save(file, ctx, onProgress) {
    const s = ctx.settings;
    const fail = (error) => ({ adapter: 's3', ok: false, name: file.name, error });
    try {
      const blob = await getBlob(file.blobId);
      if (!blob) return fail('File data missing');
      const token = await getToken(s);
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

      let resume = await get('jobs', resumeId(file));
      if (resume && Date.now() - resume.createdAt > RESUME_TTL) resume = null;
      let presign = resume?.presign;
      if (!presign) {
        const res = await fetch(s['s3.presignEndpoint'], {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders },
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.mimeType,
            size: blob.size,
            context: { ...(ctx.snContext || {}), keyPrefix: s['s3.keyPrefix'] || undefined },
          }),
        });
        if (res.status === 401 || res.status === 403) return fail(`Presign service refused the request (HTTP ${res.status}). Sign in again.`);
        if (!res.ok) return fail(`Presign service error (HTTP ${res.status})`);
        presign = await res.json();
        validatePresign(presign, blob.size);
        resume = { id: resumeId(file), kind: 'upload', presign, etags: {}, createdAt: Date.now() };
        if (presign.upload.type === 'multipart') await put('jobs', resume);
      }

      const u = presign.upload;
      if (u.type === 'single') {
        await withRetry(() => putWithProgress(u.url, blob, { 'Content-Type': file.mimeType, ...(u.headers || {}) },
          (loaded) => onProgress?.(loaded / blob.size)));
      } else {
        const parts = planParts(blob.size, u.partSize);
        let doneBytes = parts.filter((p) => resume.etags[p.partNumber]).reduce((n, p) => n + (p.end - p.start), 0);
        for (const part of parts) {
          if (resume.etags[part.partNumber]) continue;
          const body = blob.slice(part.start, part.end);
          const { etag } = await withRetry(() => putWithProgress(u.partUrls[part.partNumber - 1], body, {},
            (loaded) => onProgress?.((doneBytes + loaded) / blob.size)));
          if (!etag) throw new Error('S3 did not expose the ETag header. Add "ETag" to ExposeHeaders in the bucket CORS rules.');
          resume.etags[part.partNumber] = etag;
          doneBytes += part.end - part.start;
          await put('jobs', resume); // resumable progress
        }
        await withRetry(async () => {
          const r = await fetch(u.completeUrl, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({
              key: presign.key,
              uploadId: u.uploadId,
              parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: resume.etags[p.partNumber] })),
            }),
          });
          if (!r.ok) throw Object.assign(new Error(`Completing the upload failed (HTTP ${r.status})`), { status: r.status });
          return r;
        });
        await del('jobs', resume.id);
      }
      onProgress?.(1);
      return { adapter: 's3', ok: true, name: file.name, location: presign.objectUrl || presign.key, key: presign.key };
    } catch (err) {
      return fail(err.message);
    }
  },
};
