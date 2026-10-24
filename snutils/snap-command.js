// SN Utils script command: /snap  (§11.5)
//
// Usage on a saved record:  /snap            → visible-area screenshot → editor → attach PDF
//                           /snap region     → drag a region
//                           /snap element    → click a page element
//                           /snap fullpage   → scroll & stitch
//                           /snap session    → collect several captures, attach them as one report
//                           /snap record-tab → tab recording (press Alt+Shift+R to start)
//                           /snap record-window
//
// The instance's attachment limits (com.glide.attachment.max_size, glide.attachment.extensions)
// are read first when the user may read sys_properties, so the editor can warn before uploading.
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

  function addWorkNote(note) {
    return fetch('/api/now/table/' + encodeURIComponent(table) + '/' + sysId + '?sysparm_fields=sys_id', {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'X-UserToken': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ work_notes: note })
    }).then(function (r) { return r.ok; }, function () { return false; });
  }

  function readLimits() {
    var q = 'nameINcom.glide.attachment.max_size,glide.attachment.extensions';
    return fetch('/api/now/table/sys_properties?sysparm_query=' + encodeURIComponent(q) + '&sysparm_fields=name,value', {
      credentials: 'same-origin', headers: { 'X-UserToken': token, 'Accept': 'application/json' }
    }).then(function (r) { return r.ok ? r.json() : { result: [] }; }).then(function (j) {
      var out = {};
      (j.result || []).forEach(function (p) {
        var v = String(p.value || '').trim();
        if (p.name === 'com.glide.attachment.max_size' && /^\d+$/.test(v)) out.maxBytes = Number(v) * 1024 * 1024;
        if (p.name === 'glide.attachment.extensions' && v) {
          out.allowedExtensions = v.split(',').map(function (x) { return x.trim().toLowerCase().replace(/^\./, ''); })
            .filter(function (x) { return /^[a-z0-9]{1,16}$/.test(x); }).slice(0, 200);
        }
      });
      return out;
    }, function () { return {}; });
  }

  window.addEventListener('message', function onMsg(e) {
    var m = e.data;
    if (e.origin !== location.origin || !m || m.ns !== 'snap-companion' || m.requestId !== requestId) return;
    if (m.type === 'snap:file') {
      Promise.all(m.payload.files.map(function (f) { return upload(f.name, f.mimeType, f.blob); }))
        .then(function (results) {
          var failed = results.filter(function (r) { return !r.ok; });
          // Keep listening after a total failure: the editor can retry the delivery.
          if (results.length && failed.length < results.length) window.removeEventListener('message', onMsg);
          var noted = failed.length < results.length && m.payload.note ? addWorkNote(m.payload.note) : Promise.resolve(false);
          return noted.then(function () {
            send('snap:uploaded', { results: results });
            if (!failed.length && window.GlideUI && GlideUI.get) {
              try { GlideUI.get().addOutputMessage({ msg: 'Snap Companion: attached ' + results.length + ' file(s)', type: 'success' }); } catch (_) { /* optional */ }
            }
          });
        });
    }
    if (m.type === 'snap:cancelled' || m.type === 'snap:error' || m.type === 'snap:rejected') {
      window.removeEventListener('message', onMsg);
      if (m.type !== 'snap:cancelled') alert('Snap Companion: ' + ((m.payload && m.payload.message) || m.type));
    }
  });

  readLimits().then(function (limits) {
    send('snap:request', {
      mode: mode,
      deliver: mode.indexOf('record') === 0 ? ['pdf', 'video'] : ['pdf'],
      context: {
        instance: location.host, table: table, sysId: sysId,
        label: (window.g_form && g_form.getValue && g_form.getValue('number')) || sysId,
        recordUrl: location.origin + '/' + table + '.do?sys_id=' + sysId,
        user: (window.g_user && g_user.userName) || '',
        limits: limits
      }
    });
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
