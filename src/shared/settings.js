// User settings merged with managed policy (chrome.storage.managed), §14. Small settings roam in
// chrome.storage.sync; large lists and secrets stay in chrome.storage.local (see LOCAL_KEYS).

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
  'recording.quality': '1080p', // '720p' | '1080p' | '1440p' | 'source'
  'recording.fps': 30,
  'recording.bitrateMbps': 2.5,
  'recording.keystrokes': false,
  'pdf.pageSize': 'letter',
  'library.maxItems': 20,
  'library.maxMB': 1024,
  snHosts: [],
  fullPageStrategy: 'scroll', // 'scroll' | 'debugger'
  redactionReminder: false,
  // Suggested redactions found in the page's text at capture time (§6 smart redaction).
  'redaction.suggest': true,
  'redaction.patterns': ['email', 'phone', 'ipv4', 'card', 'token'],
  'redaction.custom': [], // extra regular expressions (strings)
  's3.mode': 'presign',
  's3.presignEndpoint': '',
  's3.auth': 'none', // 'none' | 'oidc'
  's3.oidcAuthUrl': '',
  's3.keyPrefix': '',
  'capture.delaySeconds': 0, // popup screenshots: 0 | 3 | 5 | 10
  'capture.elementPadding': 8, // CSS px around a captured element
  'capture.viewports': [375, 768, 1280], // widths for multi-viewport capture
  'recording.trackClicks': true, // remember what was clicked, for guides
  'recording.captions': false, // on-device speech recognition of the microphone
  'gif.fps': 10,
  'gif.maxWidth': 800,
  'servicenow.workNote': false, // post a work note after attaching
  'webhook.url': '',
  'webhook.token': '',
  'jira.baseUrl': '',
  'jira.email': '',
  'jira.apiToken': '',
  'jira.projectKey': '',
  'jira.issueType': 'Bug',
  'github.apiUrl': 'https://api.github.com',
  'github.repo': '', // owner/name
  'github.token': '',
  'github.attachmentsBranch': '', // commit files here and link them from the issue
  'ui.theme': 'system', // 'system' | 'light' | 'dark'
  'editor.defaultTool': 'arrow',
  'editor.defaultColor': '#e5484d',
  'editor.defaultWidth': 4,
  'editor.defaultBlurMode': 'pixelate',
  'editor.rememberStyle': true, // start each capture with the last tool/color/width used
  'editor.palette': ['#e5484d', '#f76b15', '#ffd60a', '#30a46c', '#2563eb', '#111111', '#ffffff'],
  // Extra context fields: [{ id, label, type: 'text' | 'textarea' | 'select', options?: string[], required?: boolean }]
  customFields: [],
  // Context templates applied from the editor: [{ id, name, description, notes, steps: [], tags: [], tables: [] }]
  // `tables` auto-applies the template to new /snap captures from those ServiceNow tables.
  templates: [
    {
      id: 'bug',
      name: 'Bug report',
      description: '',
      notes: 'Expected:\n\nActual:\n',
      steps: ['Open the record', ''],
      tags: ['bug'],
      tables: [],
    },
    {
      id: 'uat',
      name: 'UAT finding',
      description: '',
      notes: 'Test case:\nExpected result:\nActual result:\nSeverity:',
      steps: [],
      tags: ['uat'],
      tables: [],
    },
    {
      id: 'walkthrough',
      name: 'Walkthrough',
      description: 'Walkthrough: ',
      notes: 'Audience:\nCovers:',
      steps: [],
      tags: ['walkthrough'],
      tables: [],
    },
  ],
};

export const BUILTIN_SN_SUFFIXES = ['.service-now.com', '.servicenowservices.com'];
export const ALL_DESTINATIONS = ['download', 's3', 'servicenow', 'webhook', 'jira', 'github'];

// Kept in chrome.storage.local: lists that can outgrow sync's 8 KB-per-item quota, and credentials,
// which must never roam to other devices.
export const LOCAL_KEYS = ['templates', 'customFields', 'webhook.token', 'jira.apiToken', 'github.token'];
export const SECRET_KEYS = ['webhook.token', 'jira.apiToken', 'github.token'];
const SYNC_ITEM_LIMIT = 8192; // chrome.storage.sync.QUOTA_BYTES_PER_ITEM

/** Move keys that older versions kept in sync into local storage. Safe to run repeatedly. */
export async function migrateSettings() {
  const sync = await chrome.storage.sync.get(LOCAL_KEYS);
  const keys = Object.keys(sync);
  if (!keys.length) return;
  const local = await chrome.storage.local.get(keys);
  const move = Object.fromEntries(keys.filter((k) => !(k in local)).map((k) => [k, sync[k]]));
  if (Object.keys(move).length) await chrome.storage.local.set(move);
  await chrome.storage.sync.remove(keys);
}

async function getManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

/** Returns merged settings. `locked` lists keys controlled by policy; `managedSnHosts` are policy hosts. */
export async function getSettings() {
  const [sync, local, managed] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(LOCAL_KEYS), getManaged()]);
  // Local wins; sync is only read for keys not yet migrated.
  const s = { ...DEFAULTS, ...sync, ...local };
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
  if (Array.isArray(managed.redactionPatterns)) {
    s['redaction.custom'] = managed.redactionPatterns.map(String);
    locked.add('redaction.custom');
  }
  if (typeof managed.snWorkNote === 'boolean') {
    s['servicenow.workNote'] = managed.snWorkNote;
    locked.add('servicenow.workNote');
  }
  for (const [policy, key] of [['webhookUrl', 'webhook.url'], ['jiraBaseUrl', 'jira.baseUrl'], ['jiraProjectKey', 'jira.projectKey'], ['githubApiUrl', 'github.apiUrl'], ['githubRepo', 'github.repo']]) {
    if (typeof managed[policy] === 'string') {
      s[key] = managed[policy];
      locked.add(key);
    }
  }
  s['s3.mode'] = 'presign'; // the only mode this build supports
  s.customFields = normalizeCustomFields(s.customFields);
  s.templates = normalizeTemplates(s.templates);
  s['editor.palette'] = normalizePalette(s['editor.palette']);
  s['capture.viewports'] = normalizeViewports(s['capture.viewports']);
  s.locked = [...locked];
  return s;
}

const HEX = /^#[0-9a-f]{6}$/;

const strList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

export function normalizeTemplates(templates) {
  return (Array.isArray(templates) ? templates : []).filter((t) => t && t.name)
    .map((t, i) => ({
      id: String(t.id || `t${i}`), name: String(t.name), description: t.description || '', notes: t.notes || '',
      steps: Array.isArray(t.steps) ? t.steps.map(String) : [], tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      tables: strList(t.tables).map((x) => x.toLowerCase()),
    }));
}

/** The template to auto-apply for a ServiceNow table, if any (first match wins). */
export function templateForTable(templates, table) {
  if (!table) return null;
  return (templates || []).find((t) => (t.tables || []).includes(String(table).toLowerCase())) || null;
}

/** Sorted, de-duplicated widths between 240 and 3840 px (at most 6); the defaults if none are valid. */
export function normalizeViewports(widths) {
  const out = [...new Set(strList(widths).map(Number).filter((w) => Number.isInteger(w) && w >= 240 && w <= 3840))].sort((a, b) => a - b);
  return out.length ? out.slice(0, 6) : [...DEFAULTS['capture.viewports']];
}

/** Lower-cased, de-duplicated #rrggbb colors (at most 16); the default palette if none are valid. */
export function normalizePalette(colors) {
  const out = [...new Set((Array.isArray(colors) ? colors : []).map((c) => String(c).trim().toLowerCase()).filter((c) => HEX.test(c)))];
  return out.length ? out.slice(0, 16) : [...DEFAULTS['editor.palette']];
}

const QUALITY = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], source: [3840, 2160] };

/** Capture constraints and encoder bitrate for recordings (Settings → Recording). */
export function recordingQuality(settings) {
  const [maxWidth, maxHeight] = QUALITY[settings['recording.quality']] || QUALITY['1080p'];
  const fps = [15, 24, 30, 60].includes(Number(settings['recording.fps'])) ? Number(settings['recording.fps']) : 30;
  const mbps = Math.min(50, Math.max(0.5, Number(settings['recording.bitrateMbps']) || 2.5));
  return { maxWidth, maxHeight, fps, videoBitsPerSecond: Math.round(mbps * 1_000_000) };
}

/** Bytes chrome.storage.sync counts for one item (key + JSON value). */
export function syncItemBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const sync = {};
  const local = {};
  for (const [k, v] of Object.entries(patch)) {
    if (current.locked.includes(k) || !(k in DEFAULTS)) continue;
    (LOCAL_KEYS.includes(k) ? local : sync)[k] = v;
  }
  if (sync.snHosts) sync.snHosts = sync.snHosts.map(normalizeHost).filter((h) => h && !current.managedSnHosts.includes(h));
  const big = Object.entries(sync).find(([k, v]) => syncItemBytes(k, v) > SYNC_ITEM_LIMIT);
  if (big) throw new Error(`"${big[0]}" is too large to sync (over 8 KB). Shorten it and try again.`);
  if (Object.keys(local).length) {
    await chrome.storage.local.set(local);
    await chrome.storage.sync.remove(Object.keys(local)).catch(() => {});
  }
  if (Object.keys(sync).length) {
    try {
      await chrome.storage.sync.set(sync);
    } catch (err) {
      throw new Error(/QUOTA/i.test(err.message) ? 'Chrome sync storage is full. Remove some palette colors or hosts, or shorten long settings.' : err.message);
    }
  }
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
