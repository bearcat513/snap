// Pure helpers for S3 uploads (unit-tested).

export const MIN_PART = 5 * 1024 * 1024;

/** Byte ranges for a multipart upload. Every part but the last must be ≥ 5 MiB. */
export function planParts(size, partSize) {
  if (!(partSize >= MIN_PART)) throw new Error(`partSize must be at least ${MIN_PART} bytes`);
  const parts = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(size, start + partSize) });
  }
  if (!parts.length) parts.push({ partNumber: 1, start: 0, end: 0 });
  return parts;
}

/** Validate the presign service response (§9.2 contract). */
export function validatePresign(res, size) {
  if (!res || typeof res !== 'object' || !res.upload) throw new Error('Presign response missing "upload"');
  const u = res.upload;
  if (u.type === 'single') {
    if (typeof u.url !== 'string') throw new Error('Presign single upload missing "url"');
    return;
  }
  if (u.type !== 'multipart') throw new Error(`Unknown upload type "${u.type}"`);
  if (!Array.isArray(u.partUrls) || !u.partUrls.length) throw new Error('Presign multipart missing "partUrls"');
  if (typeof u.completeUrl !== 'string') throw new Error('Presign multipart missing "completeUrl"');
  const parts = planParts(size, u.partSize);
  if (parts.length !== u.partUrls.length) {
    throw new Error(`Presign returned ${u.partUrls.length} part URLs for ${parts.length} parts`);
  }
}

export const backoffMs = (attempt) => 1000 * 2 ** attempt;
