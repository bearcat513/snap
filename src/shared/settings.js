// User settings (chrome.storage.sync) merged with managed policy (chrome.storage.managed), §14.

export const DEFAULTS = {
  defaultScreenshotDestinations: ['download'],
  defaultRecordingDestinations: ['download'],
  snDefaultFormat: 'pdf',
  fileNamePattern: '{table}_{label}_{yyyyMMdd-HHmmss}',
  fallbackFileNamePattern: '{host}_{yyyyMMdd-HHmmss}',
  downloadSubfolder: 'Snap',
  askWhereToSave: false,
  'recording.maxMinutes': 10,
  'recording.mic': false,
  'recording.clickHighlights': true,
  'recording.countdown': true,
  'pdf.pageSize': 'letter',
  'library.maxItems': 20,
  'library.maxMB': 1024,
  snHosts: [],
  fullPageStrategy: 'scroll', // 'scroll' | 'debugger'
  redactionReminder: false,
  's3.mode': 'presign',
  's3.presignEndpoint': '',
  's3.auth': 'none', // 'none' | 'oidc'
  's3.oidcAuthUrl': '',
  's3.keyPrefix': '',
  'capture.delaySeconds': 0, // popup screenshots: 0 | 3 | 5 | 10
  // Extra context fields: [{ id, label, type: 'text' | 'textarea' | 'select', options?: string[], required?: boolean }]
  customFields: [],
  // Context templates applied from the editor: [{ id, name, description, notes, steps: [], tags: [] }]
  templates: [
    {
      id: 'bug',
      name: 'Bug report',
      description: '',
      notes: 'Expected:\n\nActual:\n',
      steps: ['Open the record', ''],
      tags: ['bug'],
    },
    {
      id: 'uat',
      name: 'UAT finding',
      description: '',
      notes: 'Test case:\nExpected result:\nActual result:\nSeverity:',
      steps: [],
      tags: ['uat'],
    },
    {
      id: 'walkthrough',
      name: 'Walkthrough',
      description: 'Walkthrough: ',
      notes: 'Audience:\nCovers:',
      steps: [],
      tags: ['walkthrough'],
    },
  ],
};

export const BUILTIN_SN_SUFFIXES = ['.service-now.com', '.servicenowservices.com'];
export const ALL_DESTINATIONS = ['download', 's3', 'servicenow'];

async function getManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

/** Returns merged settings. `locked` lists keys controlled by policy; `managedSnHosts` are policy hosts. */
export async function getSettings() {
  const [sync, managed] = await Promise.all([chrome.storage.sync.get(null), getManaged()]);
  const s = { ...DEFAULTS, ...sync };
  const locked = new Set();

  if (managed.s3 && typeof managed.s3 === 'object') {
    for (const k of ['mode', 'presignEndpoint', 'auth', 'oidcAuthUrl', 'keyPrefix']) {
      if (managed.s3[k] !== undefined) {
        s[`s3.${k}`] = managed.s3[k];
        locked.add(`s3.${k}`);
      }
    }
  }
  s.managedSnHosts = Array.isArray(managed.snHosts) ? managed.snHosts.map(normalizeHost).filter(Boolean) : [];
  s.snHosts = [...new Set([...(s.snHosts || []).map(normalizeHost).filter(Boolean), ...s.managedSnHosts])];

  s.allowedDestinations = Array.isArray(managed.allowedDestinations) ? managed.allowedDestinations : ALL_DESTINATIONS;
  if (Array.isArray(managed.allowedDestinations)) locked.add('allowedDestinations');

  if (managed.forceRedactionReminder) {
    s.redactionReminder = true;
    locked.add('redactionReminder');
  }
  if (Number.isInteger(managed.recordingMaxMinutes)) {
    s['recording.maxMinutes'] = managed.recordingMaxMinutes;
    locked.add('recording.maxMinutes');
  }
  if (Array.isArray(managed.customFields)) {
    s.customFields = managed.customFields;
    locked.add('customFields');
  }
  if (Array.isArray(managed.templates)) {
    s.templates = managed.templates;
    locked.add('templates');
  }
  s.customFields = normalizeCustomFields(s.customFields);
  s.templates = (Array.isArray(s.templates) ? s.templates : []).filter((t) => t && t.name)
    .map((t, i) => ({ id: String(t.id || `t${i}`), name: String(t.name), description: t.description || '', notes: t.notes || '',
      steps: Array.isArray(t.steps) ? t.steps.map(String) : [], tags: Array.isArray(t.tags) ? t.tags.map(String) : [] }));
  s.locked = [...locked];
  return s;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!current.locked.includes(k) && k in DEFAULTS) clean[k] = v;
  }
  if (clean.snHosts) clean.snHosts = clean.snHosts.map(normalizeHost).filter((h) => h && !current.managedSnHosts.includes(h));
  await chrome.storage.sync.set(clean);
}

export function normalizeCustomFields(fields) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  const out = [];
  for (const f of fields) {
    if (!f || !f.label) continue;
    let id = String(f.id || f.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `field${out.length}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    const type = ['text', 'textarea', 'select'].includes(f.type) ? f.type : 'text';
    out.push({
      id, label: String(f.label), type, required: !!f.required,
      options: type === 'select' ? (Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean) : undefined,
    });
  }
  return out;
}

/**
 * Merge a template into context. Empty fields are filled; notes are appended; steps fill an empty
 * list; tags are unioned.
 */
export function applyTemplate(context, template) {
  const c = { ...context, steps: [...(context.steps || [])], tags: [...(context.tags || [])] };
  if (template.description && !c.description) c.description = template.description;
  if (template.notes) c.notes = c.notes && c.notes.trim() ? `${c.notes.replace(/\s+$/, '')}\n\n${template.notes}` : template.notes;
  if (template.steps?.length && !c.steps.some((s) => s.trim())) c.steps = [...template.steps];
  for (const t of template.tags || []) if (!c.tags.includes(t)) c.tags.push(t);
  return c;
}

export function normalizeHost(input) {
  if (!input || typeof input !== 'string') return '';
  let h = input.trim().toLowerCase();
  try {
    if (h.includes('://')) h = new URL(h).host;
  } catch {
    return '';
  }
  h = h.split('/')[0];
  return /^[a-z0-9.-]+(:\d+)?$/.test(h) ? h : '';
}

export function isBuiltinSnHost(host) {
  host = (host || '').toLowerCase();
  return BUILTIN_SN_SUFFIXES.some((suf) => host.endsWith(suf) && host.length > suf.length);
}

export function isSnHost(host, settings) {
  host = (host || '').toLowerCase();
  return isBuiltinSnHost(host) || (settings.snHosts || []).includes(host);
}

/** Extra hosts that aren't covered by the static manifest patterns. */
export function customSnHosts(settings) {
  return (settings.snHosts || []).filter((h) => !isBuiltinSnHost(h));
}

export function destinationAllowed(id, settings) {
  return (settings.allowedDestinations || ALL_DESTINATIONS).includes(id);
}
