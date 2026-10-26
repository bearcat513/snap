// SN Utils script command: /snap-lite  (no extension needed)
//
// Usage on a saved record:  /snap-lite           → screenshot of this tab → editor → attach PDF + PNG
//                           /snap-lite region    → drag a region
//                           /snap-lite element   → click a page element
//
// Loads the Snap Lite bundle (dist/snap-lite.js, from `npm run build:lite`) from a UI Script named
// snap_lite on this instance, then runs it in the top window so the editor covers the whole page
// (SN Utils may run this inside Classic UI's gsft_main frame). Chrome asks which tab to share each
// time: pick this tab.
(function () {
  var UI_SCRIPT = '/snap_lite.jsdbx';
  var table = '$table', sysId = '$sysid';
  if (!table || !/^[0-9a-f]{32}$/.test(sysId)) return alert('Open a saved record first.');
  var win = window;
  try { if (window.top.document) win = window.top; } catch (e) { /* cross-origin top: stay here */ }
  var gf = window.g_form;
  var record = {
    mode: String.raw`$0`.trim() || 'screenshot',
    table: table, sysId: sysId,
    label: (gf && gf.getValue && gf.getValue('number')) || sysId,
    recordUrl: location.origin + '/' + table + '.do?sys_id=' + sysId,
    user: (window.g_user && g_user.userName) || '',
    token: window.g_ck || win.g_ck
  };
  if (win.SnapLite) return win.SnapLite.run(record);
  var s = win.document.createElement('script');
  s.src = UI_SCRIPT;
  s.onload = function () { win.SnapLite ? win.SnapLite.run(record) : alert('Snap Lite: ' + UI_SCRIPT + ' loaded but did not define SnapLite.'); };
  s.onerror = function () { alert('Snap Lite: could not load ' + UI_SCRIPT + '. Ask an admin to add the snap_lite UI Script.'); };
  win.document.head.appendChild(s);
})();
