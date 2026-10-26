// Snap Lite: the screenshot half of Snap Companion with no extension. Bundled by
// scripts/build-lite.mjs into one script that the SN Utils /snap-lite command loads into the
// ServiceNow page (snutils/snap-lite-command.js). Exposes window.SnapLite.run().

import { capture } from './capture.js';
import { openEditor } from './editor.js';
import { readInstance } from './servicenow.js';

const MODES = ['screenshot', 'region', 'element'];
let busy = false;

/**
 * record: { mode?, table, sysId, label?, recordUrl?, user?, token, config? }. `config` overrides
 * the snap_lite.config system property (handy for trying settings without an admin).
 */
async function run(record) {
  if (busy) return;
  if (!record?.table || !/^[0-9a-f]{32}$/.test(record.sysId || '')) { alert('Open a saved record first.'); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { alert('Screen capture is not available in this browser.'); return; }
  const mode = MODES.includes(record.mode) ? record.mode : 'screenshot';
  busy = true;
  try {
    const rec = {
      ...record,
      label: record.label || record.sysId,
      recordUrl: record.recordUrl || `${location.origin}/${record.table}.do?sys_id=${record.sysId}`,
    };
    // One quick REST call, well inside the ~5 s the slash command's gesture allows the share picker;
    // capture() asks for a click if it has expired anyway.
    const instance = await readInstance(record.token, record.config);
    const shot = await capture(mode, { redaction: instance.settings.redaction });
    if (!shot) return;
    await openEditor({ shot, record: rec, instance });
  } catch (err) {
    alert(`Snap Lite: ${err.message}`);
  } finally {
    busy = false;
  }
}

window.SnapLite = { run, version: '__VERSION__' };
