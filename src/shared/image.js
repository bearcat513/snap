// Image helpers built on createImageBitmap + OffscreenCanvas, so they work in the service worker,
// the offscreen document and extension pages alike.

export async function cropBlob(blob, rect, type = 'image/png') {
  const bmp = await createImageBitmap(blob);
  const x = clamp(Math.round(rect.x), 0, bmp.width - 1);
  const y = clamp(Math.round(rect.y), 0, bmp.height - 1);
  const w = clamp(Math.round(rect.w), 1, bmp.width - x);
  const h = clamp(Math.round(rect.h), 1, bmp.height - y);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  return canvas.convertToBlob({ type });
}

export async function thumbnailFromSource(source, maxW = 360) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = Math.min(1, maxW / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (source instanceof Blob) bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

export async function imageSize(blob) {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

/**
 * Stitch full-page tiles. Each tile is a full-viewport screenshot; `rect` is the scroller's
 * visible area in CSS px and `top` is that tile's scroll offset.
 */
export async function stitchTiles(tiles, { rect, totalHeight, dpr, maxPx = 16384 }) {
  const width = Math.round(rect.w * dpr);
  const height = Math.min(Math.round(totalHeight * dpr), maxPx);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  for (const tile of tiles) {
    const bmp = await createImageBitmap(tile.blob);
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sh = Math.round(rect.h * dpr);
    ctx.drawImage(bmp, sx, sy, width, sh, 0, Math.round(tile.top * dpr), width, sh);
    bmp.close();
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
