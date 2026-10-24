// Runs a save plan ([{ id, formats }] in SAVE_ORDER) through the storage adapters. Shared by the
// editor's Save button and the library's "Retry failed saves".

import { getAdapter } from '../storage/adapter.js';

const now = () => new Date().toISOString();

/**
 * @param {object} opts
 * @param {{id: string, formats: string[]}[]} opts.plan
 * @param {import('./export/files.js').ExportFactory} opts.factory
 * @param {() => object} opts.ctx adapter context factory ({ settings, capture, snContext })
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<object[]>} SaveResults (ServiceNow results arrive with persisted: true)
 */
export async function runSavePlan({ plan, factory, ctx, onStatus = () => {} }) {
  const links = []; // S3 object URLs, cited by later PDFs, sidecars, issues and work notes
  const results = [];
  try {
    for (const step of plan) {
      const adapter = getAdapter(step.id);
      if (adapter.saveAll) {
        const files = [];
        // PDF/sidecar after the binary files so they can cite links; issue trackers read links too.
        for (const f of step.formats) files.push(...(await factory.get(f, links)));
        onStatus(`Sending to ${adapter.label}…`);
        const rs = await adapter.saveAll(files, { ...ctx(), links: [...links], factory }, (p) => onStatus(`${adapter.label} ${Math.round(p * 100)}%`));
        for (const r of rs) {
          r.at = r.at || now();
          results.push(r);
          if (r.ok && /^https?:\/\//.test(r.link || '')) links.push({ label: `${adapter.label}: ${r.linkLabel || r.name}`, url: r.link });
        }
        continue;
      }
      // PDF last, so it can cite the links of files uploaded just before it.
      const ordered = [...step.formats].sort((a, b) => (a === 'pdf') - (b === 'pdf'));
      for (const f of ordered) {
        for (const file of await factory.get(f, links)) {
          onStatus(`${adapter.label}: ${file.name}`);
          const r = await adapter.save(file, { ...ctx(), links: [...links] }, (p) => onStatus(`${adapter.label}: ${file.name} ${Math.round(p * 100)}%`));
          r.at = now();
          results.push(r);
          if (step.id === 's3' && r.ok && /^https?:\/\//.test(r.location || '')) links.push({ label: `S3: ${file.name}`, url: r.location });
        }
      }
    }
  } catch (err) {
    results.push({ adapter: 'editor', ok: false, name: '', error: err.message, at: now() });
  }
  return results;
}
