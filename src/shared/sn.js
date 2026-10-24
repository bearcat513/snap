// ServiceNow attachment result helpers (§9.3, §16).

export function snErrorMessage(error) {
  if (!error) return 'Upload failed';
  const m = /HTTP (\d{3})/.exec(error);
  const status = m ? Number(m[1]) : 0;
  if (status === 401 || status === 403) return 'Session expired or no attach permission on this record.';
  if (status === 413) return 'File too large for this instance (com.glide.attachment.max_size). Try the PDF instead of the video, or hybrid S3 mode.';
  if (status === 400 || status === 415) {
    return 'The instance rejected this file type (glide.attachment.extensions). MP4 or the PDF report is usually allowed; .webm often is not.';
  }
  return error;
}

export function attachmentUrl(origin, sysId) {
  return sysId ? `${origin}/sys_attachment.do?sys_id=${sysId}` : undefined;
}

const mb = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/** Why this instance would reject `file` ({ name, size }), from the limits /snap read; '' if fine. */
export function attachmentProblem(file, limits) {
  if (!limits) return '';
  const ext = String(file.name).toLowerCase().split('.').pop();
  if (limits.allowedExtensions?.length && !limits.allowedExtensions.includes(ext)) {
    return `This instance doesn't accept .${ext} attachments (glide.attachment.extensions).${ext === 'webm' || ext === 'mp4' ? ' Save the video to S3 and attach the PDF report instead.' : ''}`;
  }
  if (limits.maxBytes && file.size > limits.maxBytes) {
    return `${file.name} is ${mb(file.size)}; this instance accepts attachments up to ${mb(limits.maxBytes)} (com.glide.attachment.max_size). Save it to S3 and attach the PDF report instead.`;
  }
  return '';
}

/** One-line summary of the instance's limits for the destinations panel. */
export function describeLimits(limits) {
  if (!limits) return '';
  const parts = [];
  if (limits.maxBytes) parts.push(`up to ${mb(limits.maxBytes)} per file`);
  if (limits.allowedExtensions?.length) parts.push(`types: ${limits.allowedExtensions.slice(0, 12).join(', ')}${limits.allowedExtensions.length > 12 ? '…' : ''}`);
  return parts.length ? `This instance accepts ${parts.join('; ')}.` : '';
}

/** Work note posted by /snap after attaching (Settings → ServiceNow, off by default). */
export function workNoteText({ capture, files, links = [] }) {
  const lines = [`Snap Companion attached ${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.name).join(', ')}`];
  const d = capture?.context?.description;
  if (d) lines.push('', d);
  if (links.length) lines.push('', ...links.map((l) => `${l.label}: ${l.url}`));
  return lines.join('\n').slice(0, 4000);
}

// The editor gives up waiting for the page after 5 minutes (storage/servicenow.js).
const DELIVERY_TIMEOUT = 5 * 60_000;

/** A bridge delivery can be retried when every file failed, or when the page never answered. */
export function canRedeliver(delivery, now = Date.now()) {
  if (!delivery) return true;
  if (delivery.state === 'done') return !!delivery.results?.length && delivery.results.every((r) => !r.ok);
  return now - (delivery.at || 0) > DELIVERY_TIMEOUT;
}
