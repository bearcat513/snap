// Region-select overlay (§6.2). Injected on demand; shows the frozen screenshot and lets the user
// drag a rectangle. Resolves { x, y, w, h, vw, vh } in CSS px, or null on Esc.
(() => {
  if (window.__snapRegionSelect) return;

  window.__snapRegionSelect = (dataUrl) => new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .layer{position:fixed;inset:0;cursor:crosshair;background-size:100vw 100vh;background-repeat:no-repeat;user-select:none}
        .dim{position:fixed;inset:0;background:rgba(0,0,0,.35);pointer-events:none}
        .sel{position:fixed;border:2px solid #fff;outline:1px solid rgba(0,0,0,.6);box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none;display:none}
        .size{position:absolute;right:0;bottom:-24px;font:12px system-ui,sans-serif;background:#1b1f24;color:#fff;padding:2px 6px;border-radius:4px;white-space:nowrap}
        .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);font:13px system-ui,sans-serif;background:#1b1f24;color:#fff;
              padding:6px 12px;border-radius:6px;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.3)}
      </style>
      <div class="layer"></div><div class="dim"></div>
      <div class="sel"><span class="size"></span></div>
      <div class="hint">Drag to select a region · Esc to cancel</div>`;
    const layer = root.querySelector('.layer');
    const dim = root.querySelector('.dim');
    const sel = root.querySelector('.sel');
    const size = root.querySelector('.size');
    layer.style.backgroundImage = `url("${dataUrl}")`;
    document.documentElement.appendChild(host);

    let start = null;
    let rect = null;

    const finish = (value) => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      // Let the page repaint before anyone captures again.
      requestAnimationFrame(() => resolve(value));
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    window.addEventListener('keydown', onKey, true);

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      layer.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      rect = null;
    });
    layer.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.max(0, Math.min(start.x, e.clientX));
      const y = Math.max(0, Math.min(start.y, e.clientY));
      const w = Math.min(innerWidth, Math.max(start.x, e.clientX)) - x;
      const h = Math.min(innerHeight, Math.max(start.y, e.clientY)) - y;
      rect = { x, y, w, h };
      dim.style.display = 'none';
      Object.assign(sel.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    });
    layer.addEventListener('pointerup', () => {
      start = null;
      if (rect && rect.w >= 4 && rect.h >= 4) finish({ ...rect, vw: innerWidth, vh: innerHeight });
      else { sel.style.display = 'none'; dim.style.display = ''; }
    });
  });
})();
