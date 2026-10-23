// Bridge message protocol (§11.3) and validation (§11.4).
// Classic script: loaded as a content script (defines globalThis.SnapProtocol) and imported for
// side effects by the service worker.
(function (root) {
  'use strict';

  const NS = 'snap-companion';
  const V = 1;
  const MODES = ['screenshot', 'region', 'fullpage', 'record-tab', 'record-window'];
  const FORMATS = ['png', 'pdf', 'video'];
  const PAGE_TYPES = ['snap:request', 'snap:uploaded', 'snap:cancelled'];
  const EXT_TYPES = ['snap:accepted', 'snap:rejected', 'snap:file', 'snap:cancelled', 'snap:error'];
  const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

  const isStr = (v, max) => typeof v === 'string' && v.length <= max;

  function isEnvelope(m) {
    return !!m && typeof m === 'object' && m.ns === NS && m.v === V &&
      typeof m.type === 'string' && typeof m.requestId === 'string' && REQUEST_ID.test(m.requestId);
  }

  function envelope(type, requestId, payload) {
    const m = { ns: NS, v: V, type, requestId };
    if (payload !== undefined) m.payload = payload;
    return m;
  }

  /** loc: { host, origin } of the page the request came from. */
  function validateRequestPayload(p, loc) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'Missing payload' };
    if (!MODES.includes(p.mode)) return { ok: false, error: 'Unsupported mode: ' + String(p.mode).slice(0, 40) };
    let deliver = p.deliver === undefined ? ['pdf'] : p.deliver;
    if (!Array.isArray(deliver) || !deliver.length || deliver.some((f) => !FORMATS.includes(f))) {
      return { ok: false, error: 'Invalid deliver formats' };
    }
    deliver = [...new Set(deliver)];
    const c = p.context;
    if (!c || typeof c !== 'object') return { ok: false, error: 'Missing context' };
    if (c.instance !== loc.host) return { ok: false, error: 'Context instance does not match page host' };
    if (!isStr(c.table, 80) || !/^[a-z0-9_]+$/.test(c.table)) return { ok: false, error: 'Invalid table' };
    if (!isStr(c.sysId, 32) || !/^[0-9a-f]{32}$/.test(c.sysId)) return { ok: false, error: 'Invalid sysId' };
    if (c.label !== undefined && !isStr(c.label, 120)) return { ok: false, error: 'Invalid label' };
    if (c.user !== undefined && !isStr(c.user, 120)) return { ok: false, error: 'Invalid user' };
    let recordUrl = loc.origin + '/' + c.table + '.do?sys_id=' + c.sysId;
    if (c.recordUrl !== undefined) {
      if (!isStr(c.recordUrl, 2048) || c.recordUrl.indexOf(loc.origin + '/') !== 0) {
        return { ok: false, error: 'recordUrl must be on the page origin' };
      }
      recordUrl = c.recordUrl;
    }
    return {
      ok: true,
      payload: {
        mode: p.mode,
        deliver,
        context: {
          instance: c.instance, table: c.table, sysId: c.sysId,
          label: c.label || c.sysId, recordUrl, user: c.user || '',
        },
      },
    };
  }

  function validateUploadedPayload(p) {
    if (!p || !Array.isArray(p.results) || p.results.length > 20) return { ok: false, error: 'Invalid results' };
    const results = [];
    for (const r of p.results) {
      if (!r || !isStr(r.name, 255) || typeof r.ok !== 'boolean') return { ok: false, error: 'Invalid result entry' };
      const out = { name: r.name, ok: r.ok };
      if (r.sysId !== undefined) {
        if (!isStr(r.sysId, 32) || !/^[0-9a-f]{32}$/.test(r.sysId)) return { ok: false, error: 'Invalid sysId' };
        out.sysId = r.sysId;
      }
      if (r.error !== undefined) out.error = String(r.error).slice(0, 500);
      results.push(out);
    }
    return { ok: true, payload: { results } };
  }

  /**
   * Validate a window message seen by the content script. Returns null for messages that are not
   * ours to handle (wrong source/origin/namespace or an extension→page type), otherwise
   * { ok, msg?, error? }.
   */
  function validatePageMessage(event, win, loc) {
    if (event.source !== win || event.origin !== loc.origin) return null;
    const m = event.data;
    if (!isEnvelope(m) || PAGE_TYPES.indexOf(m.type) === -1) return null;
    if (m.type === 'snap:request') {
      const r = validateRequestPayload(m.payload, loc);
      return r.ok ? { ok: true, msg: envelope(m.type, m.requestId, r.payload) } : { ok: false, error: r.error, requestId: m.requestId };
    }
    if (m.type === 'snap:uploaded') {
      const r = validateUploadedPayload(m.payload);
      return r.ok ? { ok: true, msg: envelope(m.type, m.requestId, r.payload) } : { ok: false, error: r.error, requestId: m.requestId };
    }
    return { ok: true, msg: envelope(m.type, m.requestId) };
  }

  root.SnapProtocol = {
    NS, V, MODES, FORMATS, PAGE_TYPES, EXT_TYPES,
    isEnvelope, envelope, validateRequestPayload, validateUploadedPayload, validatePageMessage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
