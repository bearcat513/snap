// File naming (§8): `{table}_{label}_{yyyyMMdd-HHmmss}.{ext}`; unsafe characters become `_`.

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDate(date, fmt) {
  const parts = {
    yyyy: pad(date.getFullYear(), 4),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => parts[t]);
}

export function sanitize(name) {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
}

export function buildFileName(pattern, vars, date, ext) {
  const base = pattern.replace(/\{([^}]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ? String(vars[key]) : '';
    if (/^[yMdHms\-_.: ]+$/.test(key)) return formatDate(date, key);
    return '';
  });
  return `${sanitize(base) || 'capture'}${ext ? `.${ext}` : ''}`;
}

/** Base file name (no extension) for a capture. */
export function captureBaseName(capture, settings) {
  const date = new Date(capture.createdAt);
  const sn = capture.servicenow;
  let host = '';
  try {
    host = new URL(capture.source?.url || '').host;
  } catch { /* not a URL (e.g. screen recording) */ }
  if (sn) {
    return buildFileName(settings.fileNamePattern, {
      table: sn.table, label: sn.label, host: sn.instance, title: capture.title,
    }, date, '');
  }
  return buildFileName(settings.fallbackFileNamePattern, {
    host: host || (capture.kind === 'recording' ? 'recording' : 'capture'),
    title: capture.title, table: '', label: '',
  }, date, '');
}

export function extensionForMime(mime) {
  if (!mime) return 'bin';
  if (mime.startsWith('video/mp4')) return 'mp4';
  if (mime.startsWith('video/webm')) return 'webm';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'application/pdf') return 'pdf';
  return 'bin';
}
