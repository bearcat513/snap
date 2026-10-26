// /snap-lite's ServiceNow calls: same-origin REST with the page's session token (g_ck), as the
// /snap command does. No credentials ever leave the instance.

import { DEFAULTS, normalizeCustomFields, normalizeTemplates } from '../src/shared/settings.js';

const CONFIG_PROPERTY = 'snap_lite.config';

function api(token, path, opts = {}) {
  return fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'X-UserToken': token, Accept: 'application/json', ...opts.headers },
  });
}

/**
 * Attachment limits plus the optional `snap_lite.config` system property (JSON), read in one query
 * when the user may read sys_properties. Returns { limits, settings }.
 *
 * Config keys (all optional): templates, customFields, workNote, redactionPatterns, pdfPageSize,
 * fileNamePattern. Templates and custom fields use the extension's shapes (see settings.js).
 */
export async function readInstance(token, overrides = {}) {
  const q = `nameINcom.glide.attachment.max_size,glide.attachment.extensions,${CONFIG_PROPERTY}`;
  let props = [];
  try {
    const r = await api(token, `/api/now/table/sys_properties?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=name,value`);
    if (r.ok) props = (await r.json()).result || [];
  } catch { /* limits and config are optional */ }
  const limits = {};
  let config = {};
  for (const p of props) {
    const v = String(p.value || '').trim();
    if (p.name === 'com.glide.attachment.max_size' && /^\d+$/.test(v)) limits.maxBytes = Number(v) * 1024 * 1024;
    if (p.name === 'glide.attachment.extensions' && v) {
      limits.allowedExtensions = v.split(',').map((x) => x.trim().toLowerCase().replace(/^\./, ''))
        .filter((x) => /^[a-z0-9]{1,16}$/.test(x)).slice(0, 200);
    }
    if (p.name === CONFIG_PROPERTY && v) {
      try { config = JSON.parse(v); } catch { console.warn(`Snap Lite: ${CONFIG_PROPERTY} is not valid JSON; using defaults.`); }
    }
  }
  return { limits, settings: liteSettings({ ...config, ...overrides }) };
}

export function liteSettings(config = {}) {
  return {
    customFields: normalizeCustomFields(config.customFields || []),
    templates: normalizeTemplates(Array.isArray(config.templates) ? config.templates : DEFAULTS.templates),
    workNote: config.workNote === undefined ? DEFAULTS['servicenow.workNote'] : !!config.workNote,
    pageSize: ['letter', 'a4'].includes(config.pdfPageSize) ? config.pdfPageSize : DEFAULTS['pdf.pageSize'],
    fileNamePattern: config.fileNamePattern || DEFAULTS.fileNamePattern,
    redaction: { patterns: DEFAULTS['redaction.patterns'], custom: (config.redactionPatterns || []).map(String) },
  };
}

/** → { name, ok, sysId? , error? } */
export async function attach(token, { table, sysId }, name, mimeType, blob) {
  try {
    const r = await api(token, `/api/now/attachment/file?table_name=${encodeURIComponent(table)}&table_sys_id=${sysId}&file_name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': mimeType }, body: blob,
    });
    if (!r.ok) return { name, ok: false, error: `HTTP ${r.status}` };
    return { name, ok: true, sysId: (await r.json()).result.sys_id };
  } catch (err) {
    return { name, ok: false, error: String(err?.message || err) };
  }
}

export async function addWorkNote(token, { table, sysId }, note) {
  try {
    const r = await api(token, `/api/now/table/${encodeURIComponent(table)}/${sysId}?sysparm_fields=sys_id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work_notes: note }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
