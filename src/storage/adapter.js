// StorageAdapter registry (§9). Adapters run in the editor page.
//
// interface StorageAdapter {
//   id; label;
//   isAvailable(ctx): Promise<{ available: boolean, reason?: string }>
//   save(file: ExportFile, ctx, onProgress?): Promise<SaveResult>
//   saveAll?(files: ExportFile[], ctx, onProgress?): Promise<SaveResult[]>   // single hand-off destinations
// }
// ExportFile { name, mimeType, blobId, size }
// SaveResult { adapter, ok, name, location?, error? }

import { downloadAdapter } from './download.js';
import { s3Adapter } from './s3.js';
import { servicenowAdapter } from './servicenow.js';

// S3 runs before ServiceNow so the S3 link can go into the record's PDF (hybrid mode, §9).
export const SAVE_ORDER = ['s3', 'servicenow', 'download'];

const registry = new Map([downloadAdapter, s3Adapter, servicenowAdapter].map((a) => [a.id, a]));

export function getAdapter(id) {
  return registry.get(id);
}

export function registerAdapter(adapter) {
  registry.set(adapter.id, adapter);
}

export function allAdapters() {
  return [...registry.values()];
}
