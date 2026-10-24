// Before/after compare (§6): two screenshots from the library, flattened with their annotations and
// redactions, composed side by side or stacked under "Before" / "After" labels. The result is a new
// screenshot capture, so it can be annotated and saved like any other.

import { createScreenshotCapture } from '../shared/captures.js';
import { headlessAnnotator } from './export/files.js';

const LABEL_H = 44;
const GAP = 16;
const PAD = 16;

/** Layout for two images: { width, height, boxes: [{ x, y, w, h, labelY }] } in output px. */
export function compareLayout(a, b, layout) {
  if (layout === 'stacked') {
    const w = Math.min(a.width, b.width); // scale the wider one down, never up
    const ha = Math.round((a.height * w) / a.width);
    const hb = Math.round((b.height * w) / b.width);
    return {
      width: w + 2 * PAD,
      height: PAD + LABEL_H + ha + GAP + LABEL_H + hb + PAD,
      boxes: [
        { x: PAD, y: PAD + LABEL_H, w, h: ha, labelY: PAD },
        { x: PAD, y: PAD + LABEL_H + ha + GAP + LABEL_H, w, h: hb, labelY: PAD + LABEL_H + ha + GAP },
      ],
    };
  }
  const h = Math.min(a.height, b.height);
  const wa = Math.round((a.width * h) / a.height);
  const wb = Math.round((b.width * h) / b.height);
  return {
    width: PAD + wa + GAP + wb + PAD,
    height: PAD + LABEL_H + h + PAD,
    boxes: [
      { x: PAD, y: PAD + LABEL_H, w: wa, h, labelY: PAD },
      { x: PAD + wa + GAP, y: PAD + LABEL_H, w: wb, h, labelY: PAD },
    ],
  };
}

/** Create the comparison capture; the older capture is "Before". Returns the new capture. */
export async function createComparison(first, second, layout = 'side') {
  const [before, after] = [first, second].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  const images = [(await headlessAnnotator(before)).exportCanvas(), (await headlessAnnotator(after)).exportCanvas()];
  const { width, height, boxes } = compareLayout(images[0], images[1], layout);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const labels = [['Before', before], ['After', after]];
  boxes.forEach((box, i) => {
    const [label, cap] = labels[i];
    ctx.fillStyle = i ? '#15803d' : '#b45309';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, box.x, box.labelY + LABEL_H / 2);
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = '#5f6b7a';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText(`${cap.title} · ${new Date(cap.createdAt).toLocaleString()}`.slice(0, 120), box.x + lw + 12, box.labelY + LABEL_H / 2, box.w - lw - 12);
    ctx.drawImage(images[i], box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#dde1e7';
    ctx.strokeRect(box.x - 0.5, box.y - 0.5, box.w + 1, box.h + 1);
  });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const scale = boxes[1].w / images[1].width;
  const capture = await createScreenshotCapture({
    blob,
    title: `Before / after — ${after.title}`.slice(0, 120),
    source: { url: after.source?.url || '', title: after.source?.title || '', dpr: Math.max(1, (after.source?.dpr || 1) * scale), width, height },
    servicenow: after.servicenow ? { ...after.servicenow } : undefined,
  });
  // No /snap job comes along, so it can't be attached to the record directly; the context still names it.
  return capture;
}
