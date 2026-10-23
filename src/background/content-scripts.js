// Custom-domain ServiceNow instances (§13): granted via optional_host_permissions from Options,
// then the bridge content script is registered dynamically.

import { getSettings, customSnHosts } from '../shared/settings.js';

const ID = 'sn-custom';

export async function syncCustomContentScripts() {
  const settings = await getSettings();
  const granted = [];
  for (const host of customSnHosts(settings)) {
    const origin = `https://${host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) granted.push(origin);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts([{
    id: ID,
    matches: granted,
    js: ['src/shared/protocol.js', 'src/content/content.js'],
    runAt: 'document_idle',
    allFrames: true,
    persistAcrossSessions: true,
  }]);
}
