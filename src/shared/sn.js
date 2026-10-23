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
