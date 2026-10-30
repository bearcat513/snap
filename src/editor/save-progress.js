// The panel under the editor's top bar while saving: an overall bar and one row per destination,
// with Retry on the ones that failed.

import { el } from './ui.js';

const ICONS = { pending: '○', active: '…', done: '✓', failed: '✕' };

export class SaveProgress {
  /** @param {{ root: HTMLElement, onRetry: (step: {id: string, formats: string[]}) => void }} opts */
  constructor({ root, onRetry }) {
    this.root = root;
    this.onRetry = onRetry;
    this.bar = el('progress', { max: '1', value: '0', 'aria-label': 'Save progress' });
    this.note = el('span', { class: 'small muted' });
    this.close = el('button', { class: 'ghost small', hidden: true, onclick: () => { this.root.hidden = true; } }, 'Dismiss');
    this.list = el('ul', { class: 'save-steps' });
    root.append(el('div', { class: 'save-progress-head' }, this.bar, this.note, this.close), this.list);
  }

  start(plan, labelOf) {
    clearTimeout(this.hideTimer);
    this.steps = plan.map((s) => ({ ...s, label: labelOf(s.id), state: 'pending', fraction: 0, error: '' }));
    this.renderStart = 0;
    this.close.hidden = true;
    this.note.textContent = '';
    this.root.hidden = false;
    this.render();
  }

  step(id, { state, fraction, error }) {
    const s = this.steps?.find((x) => x.id === id);
    if (!s) return;
    if (state) s.state = state;
    s.fraction = fraction;
    if (error) s.error = error;
    this.render();
  }

  /** A slow export step (video render, GIF): its message, and how far along it is if known. */
  detail(message, fraction) {
    const active = this.steps?.find((x) => x.state === 'active');
    if (!active) return;
    if (typeof fraction === 'number') {
      if (!fraction || !this.renderStart) this.renderStart = Date.now();
      active.fraction = fraction;
      const left = fraction > 0.03 && fraction < 1 ? ((Date.now() - this.renderStart) * (1 - fraction)) / fraction / 1000 : 0;
      this.note.textContent = left >= 1 ? `${message} · about ${Math.ceil(left)} s left` : message;
    } else this.note.textContent = message;
    this.update();
  }

  /** Saving ended: a clean run hides itself; failures stay on screen until retried or dismissed. */
  finish() {
    const failed = this.steps.filter((s) => s.state === 'failed').length;
    this.note.textContent = failed ? `${failed} of ${this.steps.length} destination${this.steps.length === 1 ? '' : 's'} failed` : 'All saved';
    this.close.hidden = !failed;
    if (!failed) this.hideTimer = setTimeout(() => { this.root.hidden = true; }, 2500);
  }

  update() {
    const total = this.steps.reduce((sum, s) => sum + (s.state === 'done' || s.state === 'failed' ? 1 : s.fraction), 0);
    this.bar.value = total / this.steps.length;
  }

  render() {
    this.update();
    this.list.replaceChildren(...this.steps.map((s) => el('li', { class: s.state },
      el('span', { class: 'st', 'aria-hidden': 'true', text: ICONS[s.state] }),
      el('strong', { text: s.label }),
      el('span', { class: 'muted small', text: s.error || (s.state === 'pending' ? 'Waiting' : s.state === 'active' ? 'Saving…' : s.state === 'done' ? 'Done' : 'Failed') }),
      s.state === 'failed' ? el('button', { class: 'small', onclick: () => this.onRetry({ id: s.id, formats: s.formats }) }, 'Retry') : null)));
  }
}
