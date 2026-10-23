// Destructive redaction primitives shared by the image annotator and the video renderer.
// Both read pixels from `source` (image, canvas or video frame) and return a new canvas the size of
// the region, which the caller paints over the region. Nothing of the original survives.

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function pixelateRegion(source, r, block) {
  const sw = Math.max(1, Math.ceil(r.w / block));
  const sh = Math.max(1, Math.ceil(r.h / block));
  const small = makeCanvas(sw, sh);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  const out = makeCanvas(r.w, r.h);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, sw, sh, 0, 0, r.w, r.h);
  return out;
}

export function blurRegion(source, r, unit = 1) {
  // Pixelate first so fine detail (text) is destroyed, then blur for a softer look.
  const base = pixelateRegion(source, r, Math.max(3, Math.round(4 * unit)));
  const radius = Math.max(8, Math.round(12 * unit));
  const pad = radius * 2;
  const tmp = makeCanvas(r.w + pad * 2, r.h + pad * 2);
  const tctx = tmp.getContext('2d');
  // Edge-extend so the blur doesn't fade to transparent at the borders.
  tctx.drawImage(base, 0, 0, r.w, r.h, 0, 0, tmp.width, tmp.height);
  tctx.drawImage(base, pad, pad);
  const blurred = makeCanvas(tmp.width, tmp.height);
  const bctx = blurred.getContext('2d');
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(tmp, 0, 0);
  const out = makeCanvas(r.w, r.h);
  out.getContext('2d').drawImage(blurred, pad, pad, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}

/** Clamp a region to integer pixels inside a W×H frame. */
export function clampRegion(r, W, H) {
  const x = Math.max(0, Math.min(W - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(H - 1, Math.round(r.y)));
  return { x, y, w: Math.max(0, Math.min(W - x, Math.round(r.w))), h: Math.max(0, Math.min(H - y, Math.round(r.h))) };
}

export function redactRegion(source, r, mode, unit = 1) {
  return mode === 'blur' ? blurRegion(source, r, unit) : pixelateRegion(source, r, Math.max(6, Math.round(10 * unit)));
}
