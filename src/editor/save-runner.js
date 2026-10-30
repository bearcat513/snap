// Runs a save plan ([{ id, formats }] in SAVE_ORDER) through the storage adapters. Shared by the
// editor's Save button and the library's "Retry failed saves". A step that throws is recorded as
// failed and the rest of the plan still runs, so each destination can be retried on its own.

import { getAdapter } from '../storage/adapter.js';

const now = () => new Date().toISOString();
const failure = (id, format, err) => ({ adapter: id, ok: false, name: format, error: err.message, at: now() });

/**
 * @param {object} opts
 * @param {{id: string, formats: string[]}[]} opts.plan
 * @param {import('./export/files.js').ExportFactory} opts.factory
 * @param {() => object} opts.ctx adapter context factory ({ settings, capture, snContext })
 * @param {(msg: string) => void} [opts.onStatus]
 * @param {(id: string, step: {state?: 'active'|'done'|'failed', fraction: number, error?: string}) => void} [opts.onStep]
 * @returns {Promise<object[]>} SaveResults (ServiceNow results arrive with persisted: true)
 */
export async function runSavePlan({ plan, factory, ctx, onStatus = () => {}, onStep = () => {} }) {
  const links = []; // S3 object URLs, cited by later PDFs, sidecars, issues and work notes
  const results = [];
  for (const step of plan) {
    const adapter = getAdapter(step.id);
    const first = results.length;
    onStep(step.id, { state: 'active', fraction: 0 });
    if (adapter.saveAll) {
      try {
        const files = [];
        // PDF/sidecar after the binary files so they can cite links; issue trackers read links too.
        for (const f of step.formats) files.push(...(await factory.get(f, links)));
        onStatus(`Sending to ${adapter.label}…`);
        const rs = await adapter.saveAll(files, { ...ctx(), links: [...links], factory }, (p) => {
          onStatus(`${adapter.label} ${Math.round(p * 100)}%`);
          onStep(step.id, { fraction: p });
        });
        for (const r of rs) {
          r.at = r.at || now();
          results.push(r);
          if (r.ok && /^https?:\/\//.test(r.link || '')) links.push({ label: `${adapter.label}: ${r.linkLabel || r.name}`, url: r.link });
        }
      } catch (err) {
        for (const f of step.formats) results.push(failure(step.id, f, err));
      }
    } else {
      // PDF last, so it can cite the links of files uploaded just before it.
      const ordered = [...step.formats].sort((a, b) => (a === 'pdf') - (b === 'pdf'));
      for (const [i, f] of ordered.entries()) {
        try {
          for (const file of await factory.get(f, links)) {
            onStatus(`${adapter.label}: ${file.name}`);
            const r = await adapter.save(file, { ...ctx(), links: [...links] }, (p) => {
              onStatus(`${adapter.label}: ${file.name} ${Math.round(p * 100)}%`);
              onStep(step.id, { fraction: (i + p) / ordered.length });
            });
            r.at = now();
            results.push(r);
            if (step.id === 's3' && r.ok && /^https?:\/\//.test(r.location || '')) links.push({ label: `S3: ${file.name}`, url: r.location });
          }
        } catch (err) {
          results.push(failure(step.id, f, err));
        }
        onStep(step.id, { fraction: (i + 1) / ordered.length });
      }
    }
    const failed = results.slice(first).find((r) => !r.ok);
    onStep(step.id, { state: failed ? 'failed' : 'done', fraction: 1, error: failed?.error });
  }
  return results;
}
