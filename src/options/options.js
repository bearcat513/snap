// Options page (§14). Inputs with data-key bind to chrome.storage.sync; managed keys are locked.

import { getSettings, setSettings, normalizeHost, isBuiltinSnHost, customSnHosts } from '../shared/settings.js';
import { buildFileName } from '../shared/naming.js';
import { endpointOrigin } from '../storage/s3.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- generic bindings ----------

function render() {
  for (const input of document.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    const value = settings[key];
    if (input.dataset.value) input.checked = Array.isArray(value) && value.includes(input.dataset.value);
    else if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
    const locked = settings.locked.includes(key);
    input.disabled = locked;
    const label = input.closest('label');
    label?.classList.toggle('locked', locked);
    if (locked && label && !label.querySelector('.lock-tag')) {
      const tag = document.createElement('span');
      tag.className = 'lock-tag';
      tag.textContent = 'Managed';
      (label.querySelector('span') || label).append(tag);
    }
  }
  $('managed-note').hidden = !settings.locked.length && !settings.managedSnHosts.length;
  $('oidc-row').hidden = settings['s3.auth'] !== 'oidc';
  updatePreview();
}

async function onChange(e) {
  const input = e.target;
  const key = input.dataset.key;
  if (!key) return;
  let value;
  if (input.dataset.value) {
    value = [...document.querySelectorAll(`[data-key="${key}"][data-value]`)].filter((i) => i.checked).map((i) => i.dataset.value);
  } else if (input.type === 'checkbox') value = input.checked;
  else if (input.type === 'number') {
    value = Number(input.value);
    if (!Number.isFinite(value) || value < Number(input.min || 0)) { input.value = settings[key]; return; }
  } else value = input.value.trim();

  // Some choices need a permission, requested inside this user gesture.
  if (key === 'fullPageStrategy' && value === 'debugger') {
    const ok = await chrome.permissions.request({ permissions: ['debugger'] });
    if (!ok) { input.value = 'scroll'; toast('Permission not granted — using scroll & stitch.'); return; }
  }
  if (key === 's3.auth' && value === 'oidc') {
    const ok = await chrome.permissions.request({ permissions: ['identity'] });
    if (!ok) { input.value = 'none'; toast('The identity permission is needed for OIDC sign-in.'); return; }
  }

  await setSettings({ [key]: value });
  settings = await getSettings();
  render();
  toast('Saved');
}

document.addEventListener('change', onChange);
document.querySelectorAll('input[type="text"][data-key], input[type="url"][data-key]').forEach((i) => i.addEventListener('input', updatePreview));

function updatePreview() {
  const pattern = document.querySelector('[data-key="fileNamePattern"]').value || settings.fileNamePattern;
  $('name-preview').textContent = buildFileName(pattern, { table: 'incident', label: 'INC0012345', host: 'acme.service-now.com', title: 'Example' }, new Date(), 'pdf');
}

// ---------- custom fields & templates ----------

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

let saveTimer = null;
function saveList(key, value) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await setSettings({ [key]: value });
      settings = await getSettings();
      toast('Saved');
    } catch (err) {
      toast(/QUOTA/i.test(err.message) ? 'Too much text to sync — shorten the templates.' : `Not saved: ${err.message}`);
    }
  }, 400);
}

let fields = [];
function renderFields() {
  const locked = settings.locked.includes('customFields');
  $('cf-locked').hidden = !locked;
  $('btn-add-field').hidden = locked;
  const save = () => saveList('customFields', fields.filter((f) => f.label.trim()));
  $('custom-fields').replaceChildren(...fields.map((f, i) => {
    const opts = h('label', { class: 'field opts', hidden: f.type !== 'select' }, h('span', { text: 'Options (comma separated)' }),
      h('input', { type: 'text', value: (f.options || []).join(', '), disabled: locked, oninput: (e) => { f.options = e.target.value.split(',').map((o) => o.trim()).filter(Boolean); save(); } }));
    const type = h('select', { disabled: locked, 'aria-label': 'Field type', onchange: (e) => { f.type = e.target.value; opts.hidden = f.type !== 'select'; save(); } },
      h('option', { value: 'text', text: 'Single line' }), h('option', { value: 'textarea', text: 'Multi-line' }), h('option', { value: 'select', text: 'Choice' }));
    type.value = f.type || 'text';
    return h('li', {},
      h('div', { class: 'grid' },
        h('input', { type: 'text', placeholder: 'Label, e.g. Environment', 'aria-label': 'Field label', value: f.label, disabled: locked, oninput: (e) => { f.label = e.target.value; save(); } }),
        type,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.required, disabled: locked, onchange: (e) => { f.required = e.target.checked; save(); } }), 'Required'),
        locked ? null : h('button', { class: 'ghost danger', onclick: () => { fields.splice(i, 1); save(); renderFields(); } }, 'Remove')),
      opts);
  }));
  if (!fields.length) $('custom-fields').append(h('li', { class: 'muted small', text: 'No extra fields.' }));
}
$('btn-add-field').addEventListener('click', () => { fields.push({ label: '', type: 'text', required: false }); renderFields(); $('custom-fields').querySelector('li:last-child input')?.focus(); });

let templates = [];
function renderTemplates() {
  const locked = settings.locked.includes('templates');
  $('tpl-locked').hidden = !locked;
  $('btn-add-template').hidden = locked;
  const save = () => saveList('templates', templates.filter((t) => t.name.trim()));
  $('templates').replaceChildren(...templates.map((t, i) => h('li', {},
    h('div', { class: 'tpl-grid' },
      h('label', {}, h('span', { text: 'Name' }), h('input', { type: 'text', value: t.name, disabled: locked, oninput: (e) => { t.name = e.target.value; save(); } })),
      h('label', {}, h('span', { text: 'Tags (comma separated)' }), h('input', { type: 'text', value: (t.tags || []).join(', '), disabled: locked, oninput: (e) => { t.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); save(); } })),
      h('label', { class: 'wide' }, h('span', { text: 'Description' }), h('input', { type: 'text', value: t.description, disabled: locked, oninput: (e) => { t.description = e.target.value; save(); } })),
      h('label', {}, h('span', { text: 'Notes' }), h('textarea', { rows: 4, value: t.notes, disabled: locked, oninput: (e) => { t.notes = e.target.value; save(); } })),
      h('label', {}, h('span', { text: 'Steps (one per line)' }), h('textarea', { rows: 4, value: (t.steps || []).join('\n'), disabled: locked, oninput: (e) => { t.steps = e.target.value.split('\n'); save(); } }))),
    locked ? null : h('button', { class: 'ghost danger', onclick: () => { templates.splice(i, 1); save(); renderTemplates(); } }, 'Remove template'))));
  if (!templates.length) $('templates').append(h('li', { class: 'muted small', text: 'No templates.' }));
}
$('btn-add-template').addEventListener('click', () => {
  templates.push({ id: crypto.randomUUID().slice(0, 8), name: 'New template', description: '', notes: '', steps: [], tags: [] });
  renderTemplates();
});

fields = structuredClone(settings.customFields);
templates = structuredClone(settings.templates);
renderFields();
renderTemplates();

// ---------- microphone ----------

async function micStatus() {
  const p = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  $('mic-status').textContent = p ? (p.state === 'granted' ? 'Microphone access granted.' : p.state === 'denied' ? 'Blocked — allow it in Chrome site settings for this extension.' : 'Not granted yet.') : '';
  $('btn-mic').disabled = p?.state === 'granted';
}
$('btn-mic').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    toast('Microphone enabled');
  } catch (err) {
    toast(`Microphone: ${err.name}`);
  }
  micStatus();
});
micStatus();

// ---------- ServiceNow hosts ----------

async function renderHosts() {
  const list = $('hosts');
  list.replaceChildren();
  const hosts = [...settings.managedSnHosts.filter((h) => !isBuiltinSnHost(h)), ...customSnHosts(settings).filter((h) => !settings.managedSnHosts.includes(h))];
  for (const host of hosts) {
    const managed = settings.managedSnHosts.includes(host);
    const granted = await chrome.permissions.contains({ origins: [`https://${host}/*`] });
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = host;
    li.append(code);
    if (managed) {
      const tag = document.createElement('span');
      tag.className = 'lock-tag';
      tag.textContent = 'Managed';
      li.append(tag);
    }
    if (!granted) {
      const grant = document.createElement('button');
      grant.textContent = 'Grant access';
      grant.addEventListener('click', async () => {
        const ok = await chrome.permissions.request({ origins: [`https://${host}/*`] });
        toast(ok ? `Access granted for ${host}` : 'Access not granted');
        renderHosts();
      });
      li.append(grant);
    } else {
      const ok = document.createElement('span');
      ok.className = 'small ok';
      ok.textContent = 'Active';
      li.append(ok);
    }
    if (!managed) {
      const rm = document.createElement('button');
      rm.className = 'ghost danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        await chrome.permissions.remove({ origins: [`https://${host}/*`] }).catch(() => {});
        await setSettings({ snHosts: customSnHosts(settings).filter((h) => h !== host && !settings.managedSnHosts.includes(h)) });
        settings = await getSettings();
        renderHosts();
      });
      li.append(rm);
    }
    list.append(li);
  }
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No custom hosts.';
    list.append(li);
  }
}

$('host-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = normalizeHost($('host-input').value);
  if (!host) { toast('Enter a host name like servicenow.example.com'); return; }
  if (isBuiltinSnHost(host)) { toast('That host is already covered.'); return; }
  // Request first (user gesture), then persist.
  const ok = await chrome.permissions.request({ origins: [`https://${host}/*`] });
  const current = customSnHosts(settings).filter((h) => !settings.managedSnHosts.includes(h));
  await setSettings({ snHosts: [...new Set([...current, host])] });
  settings = await getSettings();
  $('host-input').value = '';
  toast(ok ? `${host} added. Reload open tabs on that host.` : `${host} added, but access wasn't granted yet.`);
  renderHosts();
});

$('opt-allurls').checked = await chrome.permissions.contains({ origins: ['<all_urls>'] });
$('opt-allurls').addEventListener('change', async (e) => {
  e.stopPropagation();
  const box = e.target;
  if (box.checked) box.checked = await chrome.permissions.request({ origins: ['<all_urls>'] });
  else await chrome.permissions.remove({ origins: ['<all_urls>'] });
  toast(box.checked ? 'One-step /snap enabled' : 'One-step /snap disabled');
});

// ---------- S3 ----------

$('redirect-uri').textContent = chrome.identity ? chrome.identity.getRedirectURL('s3') : `https://${chrome.runtime.id}.chromiumapp.org/s3`;

async function s3Status() {
  const origin = endpointOrigin(settings);
  if (!settings['s3.presignEndpoint']) { $('s3-status').textContent = 'No endpoint configured.'; $('btn-s3-grant').disabled = true; return; }
  if (!origin) { $('s3-status').textContent = 'Endpoint must be https://'; $('btn-s3-grant').disabled = true; return; }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  $('s3-status').textContent = granted ? `Access granted for ${origin.replace('/*', '')}` : 'Not granted yet (you can also grant it on first save).';
  $('btn-s3-grant').disabled = granted;
}
$('btn-s3-grant').addEventListener('click', async () => {
  const origin = endpointOrigin(settings);
  if (origin) await chrome.permissions.request({ origins: [origin] });
  s3Status();
});
chrome.storage.onChanged.addListener(async () => {
  settings = await getSettings();
  s3Status();
});

// ---------- misc ----------

async function renderShortcuts() {
  const cmds = await chrome.commands.getAll();
  $('shortcuts').replaceChildren(...cmds.filter((c) => c.description).map((c) => {
    const li = document.createElement('li');
    const k = document.createElement('kbd');
    k.textContent = c.shortcut || 'not set';
    li.append(k, ` ${c.description}`);
    return li;
  }));
}
$('btn-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('btn-library').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html?view=library') }));

// ---------- tabs ----------

const panels = [...document.querySelectorAll('.panel[data-tab]')];
const tablist = $('tabs');
const tabs = panels.map((panel) => {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.id = `tabbtn-${panel.dataset.tab}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panel.id);
  tab.textContent = panel.dataset.title;
  panel.setAttribute('aria-labelledby', tab.id);
  tab.addEventListener('click', () => selectTab(panel.dataset.tab, { focus: false }));
  tablist.append(tab);
  return tab;
});

function selectTab(name, { focus = false, updateHash = true } = {}) {
  const i = Math.max(0, panels.findIndex((p) => p.dataset.tab === name));
  panels.forEach((p, j) => { p.hidden = j !== i; });
  tabs.forEach((t, j) => {
    t.setAttribute('aria-selected', String(j === i));
    t.tabIndex = j === i ? 0 : -1;
  });
  if (focus) tabs[i].focus();
  tabs[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (updateHash && location.hash !== `#${panels[i].dataset.tab}`) history.replaceState(null, '', `#${panels[i].dataset.tab}`);
  try { localStorage.setItem('snap.optionsTab', panels[i].dataset.tab); } catch { /* convenience only */ }
}

tablist.addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(panels[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
});
window.addEventListener('hashchange', () => selectTab(location.hash.slice(1), { updateHash: false }));
function markManagedTabs() {
  panels.forEach((p, i) => {
    const managed = !!p.querySelector('.locked, .lock-tag:not([hidden]), #cf-locked:not([hidden]), #tpl-locked:not([hidden])');
    tabs[i].querySelector('.managed-dot')?.remove();
    if (managed) {
      const dot = document.createElement('span');
      dot.className = 'managed-dot';
      dot.title = 'Contains settings managed by your organization';
      tabs[i].append(dot);
    }
  });
}

let initialTab = location.hash.slice(1);
if (!initialTab) { try { initialTab = localStorage.getItem('snap.optionsTab') || ''; } catch { /* ignore */ } }
selectTab(initialTab || 'saving', { updateHash: !!location.hash });

render();
markManagedTabs();
renderHosts();
renderShortcuts();
s3Status();
