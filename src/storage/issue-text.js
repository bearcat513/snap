// Issue text for the tracker destinations (§6): the sidecar Markdown, converted to Jira wiki markup
// where needed, plus helpers shared by the webhook, Jira and GitHub adapters.

/** Markdown (as ExportFactory.markdown writes it) → Jira wiki markup. */
export function markdownToJira(md) {
  return md.split('\n').map((line) => {
    let l = line;
    const h = /^(#{1,6}) (.*)$/.exec(l);
    if (h) return `h${h[1].length}. ${h[2]}`;
    l = l.replace(/^(\s*)- /, (_, sp) => `${'*'.repeat(sp.length / 2 + 1)} `);
    l = l.replace(/^(\d+)\. /, '# ');
    l = l.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '[$1|$2]');
    l = l.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    return l;
  }).join('\n');
}

/** Issue summary: the capture's description, else its title (trackers cap the length). */
export function issueSummary(capture, max = 250) {
  const s = (capture.context?.description || capture.title || 'Capture').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The issue a destination created for this capture earlier (so retries attach to it), or null. */
export function existingIssue(capture, adapter) {
  const hit = [...(capture.saves || [])].reverse().find((s) => s.adapter === adapter && s.issue);
  return hit ? { id: hit.issue, url: hit.location } : null;
}

/** origin/* for a configured https URL (http only for localhost), or null. */
export function originPattern(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost') ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

/** Error text from a failed tracker response. */
export async function httpError(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.message || body.errorMessages?.join(' ') || Object.values(body.errors || {}).join(' ') || '';
  } catch { /* not JSON */ }
  const hint = res.status === 401 || res.status === 403 ? ' Check the token in Settings → Issue trackers.' : '';
  return `${what} failed (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}.${hint}`;
}
