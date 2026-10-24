// Step-by-step guides from recordings (§6). Tab recordings remember what was clicked
// (content/click-highlight.js); the video editor turns those clicks into keyframes and steps.

/** Video time (ms) of a wall-clock instant, given the recording start and pauses [[from, to]]. Null while paused. */
export function videoTimeOf(at, startedAt, pauses = []) {
  let paused = 0;
  for (const [from, to] of pauses) {
    const end = to ?? Infinity;
    if (at >= from && at < end) return null;
    if (end <= at) paused += end - from;
  }
  const t = at - startedAt - paused;
  return t >= 0 ? t : null;
}

const quote = (label) => `“${label}”`;

/** Plain-language instruction for a click: { label, role } → "Click “Resolve”". */
export function stepText({ label, role } = {}) {
  const name = label ? quote(label) : '';
  switch (role) {
    case 'link': return name ? `Open ${name}` : 'Open the link';
    case 'checkbox':
    case 'radio':
    case 'switch': return name ? `Select ${name}` : 'Select the option';
    case 'field': return name ? `Click the ${name} field` : 'Click the field';
    case 'tab': return name ? `Open the ${name} tab` : 'Open the tab';
    case 'menuitem':
    case 'option': return name ? `Choose ${name}` : 'Choose the menu item';
    default: return name ? `Click ${name}` : 'Click here';
  }
}

/**
 * Turn recorded clicks ({ t, fx, fy, label, role }, t in video ms) into guide steps inside
 * [start, end]: double clicks and repeats on the same target within mergeMs collapse to one step.
 * Returns [{ timeMs, fx, fy, label, role, text }], at most `max`.
 */
export function guideSteps(clicks, [start, end], { mergeMs = 700, max = 50 } = {}) {
  const steps = [];
  for (const c of [...(clicks || [])].sort((a, b) => a.t - b.t)) {
    if (c.t < start || c.t > end) continue;
    const prev = steps[steps.length - 1];
    if (prev && c.t - prev.timeMs < mergeMs && prev.label === c.label && prev.role === c.role) continue;
    steps.push({ timeMs: c.t, fx: c.fx, fy: c.fy, label: c.label || '', role: c.role || 'element', text: stepText(c) });
    if (steps.length >= max) break;
  }
  return steps;
}

/** Keyframe time for a step: just before the click, so the frame shows what is about to be clicked. */
export const frameTimeFor = (step, start) => Math.max(start, Math.round(step.timeMs - 150));
