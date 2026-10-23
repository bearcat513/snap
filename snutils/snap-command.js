// SN Utils script command: /snap  (§11.5)
//
// Usage on a saved record:  /snap            → visible-area screenshot → editor → attach PDF
//                           /snap region     → drag a region
//                           /snap fullpage   → scroll & stitch
//                           /snap record-tab → tab recording (press Alt+Shift+R to start)
//                           /snap record-window
//
// Uses Snap Companion when installed (detected via <html data-snap-companion>), otherwise falls
// back to a page-only screenshot via getDisplayMedia that is attached directly as PNG.
(function () {
  var table = '$table', sysId = '$sysid';
  if (!table || !/^[0-9a-f]{32}$/.test(sysId)) return alert('Open a saved record first.');
  var token = window.g_ck || (window.top && window.top.g_ck);
  var mode = (String.raw`$0`.trim() || 'screenshot');

  function upload(name, mimeType, blob) {
    return fetch('/api/now/attachment/file?table_name=' + encodeURIComponent(table) +
      '&table_sys_id=' + sysId + '&file_name=' + encodeURIComponent(name), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-UserToken': token, 'Content-Type': mimeType, 'Accept': 'application/json' },
      body: blob
    }).then(function (r) {
      return r.ok ? r.json().then(function (j) { return { name: name, ok: true, sysId: j.result.sys_id }; })
                  : { name: name, ok: false, error: 'HTTP ' + r.status };
    }, function (err) {
      return { name: name, ok: false, error: String(err && err.message || err) };
    });
  }

  if (!document.documentElement.dataset.snapCompanion) {
    return runFallbackSnap();
  }

  var requestId = crypto.randomUUID();
  function send(type, payload) {
    window.postMessage({ ns: 'snap-companion', v: 1, type: type, requestId: requestId, payload: payload }, location.origin);
  }

  window.addEventListener('message', function onMsg(e) {
    var m = e.data;
    if (e.origin !== location.origin || !m || m.ns !== 'snap-companion' || m.requestId !== requestId) return;
    if (m.type === 'snap:file') {
      Promise.all(m.payload.files.map(function (f) { return upload(f.name, f.mimeType, f.blob); }))
        .then(function (results) {
          send('snap:uploaded', { results: results });
          window.removeEventListener('message', onMsg);
          var failed = results.filter(function (r) { return !r.ok; });
          if (!failed.length && window.GlideUI && GlideUI.get) {
            try { GlideUI.get().addOutputMessage({ msg: 'Snap Companion: attached ' + results.length + ' file(s)', type: 'success' }); } catch (_) { /* optional */ }
          }
        });
    }
    if (m.type === 'snap:cancelled' || m.type === 'snap:error' || m.type === 'snap:rejected') {
      window.removeEventListener('message', onMsg);
      if (m.type !== 'snap:cancelled') alert('Snap Companion: ' + ((m.payload && m.payload.message) || m.type));
    }
  });

  send('snap:request', {
    mode: mode,
    deliver: mode.indexOf('record') === 0 ? ['pdf', 'video'] : ['pdf'],
    context: {
      instance: location.host, table: table, sysId: sysId,
      label: (window.g_form && g_form.getValue && g_form.getValue('number')) || sysId,
      recordUrl: location.origin + '/' + table + '.do?sys_id=' + sysId,
      user: (window.g_user && g_user.userName) || ''
    }
  });

  // Page-only fallback: one frame of the current tab via getDisplayMedia, attached as PNG.
  function runFallbackSnap() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return alert('Screen capture is not available in this browser.');
    navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true })
      .then(function (stream) {
        var video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        return video.play().then(function () {
          return new Promise(function (r) { setTimeout(r, 400); });
        }).then(function () {
          var c = document.createElement('canvas');
          c.width = video.videoWidth;
          c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
          stream.getTracks().forEach(function (t) { t.stop(); });
          return new Promise(function (r) { c.toBlob(r, 'image/png'); });
        });
      })
      .then(function (blob) {
        var label = (window.g_form && g_form.getValue && g_form.getValue('number')) || sysId;
        var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
        var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        var name = (table + '_' + label + '_' + stamp).replace(/[^A-Za-z0-9._-]+/g, '_') + '.png';
        return upload(name, 'image/png', blob);
      })
      .then(function (r) {
        alert(r.ok ? 'Screenshot attached: ' + r.name : 'Attach failed: ' + r.error);
      }, function (err) {
        if (err && err.name !== 'NotAllowedError') alert('Snap failed: ' + err.message);
      });
  }
})();
