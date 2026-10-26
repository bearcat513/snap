// Context fields beyond description/notes (§7.4): steps to reproduce, tags, custom fields from
// settings, and templates (which can bring their own fields and placeholder text).

import { applyTemplate, activeTemplate, contextFields } from '../shared/settings.js';
import { el } from './ui.js';

export class ContextForm extends EventTarget {
  /**
   * @param {object} opts
   * @param {object} opts.settings
   * @param {string[]} opts.knownTags tag suggestions (from the library)
   */
  constructor({ settings, knownTags = [] }) {
    super();
    this.settings = settings;
    this.steps = [];
    this.tags = [];
    this.custom = {};
    this.template = null; // id of the active template
    this.$ = (id) => document.getElementById(id);
    // The HTML placeholders are the fallback when the active template doesn't set its own.
    this.defaultPlaceholders = { description: this.$('ctx-description').placeholder, notes: this.$('ctx-notes').placeholder };
    this.$('tag-suggestions').replaceChildren(...[...new Set(knownTags)].sort().map((t) => el('option', { value: t })));
    this.bindTags();
    this.$('btn-add-step').addEventListener('click', () => { this.steps.push(''); this.renderSteps(this.steps.length - 1); this.changed(); });
    this.renderTemplateMenu();
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }

  /** Fill from capture.context. */
  set(context) {
    this.$('ctx-recordUrl').value = context.recordUrl || '';
    this.$('ctx-description').value = context.description || '';
    this.$('ctx-notes').value = context.notes || '';
    this.steps = [...(context.steps || [])];
    this.tags = [...(context.tags || [])];
    this.custom = { ...(context.custom || {}) };
    this.template = context.template || null;
    this.renderSteps();
    this.renderTags();
    this.renderPlaceholders();
    this.renderCustomFields();
    this.renderTemplateMenu();
  }

  /** Global custom fields plus the active template's own. */
  fields() {
    return contextFields(this.settings, { template: this.template });
  }

  /** Replace the steps list (e.g. from a generated guide). */
  setSteps(steps) {
    this.steps = [...steps];
    this.renderSteps();
    this.changed();
  }

  get() {
    return {
      recordUrl: this.$('ctx-recordUrl').value.trim(),
      description: this.$('ctx-description').value.trim(),
      notes: this.$('ctx-notes').value,
      steps: this.steps.map((s) => s.trim()).filter(Boolean),
      tags: [...this.tags],
      custom: Object.fromEntries(Object.entries(this.custom).filter(([, v]) => v !== '' && v !== undefined)),
      template: this.template || undefined,
    };
  }

  /** Required custom fields that are empty → [{ id, label }]. */
  missingRequired() {
    return this.fields().filter((f) => f.required && !String(this.custom[f.id] || '').trim());
  }

  markMissing(fields) {
    for (const f of this.fields()) {
      this.$(`cf-${f.id}`)?.classList.toggle('invalid', fields.some((m) => m.id === f.id));
    }
    if (fields[0]) this.$(`cf-${fields[0].id}`)?.focus();
  }

  // ---- steps ----

  renderSteps(focusIndex) {
    const list = this.$('steps');
    list.replaceChildren(...this.steps.map((step, i) => {
      const input = el('input', { type: 'text', value: step, placeholder: `Step ${i + 1}`, 'aria-label': `Step ${i + 1}` });
      input.addEventListener('input', () => { this.steps[i] = input.value; this.changed(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.steps.splice(i + 1, 0, '');
          this.renderSteps(i + 1);
          this.changed();
        } else if (e.key === 'Backspace' && !input.value && this.steps.length > 0) {
          e.preventDefault();
          this.steps.splice(i, 1);
          this.renderSteps(Math.max(0, i - 1));
          this.changed();
        }
      });
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= this.steps.length) return;
        [this.steps[i], this.steps[j]] = [this.steps[j], this.steps[i]];
        this.renderSteps(j);
        this.changed();
      };
      return el('li', {},
        input,
        el('button', { class: 'ghost icon', title: 'Move up', 'aria-label': 'Move step up', onclick: () => move(-1), disabled: i === 0 }, '↑'),
        el('button', { class: 'ghost icon', title: 'Move down', 'aria-label': 'Move step down', onclick: () => move(1), disabled: i === this.steps.length - 1 }, '↓'),
        el('button', { class: 'ghost icon', title: 'Remove', 'aria-label': 'Remove step', onclick: () => { this.steps.splice(i, 1); this.renderSteps(); this.changed(); } }, '✕'));
    }));
    if (focusIndex !== undefined) list.querySelectorAll('input')[focusIndex]?.focus();
  }

  // ---- tags ----

  bindTags() {
    const input = this.$('tag-input');
    const commit = () => {
      const parts = input.value.split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
      let added = false;
      for (const t of parts) if (!this.tags.includes(t)) { this.tags.push(t); added = true; }
      input.value = '';
      if (added) { this.renderTags(); this.changed(); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !input.value && this.tags.length) { this.tags.pop(); this.renderTags(); this.changed(); }
    });
    input.addEventListener('change', commit); // picking from the datalist
    input.addEventListener('blur', commit);
  }

  renderTags() {
    this.$('tags').replaceChildren(...this.tags.map((t, i) => el('span', { class: 'chip tag' }, t,
      el('button', { class: 'ghost icon', 'aria-label': `Remove tag ${t}`, onclick: () => { this.tags.splice(i, 1); this.renderTags(); this.changed(); } }, '✕'))));
  }

  // ---- custom fields ----

  renderCustomFields() {
    const root = this.$('custom-fields');
    root.replaceChildren(...this.fields().map((f) => {
      let input;
      if (f.type === 'textarea') input = el('textarea', { id: `cf-${f.id}`, rows: 3, placeholder: f.placeholder || undefined });
      else if (f.type === 'select') input = el('select', { id: `cf-${f.id}` }, el('option', { value: '', text: f.placeholder || '—' }), ...f.options.map((o) => el('option', { value: o, text: o })));
      else input = el('input', { id: `cf-${f.id}`, type: 'text', placeholder: f.placeholder || undefined });
      input.value = this.custom[f.id] || '';
      input.addEventListener('input', () => { this.custom[f.id] = input.value; input.classList.remove('invalid'); this.changed(); });
      return el('label', { class: 'field' }, el('span', {}, f.label, f.required ? el('em', { class: 'muted small', text: ' (required)' }) : null), input);
    }));
  }

  // ---- templates ----

  renderPlaceholders() {
    const p = activeTemplate(this.settings.templates, { template: this.template })?.placeholders || {};
    this.$('ctx-description').placeholder = p.description || this.defaultPlaceholders.description;
    this.$('ctx-notes').placeholder = p.notes || this.defaultPlaceholders.notes;
  }

  renderTemplateMenu() {
    const btn = this.$('btn-template');
    const menu = this.$('template-menu');
    const active = activeTemplate(this.settings.templates, { template: this.template });
    btn.hidden = !this.settings.templates.length;
    btn.textContent = active ? `${active.name} ▾` : 'Template ▾';
    menu.replaceChildren(...this.settings.templates.map((t) => el('button', {
      role: 'menuitemradio', 'aria-checked': String(t === active),
      onclick: () => { menu.hidden = true; this.apply(t); },
    }, t === active ? `✓ ${t.name}` : t.name)),
    active ? el('button', { role: 'menuitem', onclick: () => { menu.hidden = true; this.clearTemplate(); } }, 'No template') : null);
    if (this.menuBound) return;
    this.menuBound = true;
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', () => { menu.hidden = true; });
  }

  apply(template) {
    this.set(applyTemplate(this.get(), template));
    this.changed();
  }

  /** Drop the active template; values already typed into its fields are kept. */
  clearTemplate() {
    this.set({ ...this.get(), template: undefined });
    this.changed();
  }
}
