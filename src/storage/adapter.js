// StorageAdapter registry (§9). Adapters run in the editor page.
//
// interface StorageAdapter {
//   id; label;
//   isAvailable(ctx): Promise<{ available: boolean, reason?: string }>
//   save(file: ExportFile, ctx, onProgress?): Promise<SaveResult>
//   saveAll?(files: ExportFile[], ctx, onProgress?): Promise<SaveResult[]>   // single hand-off destinations
// }
// ExportFile { name, mimeType, blobId, size }
// SaveResult { adapter, ok, name, location?, error?, issue?, link?, linkLabel? }
//   link: a URL later destinations should cite (S3 object, tracker issue)

import { downloadAdapter } from './download.js';
import { s3Adapter } from './s3.js';
import { servicenowAdapter } from './servicenow.js';
import { webhookAdapter, jiraAdapter, githubAdapter } from './trackers.js';

// S3 runs first so its links can go into everything after it (hybrid mode, §9); issue trackers run
// before ServiceNow so the record's PDF and work note can link the issue.
export const SAVE_ORDER = ['s3', 'webhook', 'jira', 'github', 'servicenow', 'download'];

const registry = new Map([downloadAdapter, s3Adapter, servicenowAdapter, webhookAdapter, jiraAdapter, githubAdapter].map((a) => [a.id, a]));

/**
 * Host-permission patterns the plan's destinations need. Request them with
 * chrome.permissions.request straight from the Save click (no await before it).
 */
export function planOrigins(plan, settings) {
  const origins = plan.map((p) => registry.get(p.id)?.permissionOrigin?.(settings)).filter(Boolean);
  return [...new Set(origins)];
}

export function getAdapter(id) {
  return registry.get(id);
}

export function registerAdapter(adapter) {
  registry.set(adapter.id, adapter);
}

export function allAdapters() {
  return [...registry.values()];
}

/**
 * Ask for the plan's host access. Call straight from the click (no await before it); outside a
 * user gesture the request throws, and then already-granted access is still accepted.
 */
export function requestPlanOrigins(plan, settings) {
  const origins = planOrigins(plan, settings);
  if (!origins.length) return Promise.resolve({ ok: true, origins });
  return chrome.permissions.request({ origins })
    .catch(() => chrome.permissions.contains({ origins }))
    .then((ok) => ({ ok, origins }));
}
