// Save history helpers (§10 capture.saves): which saves are still failing, and how to redo them.

/** Export format that produced a file name (inverse of ExportFactory naming). */
export function formatForFile(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['video', 'frames', 'sidecar'].includes(ext)) return ext; // a step that failed before a file was named
  if (ext === 'png') return 'png';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'gif') return 'gif';
  if (ext === 'zip') return 'frames';
  if (ext === 'mp4' || ext === 'webm') return 'video';
  if (ext === 'md' || ext === 'json' || ext === 'vtt') return 'sidecar';
  if (ext === 'issue') return 'issue'; // the tracker issue itself
  return null;
}

/**
 * Saves whose most recent attempt failed and that a later attempt didn't fix, keyed by
 * destination + file format (file names carry a timestamp-free base, so they match across retries).
 * Returns [{ adapter, format, name, error, at }].
 */
export function pendingFailures(capture) {
  const latest = new Map();
  const saves = [...(capture?.saves || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const s of saves) {
    const format = formatForFile(s.name);
    if (!s.adapter || s.adapter === 'editor' || !format) continue;
    latest.set(`${s.adapter}|${format}`, { adapter: s.adapter, format, name: s.name, ok: s.ok, error: s.error, at: s.at });
  }
  return [...latest.values()].filter((s) => !s.ok).map(({ ok, ...rest }) => rest);
}

/** pendingFailures grouped into a save plan: [{ id, formats }] in the given destination order. */
export function retryPlan(capture, order) {
  const byAdapter = new Map();
  for (const f of pendingFailures(capture)) {
    if (!byAdapter.has(f.adapter)) byAdapter.set(f.adapter, new Set());
    byAdapter.get(f.adapter).add(f.format);
  }
  return order.filter((id) => byAdapter.has(id)).map((id) => ({ id, formats: [...byAdapter.get(id)] }));
}

/** The URL to share for a capture: the newest issue link, otherwise the newest uploaded file. */
export function shareLink(capture) {
  const links = (capture?.saves || []).filter((s) => s.ok && /^https?:\/\//.test(s.location || ''));
  return (links.filter((s) => s.issue).pop() || links.pop())?.location || null;
}

/** Keep only the fields a SaveResult stores on the capture. */
export function toSaveRecord({ adapter, ok, name, location, error, at, downloadId, issue }) {
  return { adapter, ok, name, location, error, at: at || new Date().toISOString(), downloadId, issue };
}
