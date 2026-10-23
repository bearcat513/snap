// IndexedDB "snap" database (§10). Shared by every extension-origin page and the service worker.
// Stores: captures, blobs, chunks ([jobId, seq]), jobs.

const DB_NAME = 'snap';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('captures')) {
          db.createObjectStore('captures', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['jobId', 'seq'] });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function run(store, mode, op) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const req = op(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());

// ---- blobs ----

export async function putBlob(blob, { id = crypto.randomUUID(), ephemeral = false } = {}) {
  await put('blobs', { id, blob, size: blob.size, mimeType: blob.type, ephemeral, createdAt: Date.now() });
  return id;
}

export async function getBlob(id) {
  if (!id) return null;
  const rec = await get('blobs', id);
  return rec ? rec.blob : null;
}

export async function blobSize(id) {
  if (!id) return 0;
  const rec = await get('blobs', id);
  return rec ? rec.size : 0;
}

/** Export blobs are temporary hand-off copies (PDF/PNG for a save). Drop ones older than maxAgeMs. */
export async function purgeEphemeralBlobs(maxAgeMs = 24 * 3600 * 1000) {
  const db = await openDb();
  const cutoff = Date.now() - maxAgeMs;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const req = tx.objectStore('blobs').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (cur.value.ephemeral && cur.value.createdAt < cutoff) cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- recording chunks ----

export const appendChunk = (jobId, seq, blob) => put('chunks', { jobId, seq, blob });

export async function getChunks(jobId) {
  const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
  return run('chunks', 'readonly', (s) => s.getAll(range));
}

export async function deleteChunks(jobId) {
  const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
  return run('chunks', 'readwrite', (s) => s.delete(range));
}

export async function countChunks(jobId) {
  const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
  return run('chunks', 'readonly', (s) => s.count(range));
}

// ---- captures ----

export const getCapture = (id) => get('captures', id);
export const saveCapture = (capture) => put('captures', capture);

export async function updateCapture(id, mutate) {
  const capture = await getCapture(id);
  if (!capture) return null;
  mutate(capture);
  await saveCapture(capture);
  return capture;
}

export async function listCaptures(limit = Infinity) {
  const all = await getAll('captures');
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return all.slice(0, limit);
}

/** Every persistent blob a capture owns. */
export function captureBlobIds(capture) {
  return [capture.originalBlobId, capture.thumbnailBlobId, capture.posterBlobId, capture.rendered?.blobId].filter(Boolean);
}

export async function deleteCapture(id) {
  const capture = await getCapture(id);
  if (!capture) return;
  for (const blobId of captureBlobIds(capture)) {
    if (blobId) await del('blobs', blobId);
  }
  await del('captures', id);
}

export async function clearLibrary() {
  for (const c of await getAll('captures')) await deleteCapture(c.id);
  await purgeEphemeralBlobs(0);
}

/**
 * Retention (§10): keep the last N captures / X MB. Captures never saved anywhere are not
 * auto-deleted; if they alone push us over the limit, return warn=true so a badge is shown.
 */
export async function enforceRetention({ maxItems = 20, maxMB = 1024 } = {}) {
  const captures = await listCaptures(); // newest first
  const sizes = new Map();
  let total = 0;
  for (const c of captures) {
    let s = 0;
    for (const blobId of captureBlobIds(c)) s += await blobSize(blobId);
    sizes.set(c.id, s);
    total += s;
  }
  const maxBytes = maxMB * 1024 * 1024;
  let count = captures.length;
  let warn = false;
  for (const c of [...captures].reverse()) { // oldest first
    if (count <= maxItems && total <= maxBytes) break;
    if (c.saves && c.saves.some((s) => s.ok)) {
      await deleteCapture(c.id);
      count -= 1;
      total -= sizes.get(c.id);
    } else {
      warn = true;
    }
  }
  return { warn: warn && (count > maxItems || total > maxBytes), count, totalBytes: total };
}
