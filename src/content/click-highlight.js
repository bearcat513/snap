// Click highlights during tab recording (§6.6): a fading ring at each click point.
(() => {
  if (window.__snapClickHighlight) { window.__snapClickHighlight.start(); return; }

  let host = null;
  let root = null;

  function onDown(e) {
    if (!root) return;
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    root.appendChild(ring);
    setTimeout(() => ring.remove(), 700);
  }

  window.__snapClickHighlight = {
    start() {
      if (host) return;
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .ring{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;
              border:3px solid rgba(255,196,0,.95);background:rgba(255,196,0,.25);animation:snap-ring .7s ease-out forwards}
        @keyframes snap-ring{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}
      </style>`;
      document.documentElement.appendChild(host);
      window.addEventListener('pointerdown', onDown, true);
    },
    stop() {
      window.removeEventListener('pointerdown', onDown, true);
      if (host) host.remove();
      host = null;
      root = null;
    },
  };
  window.__snapClickHighlight.start();
})();
